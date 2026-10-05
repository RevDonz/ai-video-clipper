// Teks caption: the caption lines of Mode Cepat as rows of word ids (docs/plans/
// 2026-10-02-editor-mode-cepat.md §2). Rows follow the plan's cues, so the grouping is always the
// engine's; the document's hidden words leave a row at once, before the next plan arrives.
// A line edit becomes word edits (EditWordText, SetWordHidden): word ids and times come only from
// the words artifact, so timing never moves. Pure: no DOM, no store.
import { COMMAND_MESSAGES, CommandRejected, applyCommand } from "./commands.mjs";
import { LIMITS, normalizeText } from "./doc-model.mjs";

/** §2.4: the most tokens one row's draft may hold. */
export const LINE_LIMITS = Object.freeze({ tokens: 40, wordText: LIMITS.wordText });

/** §2.4: the refusals of a line edit itself (the others are command codes, with their messages). */
export const LINE_MESSAGES = Object.freeze({
  too_many_tokens: "Terlalu banyak kata dalam satu baris.",
  text_too_long: "Teks baru di satu tempat terlalu panjang (maks. 40 huruf). Persingkat tambahannya.",
});

const keptCache = new WeakMap();

function editsOf(doc) {
  return doc?.captions?.word_edits ?? {};
}

/** The plan piece whose output range `[outF0, outF0 + frames)` holds frame `f`. */
function pieceAt(pieces, f) {
  let before = null;
  for (const piece of pieces) {
    if (piece.outF0 <= f && f < piece.outF0 + piece.frames) return piece;
    if (piece.outF0 <= f) before = piece;
  }
  return before ?? pieces[0] ?? null;
}

/** Word ids the cuts keep in segment `seg`, in word order (from the transcript model). */
function keptIds(model, seg) {
  if (!keptCache.has(model)) keptCache.set(model, new Map());
  const bySeg = keptCache.get(model);
  if (!bySeg.has(seg)) {
    let ids = [];
    if (seg !== null && seg === model.coldOpen?.id) ids = model.states.filter((state) => state.cold).map((state) => state.id);
    else if (seg !== null && seg === model.body?.id) {
      ids = model.states.filter((state) => state.zone === "body" && state.removal === null).map((state) => state.id);
    }
    bySeg.set(seg, ids);
  }
  return bySeg.get(seg);
}

// The caption-hidden words between the row's visible words and next to them, up to the
// neighbouring visible word on each side, among the words the segment keeps.
function hiddenNeighbours(model, seg, visible, isHidden) {
  if (!model || !Array.isArray(model.states)) return [];
  const kept = keptIds(model, seg);
  const position = new Map(kept.map((id, index) => [id, index]));
  const found = visible.map((id) => position.get(id)).filter((index) => index !== undefined);
  if (!found.length) return [];
  const lo = Math.min(...found);
  const hi = Math.max(...found);
  let first = lo;
  while (first > 0 && isHidden(kept[first - 1])) first -= 1;
  let last = hi;
  while (last < kept.length - 1 && isHidden(kept[last + 1])) last += 1;
  return kept.slice(first, last + 1).filter(isHidden);
}

/**
 * One row per `plan.cues` entry, in order (§2.1):
 * `{ key, seg, cold, f0, f1, wordIds, hiddenIds, text, edited }`.
 * `words` is the words artifact (`state.words`); `model` is `buildTranscriptModel(words, doc)`.
 * Without `model`, `hiddenIds` is empty: only the model knows which hidden words the cuts keep.
 */
export function captionRows({ plan, doc, words, model = null } = {}) {
  if (!plan || !Array.isArray(plan.cues) || !doc || !Array.isArray(words?.words)) return [];
  const asr = new Map(words.words.map((word) => [word.id, word.t]));
  const edits = editsOf(doc);
  const isHidden = (id) => edits[id]?.hidden === true;
  const textOf = (id) => (typeof edits[id]?.text === "string" ? edits[id].text : asr.get(id));
  const pieces = Array.isArray(plan.pieces) ? plan.pieces : [];
  const rows = [];
  for (const cue of plan.cues) {
    const ids = Array.isArray(cue.words) ? cue.words : [];
    const visible = ids.filter((id) => asr.has(id) && !isHidden(id));
    if (!visible.length) continue;
    const piece = pieceAt(pieces, cue.f0);
    const seg = piece?.seg ?? null;
    rows.push({
      key: `${seg}:${ids[0]}`,
      seg,
      cold: piece?.role === "cold_open",
      f0: cue.f0,
      f1: cue.f1,
      wordIds: visible,
      hiddenIds: hiddenNeighbours(model, seg, visible, isHidden),
      text: visible.map(textOf).join(" "),
      edited: visible.some((id) => textOf(id) !== asr.get(id)),
    });
  }
  return rows;
}

/** The Teks caption card's summary (§1.3): "12 baris", "12 baris · 2 diubah", "Caption mati" or "Menyiapkan…". */
export function linesSummary({ plan, doc, words } = {}) {
  if (doc?.captions?.enabled === false) return "Caption mati";
  if (!doc || !plan || !Array.isArray(words?.words)) return "Menyiapkan…";
  const rows = captionRows({ plan, doc, words });
  const edited = rows.filter((row) => row.edited).length;
  return edited ? `${rows.length} baris · ${edited} diubah` : `${rows.length} baris`;
}

