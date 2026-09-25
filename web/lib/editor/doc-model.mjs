// The clip-edit-v2 document model on the client (plan §3, CONTRACTS Part 2 and §5.4–§5.5).
//
// Python (`edit_v2/doc.py`) is the only validator; the client builds valid documents by
// construction. `checkDoc` is the postcondition every command runs: it mirrors the validator's
// rules for everything a command can change, so a document it accepts is accepted by Python
// (checked on every intermediate document of 1,000 random sequences by
// tests/test_edit_v2_crosscheck.py). Documents are immutable values: helpers never mutate.
import { floorDiv, logoBox, pieces, sfCeil, sfFloor } from "./timemap.mjs";

export const SCHEMA = "clip-edit-v2";
export const EDITOR_ID = "editor-v3/1.0.0";
export const PACK_IDS = Object.freeze(["classic", "karaoke", "bold", "box"]);
export const SWATCHES = Object.freeze(["#FFE14D", "#FFFFFF", "#3DF5A6", "#52C7FF", "#FF5C8A", "#FF9F1C"]);
export const PACK_DEFAULT_CASE = Object.freeze({ classic: "asis", karaoke: "asis", bold: "upper", box: "asis" });
export const LAYOUT_MODES = Object.freeze(["fit_blur", "camera", "fill_center"]);
export const REMOVAL_REASONS = Object.freeze(["user", "filler", "repeat", "gap_silent"]);
export const LIMITS = Object.freeze({ removals: 2000, removalWords: 400, wordEdits: 6000, wordText: 40, hookText: 90 });
export const ID_PATTERN = /^[a-z]{2,3}_[0-9a-z]{1,16}$/;
export const WORD_ID_PATTERN = /^w[0-9]{6,7}$/;
export const ASSET_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const ITEM_ORIGIN_PATTERN = /^(?:seed|user|suggestion:[a-z]{2,3}_[0-9a-z]{1,16})$/;
export const REMOVAL_ORIGIN_PATTERN = /^(?:user|suggestion:[a-z]{2,3}_[0-9a-z]{1,16})$/;
/** Track kinds in their canonical order, with the ids a new track and item get. */
export const TRACKS = Object.freeze({
  hook: Object.freeze({ order: 0, track: "tr_hook", item: "it_hook" }),
  visual: Object.freeze({ order: 1, track: "tr_ovr", item: "it_logo" }),
  audio: Object.freeze({ order: 2, track: "tr_mus", item: "it_music" }),
});
const NOT_CONTENT = new Set(["revision", "parent_sha256", "audit"]);

// --- canonical bytes and equality --------------------------------------------------------------

const ASCII = /^[\x00-\x7f]*$/;

function compareKeys(a, b) {
  if (ASCII.test(a) && ASCII.test(b)) return a < b ? -1 : a > b ? 1 : 0;
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    const diff = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (diff) return diff;
  }
  return x.length - y.length;
}

/**
 * Python's `json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)` of a JSON
 * value made of objects, arrays, strings, booleans, null and safe integers.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("non-finite number");
    if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
      throw new TypeError(`${typeof value} is not JSON`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort(compareKeys);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

/** Canonical bytes without `revision`, `parent_sha256` and `audit` (R10 "content"). */
export function contentJson(doc) {
  const content = {};
  for (const key of Object.keys(doc)) if (!NOT_CONTENT.has(key)) content[key] = doc[key];
  return canonicalJson(content);
}

export function contentEquals(a, b) {
  return contentJson(a) === contentJson(b);
}

/** JSON equality that keeps types apart (true is not 1). */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  const keys = Object.keys(a).filter((key) => a[key] !== undefined);
  const other = Object.keys(b).filter((key) => b[key] !== undefined);
  return keys.length === other.length && keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
}

// --- the command context: words artifact and seed ----------------------------------------------

/**
 * Lookup tables of one clip for commands and UI helpers: the words artifact (plan §3.6), the seed
 * (revision 0, "Kembali ke versi AI") and what follows from them (fps, output size, window).
 */
