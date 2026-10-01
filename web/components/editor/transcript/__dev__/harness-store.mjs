// A store for the T2.7 e2e harness: the Appendix A.2 store API with the Appendix B commands the
// transcript, text and cold-open panels dispatch, implemented independently of the panels (and
// of T2.5's real store) so the specs check the UI against the plan's command semantics.
// Dev and test only. `__dev__/fakes.mjs` (T1.Z) stays the shared fake; this file only adds what
// that fake store does not model (it records RemoveWords & co. without changing the document).
//
// Every dispatch is appended to `log` as {type, args, mergeKey, ok, code}. The plan DTO is
// recomputed 150 ms after a change ("text" is pending meanwhile), like the debounced preview.
import { CAPTION_SWATCHES } from "../../../../lib/editor/content-colours.mjs";
import { CommandRejected, fakePlan } from "../../__dev__/fakes.mjs";

const clone = (value) => JSON.parse(JSON.stringify(value));
const SWATCHES = CAPTION_SWATCHES.map((swatch) => swatch.value);
const PACKS = ["classic", "karaoke", "bold", "box"];
const MERGE_WINDOW_MS = 500;

function reject(code) {
  throw new CommandRejected(code);
}

function sfFloor(ms, [num, den]) {
  return Math.floor((ms * num) / (1000 * den));
}

function sfCeil(ms, [num, den]) {
  return Math.ceil((ms * num) / (1000 * den));
}

// Pieces of a document (plan §3.4): segment minus its removals, slivers < 2 frames dropped.
export function harnessPieces(doc) {
  const pieces = [];
  let outF0 = 0;
  for (const segment of doc.main.segments) {
    const cuts = doc.main.removals.filter((removal) => removal.seg === segment.id)
      .map((removal) => [Math.max(removal.in_sf, segment.in_sf), Math.min(removal.out_sf, segment.out_sf)])
      .filter(([a, b]) => a < b).sort((x, y) => x[0] - y[0]);
    let cursor = segment.in_sf;
    const kept = [];
    for (const [a, b] of cuts) {
      if (a > cursor) kept.push([cursor, a]);
      cursor = Math.max(cursor, b);
    }
    if (cursor < segment.out_sf) kept.push([cursor, segment.out_sf]);
    for (const [a, b] of kept.filter(([x, y]) => y - x >= 2)) {
      pieces.push({ i: pieces.length, seg: segment.id, role: segment.role, inSf: a, outSf: b, outF0, frames: b - a });
      outF0 += b - a;
    }
  }
  return pieces;
}

function midSf(word, [num, den]) {
  return Math.floor(((word.s + word.e) * num) / (2000 * den));
}

function textIssue(text, max) {
  if (typeof text !== "string") return "range_invalid";
  const points = [...text];
  if (points.length < 1 || points.length > max) return "range_invalid";
  if (text !== text.trim()) return "range_invalid";
  if (text !== text.normalize("NFC")) return "not_nfc";
  if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) return "control_char";
  return null;
}