const positionCache = new WeakMap();

function positionsOf(words) {
  if (!positionCache.has(words)) positionCache.set(words, new Map(words.words.map((word, index) => [word.id, index])));
  return positionCache.get(words);
}

const refuse = (code, message) => ({ ok: false, code, message });

/** §2.3 step 1: a draft's tokens (NFC, trimmed, split on any whitespace). */
export function draftTokens(draft) {
  return (typeof draft === "string" ? draft : "").normalize("NFC").trim().split(/\s+/u).filter(Boolean);
}

// §2.3 step 3: under upper case the viewer sees and retypes capitals, so case does not count.
function sameRule(upper) {
  return upper ? (a, b) => a === b || a.toLocaleUpperCase("id") === b.toLocaleUpperCase("id") : (a, b) => a === b;
}

// §2.3 step 4: a longest common subsequence of the row's words and the draft's tokens. Among the
// longest, the one that matches the fewest hidden words, then the earliest pairing (the earliest
// old word, at its earliest token), so the result is deterministic. Returns [oldIndex, tokenIndex].
function anchorsOf(old, tokens, same) {
  const width = tokens.length + 1;
  const size = (old.length + 1) * width;
  const matched = new Int32Array(size);
  const hidden = new Int32Array(size);
  const at = (i, j) => i * width + j;
  const pairs = (i, j) => same(old[i].text, tokens[j]);
  const cost = (i) => (old[i].hidden ? 1 : 0);
  for (let i = old.length - 1; i >= 0; i -= 1) {
    for (let j = tokens.length - 1; j >= 0; j -= 1) {
      let length = matched[at(i + 1, j)];
      let hid = hidden[at(i + 1, j)];
      const skipToken = [matched[at(i, j + 1)], hidden[at(i, j + 1)]];
      if (skipToken[0] > length || (skipToken[0] === length && skipToken[1] < hid)) [length, hid] = skipToken;
      if (pairs(i, j)) {
        const take = [matched[at(i + 1, j + 1)] + 1, hidden[at(i + 1, j + 1)] + cost(i)];
        if (take[0] > length || (take[0] === length && take[1] < hid)) [length, hid] = take;
      }
      matched[at(i, j)] = length;
      hidden[at(i, j)] = hid;
    }
  }
  const anchors = [];
  let i = 0;
  let j = 0;
  while (i < old.length && j < tokens.length) {
    const here = at(i, j);
    if (pairs(i, j) && matched[at(i + 1, j + 1)] + 1 === matched[here] && hidden[at(i + 1, j + 1)] + cost(i) === hidden[here]) {
      anchors.push([i, j]);
      i += 1;
      j += 1;
    } else if (matched[at(i, j + 1)] === matched[here] && hidden[at(i, j + 1)] === hidden[here]) j += 1;
    else i += 1;
  }
  return anchors;
}

/**
 * §2.3: a row's draft as word edits → `{ ok: true, commands: [{ type, args }] }` or
 * `{ ok: false, code, message }` (§2.4). Hidden neighbours a retype matches are unhidden; changed
 * words take their token; extra tokens ride on a host word (the word before, the anchor before, or
 * at the row's start the first anchor after); words with no token left are hidden. Commands come in
 * word order. A draft equal to the row's text commits nothing.
 */