export function createContext({ words, seed }) {
  const fps = seed.output.fps;
  const [num, den] = fps;
  const list = words.words;
  const indexById = new Map(list.map((word, index) => [word.id, index]));
  const before = new Array(list.length).fill(null);
  const after = new Array(list.length).fill(null);
  for (const entry of words.bounds ?? []) {
    if (entry.before != null && indexById.has(entry.before)) before[indexById.get(entry.before)] = entry;
    if (entry.after != null && indexById.has(entry.after)) after[indexById.get(entry.after)] = entry;
  }
  const mids = list.map((word) => floorDiv((word.s + word.e) * num, 2000 * den));
  const boundSfs = [...new Set((words.bounds ?? []).map((entry) => entry.sf))].sort((a, b) => a - b);
  const gaps = new Map((words.gaps ?? []).map((gap) => [gap.after, gap]));
  const laughter = (words.events ?? []).filter((event) => event.kind === "laughter").map((event) => [event.s, event.e]);
  const windowMs = seed.base.window_ms;
  return Object.freeze({
    words,
    seed,
    fps,
    output: Object.freeze({ w: seed.output.w, h: seed.output.h }),
    windowSf: Object.freeze([sfFloor(windowMs[0], fps), sfCeil(windowMs[1], fps)]),
    wordList: list,
    wordIds: new Set(indexById.keys()),
    indexOf: (id) => indexById.get(id) ?? -1,
    word: (id) => (indexById.has(id) ? list[indexById.get(id)] : null),
    /** The `bounds` entry of the gap before word i (plan §3.6 "snap table"). */
    boundBefore: (index) => before[index] ?? after[index - 1] ?? null,
    /** The `bounds` entry of the gap after word i. */
    boundAfter: (index) => after[index] ?? before[index + 1] ?? null,
    /** The source-grid frame of word i's midpoint (the §3.4 visibility rule). */
    midSf: (index) => mids[index],
    boundSfs: Object.freeze(boundSfs),
    gapAfter: (id) => gaps.get(id) ?? null,
    laughter: Object.freeze(laughter),
  });
}

// --- accessors ---------------------------------------------------------------------------------

export function segmentOf(doc, role) {
  return doc.main.segments.find((segment) => segment.role === role) ?? null;
}

export function body(doc) {
  return segmentOf(doc, "body");
}

export function coldOpen(doc) {
  return segmentOf(doc, "cold_open");
}

export function trackOf(doc, kind) {
  return doc.tracks.find((track) => track.kind === kind) ?? null;
}

export function hookItem(doc) {
  return trackOf(doc, "hook")?.items[0] ?? null;
}

export function logoItem(doc) {
  return trackOf(doc, "visual")?.items[0] ?? null;
}

export function musicItem(doc) {
  return trackOf(doc, "audio")?.items[0] ?? null;
}

/** Every id of the document's single id namespace (segments, removals, tracks, items). */
export function documentIds(doc) {
  const ids = new Set();
  for (const segment of doc.main.segments) ids.add(segment.id);
  for (const removal of doc.main.removals) ids.add(removal.id);
  for (const track of doc.tracks) {
    ids.add(track.id);
    for (const item of track.items) ids.add(item.id);
  }
  return ids;
}