export function createHarnessStore({ words, doc, readOnly = false, planDelayMs = 150, now = () => Date.now() }) {
  const fps = doc.output.fps;
  const listeners = new Set();
  const log = [];
  const past = [];
  const future = [];
  const index = new Map(words.words.map((word, i) => [word.id, i]));
  const before = new Map(words.bounds.filter((entry) => entry.before).map((entry) => [entry.before, entry.sf]));
  const after = new Map(words.bounds.filter((entry) => entry.after).map((entry) => [entry.after, entry.sf]));
  const seed = clone(doc);
  let removalSeq = 0;
  let planTimer = null;
  let state = {
    status: readOnly ? "readOnly" : "ready", jobId: doc.base.job_id, clipId: doc.clip_id, doc: clone(doc), seed,
    words, etag: "0".repeat(64), save: "saved", savedAtMs: now(), canUndo: false, canRedo: false,
    plan: null, pending: [], warnings: [], selection: null,
  };

  function planOf(current) {
    const plan = fakePlan(current);
    const pieces = harnessPieces(current);
    plan.pieces = pieces;
    plan.totalFrames = pieces.reduce((sum, piece) => sum + piece.frames, 0);
    const hookItem = current.tracks.find((track) => track.kind === "hook")?.items[0] ?? null;
    // Stand-in for the server's legacy-bar layout: over 70 characters does not fit 3 lines.
    plan.hook = hookItem ? { f0: 0, f1: Math.min(hookItem.dur_f, plan.totalFrames), lines: [hookItem.payload.text],
      overflow: [...hookItem.payload.text].length > 70 } : null;
    plan.warnings = plan.hook?.overflow ? [{ code: "hook_overflow", ref: hookItem.id, f: 0 }] : [];
    // Stand-in for the glyph check: pictographs are missing from the hook font.
    for (const char of new Set(hookItem ? [...hookItem.payload.text].filter((c) => /\p{Extended_Pictographic}/u.test(c)) : [])) {
      const code = `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
      plan.warnings.push({ code: `glyph_unsupported:${code}`, ref: hookItem.id, f: 0 });
    }
    return plan;
  }

  const emit = () => { for (const listener of [...listeners]) listener(state); };
  const set = (patch) => {
    state = { ...state, ...patch, canUndo: past.length > 0, canRedo: future.length > 0 };
    emit();
  };
  const schedulePlan = () => {
    clearTimeout(planTimer);
    planTimer = setTimeout(() => set({ plan: planOf(state.doc), pending: [] }), planDelayMs);
  };
  state.plan = planOf(state.doc);

  const body = (d) => d.main.segments.find((segment) => segment.role === "body");
  const bodyFrames = (d) => harnessPieces(d).filter((piece) => piece.role === "body").reduce((sum, piece) => sum + piece.frames, 0);
  const wordAt = (id) => {
    if (!index.has(id)) reject("unknown_word");
    return words.words[index.get(id)];
  };
  const checkBody = (d) => {
    const frames = bodyFrames(d);
    if (frames < sfCeil(3000, fps) || frames > sfFloor(300000, fps)) reject("duration_out_of_bounds");
    const [a, b] = d.base.window_ms;
    const segment = body(d);
    if (segment.in_sf < sfFloor(a, fps) || segment.out_sf > sfCeil(b, fps)) reject("outside_window");
  };
  const checkColdOpen = (d) => {
    const co = d.main.segments.find((segment) => segment.role === "cold_open");
    if (!co) return;
    const b = body(d);
    const frames = harnessPieces(d).filter((piece) => piece.seg === co.id).reduce((sum, piece) => sum + piece.frames, 0);
    if (frames < sfCeil(500, fps) || frames > sfFloor(8000, fps) || co.in_sf === b.in_sf) reject("cold_open_invalid");
    const length = co.out_sf - co.in_sf;
    const [num, den] = fps;
    const end = (b.in_sf + length) * den + 2 * num;
    const overlap = Math.max(0, Math.min(co.out_sf * den, end) - Math.max(co.in_sf, b.in_sf) * den);
    if (5 * overlap > 4 * length * den) reject("cold_open_invalid");
  };
  // The segments whose kept pieces show a word (a cold-open word is usually in the body too).
  const segmentsOfWord = (pieces, word) => {
    const mid = midSf(word, fps);
    return new Set(pieces.filter((piece) => piece.inSf <= mid && mid < piece.outSf).map((piece) => piece.seg));
  };
  const hookItem = (d) => d.tracks.find((track) => track.kind === "hook")?.items[0] ?? null;
  const wordEdit = (d, id) => {
    d.captions.word_edits[id] ??= {};
    return d.captions.word_edits[id];
  };
  const tidyEdit = (d, id) => {
    if (d.captions.word_edits[id] && Object.keys(d.captions.word_edits[id]).length === 0) delete d.captions.word_edits[id];
  };
  const setColdOpen = (d, inSf, outSf) => {
    d.main.removals = d.main.removals.filter((removal) => removal.seg !== "seg_co");
    d.main.segments = d.main.segments.filter((segment) => segment.role !== "cold_open");
    d.main.segments.unshift({ id: "seg_co", role: "cold_open", in_sf: inSf, out_sf: outSf });
    d.main.joins = [{ after: "seg_co", style: "cut", audio_fade_ms: 30 }];
    checkColdOpen(d);
  };
  const coldOpenWords = (d) => {
    const co = d.main.segments.find((segment) => segment.role === "cold_open");
    const inside = words.words.map((word, i) => [word, i]).filter(([word]) => {
      const mid = midSf(word, fps);
      return co.in_sf <= mid && mid < co.out_sf;
    });
    return [inside[0][1], inside.at(-1)[1]];
  };

  const reducers = {
    RemoveWords(d, { wordIds, reason = "user", origin = "user" }) {
      if (!Array.isArray(wordIds) || wordIds.length === 0) reject("range_invalid");
      const list = wordIds.map(wordAt);
      const positions = wordIds.map((id) => index.get(id));
      if (positions.some((p, k) => k > 0 && p !== positions[k - 1] + 1)) reject("range_invalid");
      const pieces = harnessPieces(d);
      const shown = list.map((word) => segmentsOfWord(pieces, word));
      const seg = ["seg_b1", "seg_co"].find((id) => shown.every((segs) => segs.has(id)));
      if (!seg) reject("not_visible");
      let inSf = before.get(wordIds[0]);
      let outSf = after.get(wordIds.at(-1));
      let ids = [...wordIds];
      const keep = [];
      for (const removal of d.main.removals) {
        if (removal.seg === seg && removal.in_sf <= outSf && inSf <= removal.out_sf) {
          inSf = Math.min(inSf, removal.in_sf);
          outSf = Math.max(outSf, removal.out_sf);
          ids = [...new Set([...removal.words, ...ids])].sort((x, y) => index.get(x) - index.get(y));
        } else keep.push(removal);
      }
      removalSeq += 1;
      keep.push({ id: `rm_h${removalSeq}`, seg, in_sf: inSf, out_sf: outSf, words: ids, reason, origin });
      d.main.removals = keep.sort((x, y) => (x.seg === y.seg ? x.in_sf - y.in_sf : x.seg < y.seg ? -1 : 1));
      checkBody(d);
    },
    RestoreRemoval(d, { removalId }) {
      const count = d.main.removals.length;
      d.main.removals = d.main.removals.filter((removal) => removal.id !== removalId);
      if (d.main.removals.length === count) reject("not_found");
    },
    EditWordText(d, { wordId, text }) {
      const word = wordAt(wordId);
      const issue = textIssue(text, 40);
      if (issue) reject(issue);
      const edit = wordEdit(d, wordId);
      if (text === word.t) delete edit.text;
      else edit.text = text;
      tidyEdit(d, wordId);
    },
    SetWordHidden(d, { wordId, on }) {
      wordAt(wordId);
      const edit = wordEdit(d, wordId);
      if (on) edit.hidden = true;
      else delete edit.hidden;
      tidyEdit(d, wordId);
    },
    SetWordEmphasis(d, { wordId, on }) {
      wordAt(wordId);
      const edit = wordEdit(d, wordId);
      if (on) edit.emphasis = true;
      else delete edit.emphasis;
      tidyEdit(d, wordId);
    },
    TrimStart(d, { gapWord }) {
      wordAt(gapWord);
      const segment = body(d);
      segment.in_sf = before.get(gapWord);
      if (segment.in_sf >= segment.out_sf) reject("range_invalid");
      d.main.removals = d.main.removals.filter((removal) => removal.seg !== segment.id || removal.out_sf > segment.in_sf)
        .map((removal) => (removal.seg === segment.id ? { ...removal, in_sf: Math.max(removal.in_sf, segment.in_sf) } : removal));
      checkBody(d);
      checkColdOpen(d);
    },
    TrimEnd(d, { gapWord }) {
      wordAt(gapWord);
      const segment = body(d);
      segment.out_sf = after.get(gapWord);
      if (segment.in_sf >= segment.out_sf) reject("range_invalid");
      d.main.removals = d.main.removals.filter((removal) => removal.seg !== segment.id || removal.in_sf < segment.out_sf)
        .map((removal) => (removal.seg === segment.id ? { ...removal, out_sf: Math.min(removal.out_sf, segment.out_sf) } : removal));
      checkBody(d);
    },
    SetColdOpen(d, args) {
      if (args === null) {
        d.main.segments = d.main.segments.filter((segment) => segment.role !== "cold_open");
        d.main.removals = d.main.removals.filter((removal) => removal.seg !== "seg_co");
        d.main.joins = [];
        return;
      }
      const { firstWord, lastWord } = args;
      wordAt(firstWord);
      wordAt(lastWord);
      if (index.get(lastWord) < index.get(firstWord)) reject("range_invalid");
      setColdOpen(d, before.get(firstWord), after.get(lastWord));
    },
    NudgeColdOpen(d, { edge, words: delta }) {
      if (!d.main.segments.some((segment) => segment.role === "cold_open")) reject("not_found");
      if (![1, -1].includes(delta) || !["in", "out"].includes(edge)) reject("range_invalid");
      let [first, last] = coldOpenWords(d);
      if (edge === "in") first += delta;
      else last += delta;
      if (first < 0 || last >= words.words.length || last < first) reject("cold_open_invalid");
      setColdOpen(d, before.get(words.words[first].id), after.get(words.words[last].id));
    },
    SetCaptionsEnabled(d, { on }) { d.captions.enabled = Boolean(on); },
    SetCaptionPack(d, { id }) {
      if (!PACKS.includes(id)) reject("pack_unknown");
      d.captions.pack = { id, v: 1 };
    },
    SetCaptionOverride(d, { key, value }) {
      const ok = {
        y_e5: () => Number.isInteger(value) && value >= 20000 && value <= 92000,
        size_pm: () => Number.isInteger(value) && value >= 700 && value <= 1400,
        case: () => value === "asis" || value === "upper",
        highlight: () => SWATCHES.includes(value),
        emphasis: () => SWATCHES.includes(value),
      }[key];
      if (!ok || !ok()) reject("range_invalid");
      d.captions.overrides[key] = value;
    },
    SetHookEnabled(d, { on, text }) {
      const existing = hookItem(d);
      if (!on) {
        d.tracks = d.tracks.filter((track) => track.kind !== "hook");
        return;
      }
      if (existing) return;
      const issue = textIssue(text, 90);
      if (issue) reject(issue);
      d.tracks.unshift({ id: "tr_hook", kind: "hook", items: [{
        id: "it_hook", type: "hook", start: { at: "out", f: 0 }, dur_f: Math.round((4 * fps[0]) / fps[1]),
        transform: { x_e5: 50000, y_e5: 13000 }, payload: { text, design: { id: "legacy-bar", v: 1 } }, origin: "user",
      }] });
    },
    SetHookText(d, { text, origin = "user" }) {
      const item = hookItem(d);
      if (!item) reject("not_found");
      const issue = textIssue(text, 90);
      if (issue) reject(issue);
      item.payload.text = text;
      item.origin = origin;
    },
    SetHookDuration(d, { dur_f: frames }) {
      const item = hookItem(d);
      if (!item) reject("not_found");
      if (!Number.isInteger(frames) || frames < 15 || frames > sfFloor(30000, fps)) reject("range_invalid");
      item.dur_f = frames;
    },
    SetHookY(d, { y_e5: y }) {
      const item = hookItem(d);
      if (!item) reject("not_found");
      if (!Number.isInteger(y) || y < 6000 || y > 40000) reject("range_invalid");
      item.transform.y_e5 = y;
    },
  };

  function dispatch(type, args = {}, { mergeKey = null } = {}) {
    const entry = { type, args: clone(args ?? null), mergeKey, ok: false, code: null };
    log.push(entry);
    try {
      if (state.status === "readOnly") reject("read_only");
      if (!reducers[type]) reject("unknown_command");
      const next = clone(state.doc);
      reducers[type](next, args);
      next.audit.last_command = type;
      const at = now();
      const last = past.at(-1);
      if (mergeKey && last && last.mergeKey === mergeKey && at - last.at <= MERGE_WINDOW_MS) {
        last.at = at;
      } else {
        past.push({ type, mergeKey, at, before: state.doc });
        if (past.length > 200) past.shift();
      }
      future.length = 0;
      entry.ok = true;
      set({ doc: next, save: "dirty", pending: ["text"] });
      schedulePlan();
      return next;
    } catch (error) {
      entry.code = error.code ?? "error";
      throw error;
    }
  }

  return {
    log,
    history: () => past.map(({ type, mergeKey }) => ({ type, mergeKey })),
    getState: () => state,
    dispatch,
    undo() {
      const entry = past.pop();
      if (!entry) return;
      future.push({ ...entry, after: state.doc });
      set({ doc: entry.before, save: "dirty", pending: ["text"] });
      schedulePlan();
    },
    redo() {
      const entry = future.pop();
      if (!entry) return;
      past.push({ ...entry, before: state.doc });
      set({ doc: entry.after, save: "dirty", pending: ["text"] });
      schedulePlan();
    },
    async flush() { set({ save: "saved", savedAtMs: now() }); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    destroy() { clearTimeout(planTimer); listeners.clear(); },
  };
}