export function lineEdit({ row, draft, doc, words, upper = false } = {}) {
  const raw = typeof draft === "string" ? draft : "";
  if (normalizeText(raw, Number.MAX_SAFE_INTEGER).code === "text_invalid") return refuse("text_invalid", COMMAND_MESSAGES.text_invalid);
  const tokens = draftTokens(raw);
  if (tokens.length > LINE_LIMITS.tokens) return refuse("too_many_tokens", LINE_MESSAGES.too_many_tokens);
  const positions = positionsOf(words);
  const edits = editsOf(doc);
  const isHidden = (id) => edits[id]?.hidden === true;
  const textOf = (id) => (typeof edits[id]?.text === "string" ? edits[id].text : words.words[positions.get(id)].t);
  const known = (id) => positions.has(id);
  const visible = row.wordIds.filter((id) => known(id) && !isHidden(id));
  const setHidden = (wordId, on) => ({ type: "SetWordHidden", args: { wordId, on } });
  if (!visible.length) return { ok: true, commands: [] }; // such a row is dropped (§2.1); nothing to edit
  if (!tokens.length) return { ok: true, commands: visible.map((id) => setHidden(id, true)) };

  const same = sameRule(upper);
  const shown = draftTokens(visible.map(textOf).join(" "));
  if (shown.length === tokens.length && shown.every((token, index) => same(token, tokens[index]))) return { ok: true, commands: [] };

  const ids = [...new Set([...row.wordIds, ...(row.hiddenIds ?? [])])].filter(known)
    .sort((a, b) => positions.get(a) - positions.get(b));
  const old = ids.map((id) => ({ id, text: textOf(id), hidden: isHidden(id) }));
  const anchors = anchorsOf(old, tokens, same);

  // Step 5: one final text per word, as `pre … base … post` so a host can take both ends.
  const finals = new Map();
  const unhide = new Set();
  const remove = new Set();
  const slot = (index, base) => {
    if (!finals.has(index)) finals.set(index, { pre: [], base, post: [] });
    return finals.get(index);
  };
  let from = 0;
  let tokenFrom = 0;
  let previous = null;
  for (const [anchor, token] of [...anchors, [old.length, tokens.length]]) {
    const gone = [];
    for (let index = from; index < anchor; index += 1) if (!old[index].hidden) gone.push(index);
    const typed = tokens.slice(tokenFrom, token);
    const k = gone.length;
    const m = typed.length;
    for (let t = 0; t < Math.min(k, m); t += 1) slot(gone[t], typed[t]);
    for (let t = m; t < k; t += 1) remove.add(gone[t]);
    if (m > k) {
      const extras = typed.slice(k);
      if (k > 0) slot(gone[k - 1], typed[k - 1]).post.push(...extras);
      else if (previous !== null) slot(previous, old[previous].text).post.push(...extras);
      else if (anchor < old.length) slot(anchor, old[anchor].text).pre.push(...extras);
      else throw new Error("a caption row needs a visible word");
    }
    if (anchor < old.length) {
      if (old[anchor].hidden) unhide.add(anchor);
      previous = anchor;
    }
    from = anchor + 1;
    tokenFrom = token + 1;
  }

  // Step 6: in word order; a case-only change under upper case keeps the stored text.
  const commands = [];
  for (let index = 0; index < old.length; index += 1) {
    const { id, text: current } = old[index];
    if (unhide.has(index)) commands.push(setHidden(id, false));
    const entry = finals.get(index);
    if (entry) {
      const text = [...entry.pre, entry.base, ...entry.post].join(" ");
      if (!same(text, current)) {
        if ([...text].length > LINE_LIMITS.wordText) return refuse("text_too_long", LINE_MESSAGES.text_too_long);
        commands.push({ type: "EditWordText", args: { wordId: id, text } });
      }
    }
    if (remove.has(index)) commands.push(setHidden(id, true));
  }
  return { ok: true, commands };
}

/**
 * §2.5 dry run: folds `applyCommand` over `doc` with `ctx` (`createContext({ words, seed })`).
 * → `{ ok: true, doc }` or, at the first refusal, `{ ok: false, code, message }`; `doc` is never
 * changed. Errors that are not refusals are bugs and propagate.
 */
export function checkCommands(doc, ctx, commands) {
  let current = doc;
  for (const { type, args } of commands) {
    try {
      current = applyCommand(current, type, args, ctx).doc;
    } catch (error) {
      if (error instanceof CommandRejected) return refuse(error.code, error.message);
      throw error;
    }
  }
  return { ok: true, doc: current };
}

/**
 * One row's commit (§2.2–§2.5): `lineEdit`, then the dry run; every command carries `mergeKey`
 * (one `actionKey("captionLine")` per commit) so the store keeps them as one undo step.
 * → `{ ok: true, hidesRow, commands: [{ type, args, mergeKey }] }` or `{ ok: false, code, message }`.
 * `hidesRow`: the draft was empty, so the whole line leaves the caption.
 */
export function commitLine({ row, draft, doc, words, upper = false, ctx, mergeKey = null } = {}) {
  const edit = lineEdit({ row, draft, doc, words, upper });
  if (!edit.ok) return edit;
  if (!edit.commands.length) return { ok: true, hidesRow: false, commands: [] };
  const check = checkCommands(doc, ctx, edit.commands);
  if (!check.ok) return check;
  return { ok: true, hidesRow: draftTokens(draft).length === 0, commands: edit.commands.map((command) => ({ ...command, mergeKey })) };
}

/**
 * §2.5: the row key to focus after the rows changed, or null for the card's status line. A key
 * that survives keeps the focus. Otherwise, in the focused row's segment: the row now holding its
 * first visible word; if that word is gone, the first row at or after its old start; else the
 * previous row.
 */
export function focusAfterRegroup(oldRows, newRows, focusedKey) {
  if (focusedKey === null || focusedKey === undefined) return null;
  if (newRows.some((row) => row.key === focusedKey)) return focusedKey;
  const old = oldRows.find((row) => row.key === focusedKey);
  if (!old) return null;
  const segment = newRows.filter((row) => row.seg === old.seg);
  const first = old.wordIds[0];
  const holder = first === undefined ? null : segment.find((row) => row.wordIds.includes(first));
  if (holder) return holder.key;
  const after = segment.find((row) => row.f0 >= old.f0);
  if (after) return after.key;
  return segment.filter((row) => row.f0 < old.f0).at(-1)?.key ?? null;
}

/** The row whose frames `[f0, f1)` hold output frame `frame` (the line under the playhead), or null. */
export function rowAtFrame(rows, frame) {
  if (!Number.isFinite(frame)) return null;
  return (rows ?? []).find((row) => row.f0 <= frame && frame < row.f1) ?? null;
}