/** `<prefix>_<n>` with n one above the largest numeric suffix in use. */
export function nextId(used, prefix) {
  let max = 0;
  const pattern = new RegExp(`^${prefix}_([0-9]{1,15})$`);
  for (const id of used) {
    const match = pattern.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${prefix}_${max + 1}`;
}

/** `preferred` when unused, else the next free `<prefix>_<n>`. */
export function freeId(used, preferred) {
  return used.has(preferred) ? nextId(used, preferred.split("_")[0]) : preferred;
}

// --- transcript helpers for the UI -------------------------------------------------------------

function inSorted(ranges, value, startKey, endKey) {
  let lo = 0;
  let hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid][startKey] <= value) lo = mid + 1;
    else hi = mid;
  }
  const candidate = ranges[lo - 1];
  return candidate && value < candidate[endKey] ? candidate : null;
}

/**
 * Per word id: `{ visibleIn, removal, edit }` — the segment id it is shown in (the body wins
 * when a word is in both), the id of the removal that hides it (body first), and its word edit.
 */
export function wordStatus(doc, ctx) {
  const list = pieces(doc);
  const segments = [body(doc), coldOpen(doc)].filter(Boolean);
  const bySegment = segments.map((segment) => ({
    segment,
    pieces: list.filter((piece) => piece.seg === segment.id),
    removals: doc.main.removals.filter((removal) => removal.seg === segment.id),
  }));
  const edits = doc.captions.word_edits;
  const status = new Map();
  ctx.wordList.forEach((word, index) => {
    const mid = ctx.midSf(index);
    let visibleIn = null;
    let removal = null;
    for (const entry of bySegment) {
      if (mid < entry.segment.in_sf || mid >= entry.segment.out_sf) continue;
      if (!visibleIn && inSorted(entry.pieces, mid, "inSf", "outSf")) visibleIn = entry.segment.id;
      if (!removal) removal = inSorted(entry.removals, mid, "in_sf", "out_sf")?.id ?? null;
    }
    status.set(word.id, { visibleIn, removal, edit: edits[word.id] ?? null });
  });
  return status;
}

/** The word whose trim bound is nearest `sf` (edge "start": gap before it; "end": gap after it). */
export function nearestTrimWord(ctx, sf, edge) {
  let best = null;
  let bestDistance = Infinity;
  ctx.wordList.forEach((word, index) => {
    const bound = edge === "start" ? ctx.boundBefore(index) : ctx.boundAfter(index);
    if (!bound) return;
    const distance = Math.abs(bound.sf - sf);
    if (distance < bestDistance || (distance === bestDistance && edge === "end")) {
      best = word.id;
      bestDistance = distance;
    }
  });
  return best;
}

// --- text rules (plan §3.1: NFC, no Cc/Cs, no edge whitespace; lengths in code points) -----------

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** `{ value }` (NFC, trimmed) or `{ code }` (`invalid_args`, `text_invalid`, `text_empty`, `text_too_long`). */
export function normalizeText(text, max) {
  if (typeof text !== "string") return { code: "invalid_args" };
  if (CONTROL.test(text) || LONE_SURROGATE.test(text)) return { code: "text_invalid" };
  const value = text.normalize("NFC").trim().normalize("NFC");
  if (!value) return { code: "text_empty" };
  if ([...value].length > max) return { code: "text_too_long" };
  return { value };
}

function textOk(value, max) {
  return typeof value === "string" && !CONTROL.test(value) && !LONE_SURROGATE.test(value)
    && value.length > 0 && [...value].length <= max && value.trim() === value && value.normalize("NFC") === value;
}

// --- checkDoc: the command postcondition --------------------------------------------------------

const OVERRIDE_RULES = Object.freeze({
  y_e5: (value) => Number.isSafeInteger(value) && value >= 20000 && value <= 92000,
  size_pm: (value) => Number.isSafeInteger(value) && value >= 700 && value <= 1400,
  case: (value) => value === "asis" || value === "upper",
  highlight: (value) => SWATCHES.includes(value),
  emphasis: (value) => SWATCHES.includes(value),
});
export const CAPTION_OVERRIDE_RULES = OVERRIDE_RULES;

const isInt = (value, lo, hi) => Number.isSafeInteger(value) && value >= lo && value <= hi;

/**
 * Issues `[{code, path}]` of `doc` for the rules of plan §3.3/§3.4 and CONTRACTS §5.4 that the
 * client can break (the parse level, `base` and the asset store are the server's). Empty when
 * the document is valid. The first issue is the most specific one a command reports.
 */
export function checkDoc(doc, ctx) {
  const issues = [];
  const add = (code, path) => issues.push({ code, path });
  const fps = ctx.fps;
  const seed = ctx.seed;
  if (seed) {
    if (!deepEqual(doc.base, seed.base)) add("base_changed", "/base");
    if (!deepEqual(doc.output, seed.output)) add("base_changed", "/output");
    if (doc.clip_id !== seed.clip_id) add("base_changed", "/clip_id");
    if (doc.audit?.created_at_ms !== seed.audit.created_at_ms) add("base_changed", "/audit/created_at_ms");
  }
  const ids = new Set();
  const identifier = (value, path) => {
    if (typeof value !== "string" || !ID_PATTERN.test(value) || ids.has(value)) add("range_invalid", `${path}/id`);
    ids.add(value);
  };

  // main: segments, removals, joins, durations
  const main = doc.main;
  const segments = main.segments;
  const mainIssues = issues.length;
  let bodyIndex = -1;
  let coIndex = -1;
  if (segments.length < 1) add("range_invalid", "/main/segments");
  if (segments.length > 2) add("op_disabled", "/main/segments/2");
  segments.forEach((segment, index) => {
    const path = `/main/segments/${index}`;
    identifier(segment.id, path);
    if (segment.role === "body") {
      if (bodyIndex >= 0) add("range_invalid", path);
      bodyIndex = index;
    } else if (segment.role === "cold_open") {
      if (coIndex >= 0 || index !== 0) add("cold_open_invalid", path);
      coIndex = index;
    } else add("range_invalid", `${path}/role`);
    if (!isInt(segment.in_sf, 0, Number.MAX_SAFE_INTEGER) || !isInt(segment.out_sf, 0, Number.MAX_SAFE_INTEGER)
      || segment.in_sf >= segment.out_sf) {
      add("range_invalid", path);
      return;
    }
    if (segment.in_sf < ctx.windowSf[0]) add("outside_window", `${path}/in_sf`);
    if (segment.out_sf > ctx.windowSf[1]) add("outside_window", `${path}/out_sf`);
  });
  if (bodyIndex < 0) add("range_invalid", "/main/segments");
  const removals = main.removals;
  if (removals.length > LIMITS.removals) add("range_invalid", "/main/removals");
  const segmentById = new Map(segments.map((segment) => [segment.id, segment]));
  const lastOut = new Map();
  removals.forEach((removal, index) => {
    const path = `/main/removals/${index}`;
    identifier(removal.id, path);
    if (!isInt(removal.in_sf, 0, Number.MAX_SAFE_INTEGER) || !isInt(removal.out_sf, 0, Number.MAX_SAFE_INTEGER)
      || removal.in_sf >= removal.out_sf) {
      add("range_invalid", path);
      return;
    }
    const segment = segmentById.get(removal.seg);
    if (!segment) add("removal_outside_segment", `${path}/seg`);
    else if (removal.in_sf < segment.in_sf || removal.out_sf > segment.out_sf) add("removal_outside_segment", path);
    else {
      if (removal.in_sf < (lastOut.get(removal.seg) ?? removal.in_sf)) add("removal_overlap", path);
      lastOut.set(removal.seg, removal.out_sf);
    }
    if (!Array.isArray(removal.words) || removal.words.length > LIMITS.removalWords) add("range_invalid", `${path}/words`);
    else if (removal.words.some((word) => !ctx.wordIds.has(word))) add("unknown_word", `${path}/words`);
    if (!REMOVAL_REASONS.includes(removal.reason)) add("range_invalid", `${path}/reason`);
    if (typeof removal.origin !== "string" || !REMOVAL_ORIGIN_PATTERN.test(removal.origin)) add("range_invalid", `${path}/origin`);
  });
  const co = coIndex >= 0 ? segments[coIndex] : null;
  if (co) {
    const join = main.joins[0];
    if (main.joins.length !== 1 || !join || join.after !== co.id || join.style !== "cut" || !isInt(join.audio_fade_ms, 0, 250)) {
      add("cold_open_invalid", "/main/joins");
    }
  } else if (main.joins.length) add("cold_open_invalid", "/main/joins");
  if (!isInt(main.cut_fade_ms, 0, 50)) add("range_invalid", "/main/cut_fade_ms");
  if (issues.length === mainIssues && bodyIndex >= 0) {
    const frames = new Map();
    for (const piece of pieces(doc)) frames.set(piece.seg, (frames.get(piece.seg) ?? 0) + piece.frames);
    const bodySegment = segments[bodyIndex];
    const bodyFrames = frames.get(bodySegment.id) ?? 0;
    if (bodyFrames < sfCeil(3000, fps) || bodyFrames > sfFloor(300000, fps)) {
      add("duration_out_of_bounds", `/main/segments/${bodyIndex}`);
    }
    if (co) {
      const path = `/main/segments/${coIndex}`;
      const coFrames = frames.get(co.id) ?? 0;
      const [num, den] = fps;
      const length = co.out_sf - co.in_sf;
      const end = (bodySegment.in_sf + length) * den + 2 * num;
      const overlap = Math.max(0, Math.min(co.out_sf * den, end) - Math.max(co.in_sf, bodySegment.in_sf) * den);
      if (coFrames < sfCeil(500, fps) || coFrames > sfFloor(8000, fps) || Math.abs(co.in_sf - bodySegment.in_sf) < 1
        || 5 * overlap > 4 * length * den) {
        add("cold_open_invalid", path);
      }
    }
  }

  // captions
  const captions = doc.captions;
  if (typeof captions.enabled !== "boolean") add("range_invalid", "/captions/enabled");
  if (!PACK_IDS.includes(captions.pack?.id) || captions.pack?.v !== 1) add("pack_unknown", "/captions/pack");
  for (const [key, rule] of Object.entries(OVERRIDE_RULES)) {
    if (!rule(captions.overrides?.[key])) add("range_invalid", `/captions/overrides/${key}`);
  }
  if (Object.keys(captions.overrides ?? {}).length !== 5) add("range_invalid", "/captions/overrides");
  const edits = captions.word_edits;
  const editIds = Object.keys(edits);
  if (editIds.length > LIMITS.wordEdits) add("range_invalid", "/captions/word_edits");
  for (const wordId of editIds) {
    const path = `/captions/word_edits/${wordId}`;
    const edit = edits[wordId] && typeof edits[wordId] === "object" && !Array.isArray(edits[wordId]) ? edits[wordId] : {};
    if (!ctx.wordIds.has(wordId)) add(WORD_ID_PATTERN.test(wordId) ? "unknown_word" : "range_invalid", path);
    const keys = Object.keys(edit);
    if (!keys.length || keys.some((key) => !["text", "hidden", "emphasis"].includes(key))) add("range_invalid", path);
    if (Object.hasOwn(edit, "text") && !textOk(edit.text, LIMITS.wordText)) add("range_invalid", `${path}/text`);
    for (const flag of ["hidden", "emphasis"]) {
      if (Object.hasOwn(edit, flag) && typeof edit[flag] !== "boolean") add("range_invalid", `${path}/${flag}`);
    }
  }

  // layout
  if (!LAYOUT_MODES.includes(doc.layout?.default?.mode) || doc.layout?.default?.no_face !== "center") {
    add("range_invalid", "/layout/default");
  }

  // tracks
  const referenced = new Map();
  const kinds = new Set();
  if (doc.tracks.length > 3) add("op_disabled", "/tracks/3");
  doc.tracks.forEach((track, index) => {
    const path = `/tracks/${index}`;
    identifier(track.id, path);
    if (!TRACKS[track.kind]) {
      add("range_invalid", `${path}/kind`);
      return;
    }
    if (kinds.has(track.kind)) add("op_disabled", path);
    kinds.add(track.kind);
    if (track.kind === "visual" && (track.band !== "over_text" || track.role !== "overlay")) add("range_invalid", path);
    if (track.kind === "audio" && track.role !== "music") add("range_invalid", path);
    if (track.items.length > 1) add("op_disabled", `${path}/items/1`);
    const item = track.items[0];
    if (!item) return;
    const itemPath = `${path}/items/0`;
    identifier(item.id, itemPath);
    if (typeof item.origin !== "string" || !ITEM_ORIGIN_PATTERN.test(item.origin)) add("range_invalid", `${itemPath}/origin`);
    if (track.kind === "hook") checkHook(item, itemPath, fps, add);
    else if (track.kind === "visual") checkLogo(item, itemPath, doc, ctx, add, referenced);
    else checkMusic(item, itemPath, doc, fps, add, referenced);
  });

  // audio
  if (!isInt(doc.audio?.source?.gain_cdb, -2400, 1200)) add("range_invalid", "/audio/source/gain_cdb");
  const master = doc.audio?.master ?? {};
  if (!["off", "normalize"].includes(master.mode) || !isInt(master.target_clufs, -2400, -900) || !isInt(master.tp_cdb, -300, 0)) {
    add("range_invalid", "/audio/master");
  }

  // assets: exactly the referenced ones, with their store metadata
  for (const [assetId, meta] of Object.entries(doc.assets)) {
    if (!referenced.has(assetId)) add("range_invalid", `/assets/${assetId}`);
    else if (!assetMetaOk(meta, referenced.get(assetId))) add("range_invalid", `/assets/${assetId}`);
  }

  // audit
  const audit = doc.audit ?? {};
  if (!isInt(audit.created_at_ms, 0, Number.MAX_SAFE_INTEGER) || !isInt(audit.updated_at_ms, audit.created_at_ms, Number.MAX_SAFE_INTEGER)) {
    add("range_invalid", "/audit");
  }
  if (typeof audit.editor !== "string" || audit.editor.length < 1 || [...audit.editor].length > 64) add("range_invalid", "/audit/editor");
  if (typeof audit.last_command !== "string" || !/^[A-Za-z]{1,40}$/.test(audit.last_command)) add("range_invalid", "/audit/last_command");
  return issues;
}

function checkHook(item, path, fps, add) {
  if (item.type !== "hook") add("range_invalid", `${path}/type`);
  if (item.start?.at !== "out" || item.start?.f !== 0 || Object.keys(item.start ?? {}).length !== 2) add("range_invalid", `${path}/start`);
  if (!isInt(item.dur_f, 15, sfFloor(30000, fps))) add("range_invalid", `${path}/dur_f`);
  if (item.transform?.x_e5 !== 50000 || !isInt(item.transform?.y_e5, 6000, 40000)) add("range_invalid", `${path}/transform`);
  if (!textOk(item.payload?.text, LIMITS.hookText)) add("range_invalid", `${path}/payload/text`);
  if (item.payload?.design?.id !== "legacy-bar" || item.payload?.design?.v !== 1) add("op_disabled", `${path}/payload/design`);
}

function anchorsOk(item) {
  return deepEqual(item.start, { at: "clip_start" }) && deepEqual(item.end, { at: "clip_end" });
}

function checkLogo(item, path, doc, ctx, add, referenced) {
  if (item.type !== "image") add("range_invalid", `${path}/type`);
  if (!anchorsOk(item)) add("range_invalid", path);
  const t = item.transform ?? {};
  const ranges = isInt(t.x_e5, 0, 100000) && isInt(t.y_e5, 0, 100000) && isInt(t.w_e5, 4000, 40000);
  if (!ranges || !isInt(t.opacity_pm, 200, 1000)) add("range_invalid", `${path}/transform`);
  if (item.payload?.mode !== "free") add("range_invalid", `${path}/payload/mode`);
  const assetId = item.payload?.asset;
  const meta = doc.assets[assetId];
  if (typeof assetId !== "string" || !ASSET_ID_PATTERN.test(assetId) || !meta) {
    add("asset_missing", `${path}/payload/asset`);
    return;
  }
  referenced.set(assetId, "image");
  if (meta.kind !== "image" || !ranges) return;
  const [x0, y0, w, h] = logoBox({ ...t, asset_w: meta.w, asset_h: meta.h, out_w: ctx.output.w, out_h: ctx.output.h });
  if (x0 < 0 || y0 < 0 || x0 + w > ctx.output.w || y0 + h > ctx.output.h) add("item_out_of_frame", path);
}

function checkMusic(item, path, doc, fps, add, referenced) {
  if (item.type !== "audio") add("range_invalid", `${path}/type`);
  if (!anchorsOk(item)) add("range_invalid", path);
  const p = item.payload ?? {};
  const meta = doc.assets[p.asset];
  if (typeof p.asset !== "string" || !ASSET_ID_PATTERN.test(p.asset) || !meta) add("asset_missing", `${path}/payload/asset`);
  else referenced.set(p.asset, "audio");
  const limit = meta?.kind === "audio" ? meta.duration_ms * 48 - 1 : Number.MAX_SAFE_INTEGER;
  const fade = sfFloor(10000, fps);
  if (!isInt(p.src_in_smp, 0, Math.max(limit, 0))) add("range_invalid", `${path}/payload/src_in_smp`);
  if (typeof p.loop !== "boolean") add("range_invalid", `${path}/payload/loop`);
  if (!isInt(p.gain_cdb, -4800, 600)) add("range_invalid", `${path}/payload/gain_cdb`);
  if (!isInt(p.fade_in_f, 0, fade) || !isInt(p.fade_out_f, 0, fade)) add("range_invalid", `${path}/payload`);
  const duck = p.duck ?? {};
  if (typeof duck.on !== "boolean" || !isInt(duck.depth_cdb, 300, 2400) || !isInt(duck.attack_ms, 5, 500)
    || !isInt(duck.release_ms, 50, 2000) || !isInt(duck.hold_ms, 0, 1000) || duck.detector !== "words"
    || Object.keys(duck).length !== 6) {
    add("range_invalid", `${path}/payload/duck`);
  }
}

function assetMetaOk(meta, kind) {
  if (!meta || meta.kind !== kind) return false;
  if (kind === "image") {
    return meta.mime === "image/png" && isInt(meta.w, 1, 4096) && isInt(meta.h, 1, 4096) && Object.keys(meta).length === 4;
  }
  return meta.mime === "audio/mp4" && isInt(meta.duration_ms, 1, Number.MAX_SAFE_INTEGER)
    && Number.isSafeInteger(meta.lufs_c) && Object.keys(meta).length === 4;
}

/** mm:ss of an output frame (the labels of the conflict dialog: "Potongan 00:12"). */
export function formatFrameTime(frame, fps) {
  const [num, den] = fps;
  const seconds = floorDiv(frame * den, num);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
