// Editor commands (plan Appendix B, §4.5): every command is a pure function
// `applyCommand(doc, type, args, ctx) → { doc, args }` over an immutable document, with
// structural sharing (unchanged parts are the same objects). `ctx` is `createContext({ words,
// seed })` (doc-model.mjs): the words artifact is the single source of cut points (`bounds`,
// plan §3.6) and the seed is "Kembali ke versi AI". A command checks its preconditions and then
// the document rules (`checkDoc`), throwing `CommandRejected(code)` with an Indonesian message,
// so it never produces a document the Python validator would reject. The returned `args` are
// normalised (trimmed NFC text, the ids a command created, the segment it chose) so that a replay
// on the same document gives the same result (history, draft and rebase replay them).
//
// Choices where Appendix B leaves room (recorded in the T2.5 report):
// - RemoveWords accepts a run that crosses already removed words; it merges every overlapping or
//   touching removal of that segment, clamps to the segment and keeps ≤ 400 words per removal
//   (longer runs become touching removals). Optional `seg` picks the segment; default: the body
//   when a word is visible there, else the cold open.
// - SetCaptionPack switches `case` to the new pack's default when the current case is the old
//   pack's default (Bold is upper-case by default, plan §5.4); a user's own case is kept.
// - SetHookText / SetHookEnabled restore the seed item's origin when the text equals the seed's
//   hook text, and EditWordText drops the edit when the text equals the ASR text, so a manual
//   revert gives content equal to the seed (R10).
// - Logo commands reject a box outside the frame (`item_out_of_frame`); SetLogo and SnapLogo
//   fit the box instead (shrinking a very tall logo); `clampLogoPosition` is the helper for drags.
// - ApplyCleanup items: `{ id, kind: "filler" | "repeat", wordIds }` or
//   `{ id, kind: "gap_silent", afterWord, inSf, outSf }`; origin `suggestion:<id>`.
import {
  ASSET_ID_PATTERN,
  CAPTION_OVERRIDE_RULES,
  EDITOR_ID,
  ITEM_ORIGIN_PATTERN,
  LAYOUT_MODES,
  LIMITS,
  PACK_DEFAULT_CASE,
  PACK_IDS,
  REMOVAL_ORIGIN_PATTERN,
  TRACKS,
  body,
  checkDoc,
  coldOpen,
  documentIds,
  freeId,
  hookItem,
  logoItem,
  musicItem,
  nextId,
  normalizeText,
  trackOf,
} from "./doc-model.mjs";
import { divRoundHalfUp, logoBox, pieces, sfCeil, sfFloor } from "./timemap.mjs";

/** Appendix B, in the order of the table (the same list as `__dev__/fakes.mjs`). */
export const COMMANDS = Object.freeze([
  "TrimStart", "TrimEnd", "RemoveWords", "RemoveGap", "RestoreRemoval", "ApplyCleanup",
  "SetColdOpen", "NudgeColdOpen", "EditWordText", "SetWordHidden", "SetWordEmphasis",
  "SetCaptionsEnabled", "SetCaptionPack", "SetCaptionOverride", "SetHookEnabled", "SetHookText",
  "SetHookDuration", "SetHookY", "SetLayout", "SetLogo", "RemoveLogo", "MoveLogo", "ResizeLogo",
  "SetLogoOpacity", "SnapLogo", "SetMusic", "RemoveMusic", "SetMusicGain", "SetMusicOffset",
  "SetMusicLoop", "SetMusicFades", "SetDuck", "SetSourceGain", "SetLoudness", "ResetToSeed",
]);

/** Indonesian message per rejection code (message id `editor.<code>`). */
export const COMMAND_MESSAGES = Object.freeze({
  unknown_command: "Perintah editor tidak dikenal.",
  invalid_args: "Perintah editor tidak lengkap atau tidak valid.",
  not_ready: "Editor belum siap; tunggu sampai klip terbuka.",
  read_only: "Klip ini hanya bisa dibaca.",
  unknown_word: "Kata tidak ditemukan di transkrip klip ini.",
  not_contiguous: "Pilih kata yang berurutan.",
  nothing_to_remove: "Bagian ini sudah dipotong.",
  range_empty: "Tidak ada yang bisa dipotong di sini.",
  range_invalid: "Awal klip harus sebelum akhirnya.",
  removal_outside_segment: "Potongan harus berada di dalam klip.",
  removal_overlap: "Potongan saling tumpang tindih.",
  removal_missing: "Potongan ini sudah tidak ada.",
  too_many_removals: "Terlalu banyak potongan (maksimal 2.000).",
  too_many_word_edits: "Terlalu banyak kata yang diubah (maksimal 6.000).",
  duration_out_of_bounds: "Durasi klip harus antara 3 detik dan 5 menit.",
  cold_open_invalid: "Cold open harus 0,5–8 detik dan tidak mengulang pembukaan klip.",
  cold_open_missing: "Klip ini belum punya cold open.",
  outside_window: "Di luar jangkauan analisis klip (±60 detik).",
  gap_invalid: "Rentang jeda harus berada di dalam jeda antar kata.",
  laughter_locked: "Jeda di sekitar tawa dikunci.",
  text_invalid: "Teks mengandung karakter yang tidak diizinkan.",
  text_empty: "Teks tidak boleh kosong.",
  text_too_long: "Teks terlalu panjang.",
  value_out_of_range: "Nilai di luar batas yang diizinkan.",
  pack_unknown: "Preset caption tidak dikenal.",
  hook_missing: "Hook belum aktif.",
  logo_missing: "Belum ada logo.",
  music_missing: "Belum ada musik.",
  asset_invalid: "Berkas aset tidak cocok untuk perintah ini.",
  item_out_of_frame: "Logo harus berada di dalam frame.",
  nothing_to_apply: "Tidak ada saran yang dipilih.",
  removal_too_large: "Potongan terlalu panjang untuk disimpan sekaligus.",
  base_changed: "Dokumen tidak cocok dengan klip ini; muat ulang editor.",
  op_disabled: "Fitur ini belum tersedia di Editor Esensial.",
  asset_missing: "Aset tidak ditemukan.",
  conflict_unresolved: "Pilih versi untuk setiap bagian yang bentrok.",
});

export function commandMessage(code) {
  return COMMAND_MESSAGES[code] ?? COMMAND_MESSAGES.invalid_args;
}

export class CommandRejected extends Error {
  constructor(code, detail = null) {
    super(commandMessage(code));
    this.name = "CommandRejected";
    this.code = code;
    this.messageId = `editor.${code}`;
    this.detail = detail;
  }
}

/** Duck depth presets of the music panel (plan §11.3 T3.3): Halus −6, Sedang −10, Kuat −16 dB. */
export const DUCK_PRESETS = Object.freeze({ halus: 600, sedang: 1000, kuat: 1600 });
const DEFAULT_DUCK = Object.freeze({ on: true, depth_cdb: 1000, attack_ms: 30, release_ms: 400, hold_ms: 250, detector: "words" });
const DEFAULT_LOGO = Object.freeze({ x_e5: 88000, y_e5: 7000, w_e5: 16000, opacity_pm: 850 });
const DEFAULT_HOOK_MS = 4000; // today's hook duration (captions_ass.build_ass)
const JOIN_FADE_MS = 30; // today's AUDIO_JOIN_FADE_SECONDS
const CORNERS = Object.freeze(["top_left", "top_right", "bottom_left", "bottom_right"]);

/** §3.3: `clamp(−2600 − lufs_c, −4800, 600)`. */
export function defaultMusicGain(lufsC) {
  return Math.min(600, Math.max(-4800, -2600 - lufsC));
}

// --- argument helpers ----------------------------------------------------------------------

function need(condition, code = "invalid_args", detail = null) {
  if (!condition) throw new CommandRejected(code, detail);
}

function intArg(args, key, lo, hi) {
  const value = args[key];
  need(Number.isSafeInteger(value), "invalid_args", { arg: key });
  need(value >= lo && value <= hi, "value_out_of_range", { arg: key });
  return value;
}

function boolArg(args, key) {
  need(typeof args[key] === "boolean", "invalid_args", { arg: key });
  return args[key];
}

function textArg(text, max) {
  const result = normalizeText(text, max);
  need(!result.code, result.code);
  return result.value;
}

function originArg(value, pattern, fallback) {
  if (value === undefined) return fallback;
  need(typeof value === "string" && pattern.test(value) && value !== "seed", "invalid_args", { arg: "origin" });
  return value;
}

function wordIndex(ctx, id) {
  need(typeof id === "string", "invalid_args", { arg: "wordId" });
  const index = ctx.indexOf(id);
  need(index >= 0, "unknown_word");
  return index;
}

function bound(entry) {
  need(entry && Number.isSafeInteger(entry.sf), "unknown_word");
  return entry.sf;
}

function insideWindow(ctx, inSf, outSf) {
  need(inSf >= ctx.windowSf[0] && outSf <= ctx.windowSf[1], "outside_window");
}

// --- document helpers ----------------------------------------------------------------------

function withMain(doc, patch) {
  return { ...doc, main: { ...doc.main, ...patch } };
}

function withCaptions(doc, patch) {
  return { ...doc, captions: { ...doc.captions, ...patch } };
}

function segmentOrder(doc) {
  return new Map(doc.main.segments.map((segment, index) => [segment.id, index]));
}

/** Removals in canonical order: by segment order, then by `in_sf`. */
function sortRemovals(doc, removals) {
  const order = segmentOrder(doc);
  return [...removals].sort((a, b) => (order.get(a.seg) ?? 99) - (order.get(b.seg) ?? 99) || a.in_sf - b.in_sf);
}

/** Clamps the removals of one segment to `[lo, hi)`; a removal left empty is dropped. */
function clampRemovals(removals, segId, lo, hi) {
  const result = [];
  for (const removal of removals) {
    if (removal.seg !== segId) {
      result.push(removal);
      continue;
    }
    const inSf = Math.max(removal.in_sf, lo);
    const outSf = Math.min(removal.out_sf, hi);
    if (inSf >= outSf) continue;
    result.push(inSf === removal.in_sf && outSf === removal.out_sf ? removal : { ...removal, in_sf: inSf, out_sf: outSf });
  }
  return result;
}

function replaceSegment(doc, segment, next) {
  return doc.main.segments.map((item) => (item === segment ? next : item));
}

function segmentPieces(doc, segId) {
  return pieces(doc).filter((piece) => piece.seg === segId);
}

/**
 * Adds a removal to a segment, merged with every overlapping or touching removal there (plan
 * Appendix B), split into touching removals of ≤ 400 words. Returns the document and the id.
 */
function insertRemoval(doc, ctx, segment, removal, requestedId) {
  const all = doc.main.removals;
  const touching = all.filter((item) => item.seg === segment.id && item.in_sf <= removal.out_sf && item.out_sf >= removal.in_sf);
  need(!touching.some((item) => item.in_sf <= removal.in_sf && item.out_sf >= removal.out_sf), "nothing_to_remove");
  const lo = Math.min(removal.in_sf, ...touching.map((item) => item.in_sf));
  const hi = Math.max(removal.out_sf, ...touching.map((item) => item.out_sf));
  const words = [...new Set([...removal.words, ...touching.flatMap((item) => item.words)])]
    .sort((a, b) => ctx.indexOf(a) - ctx.indexOf(b));
  const used = documentIds(doc);
  for (const item of touching) used.delete(item.id);
  const id = typeof requestedId === "string" && /^[a-z]{2,3}_[0-9a-z]{1,16}$/.test(requestedId) && !used.has(requestedId)
    ? requestedId : nextId(used, "rm");
  used.add(id);
  const chunks = [];
  let start = lo;
  for (let k = 0; k < words.length || k === 0; k += LIMITS.removalWords) {
    const group = words.slice(k, k + LIMITS.removalWords);
    const last = k + LIMITS.removalWords >= words.length;
    const end = last ? hi : Math.min(hi, Math.max(start, bound(ctx.boundAfter(ctx.indexOf(group.at(-1))))));
    need(end > start, "removal_too_large");
    const chunkId = chunks.length ? nextId(used, "rm") : id;
    used.add(chunkId);
    chunks.push({ id: chunkId, seg: segment.id, in_sf: start, out_sf: end, words: group, reason: removal.reason, origin: removal.origin });
    start = end;
    if (last) break;
  }
  const removals = sortRemovals(doc, [...all.filter((item) => !touching.includes(item)), ...chunks]);
  need(removals.length <= LIMITS.removals, "too_many_removals");
  return { doc: withMain(doc, { removals }), id };
}

/** The segment a word run is removed from: `segId`, else the body, else the cold open. */
function chooseSegment(doc, ctx, segId, indexes) {
  let candidates;
  if (segId !== undefined) {
    need(typeof segId === "string", "invalid_args", { arg: "seg" });
    const segment = doc.main.segments.find((item) => item.id === segId);
    need(segment, "removal_outside_segment");
    candidates = [segment];
  } else {
    candidates = [body(doc), coldOpen(doc)].filter(Boolean);
  }
  let inRange = false;
  for (const segment of candidates) {
    const list = segmentPieces(doc, segment.id);
    for (const index of indexes) {
      const mid = ctx.midSf(index);
      if (mid < segment.in_sf || mid >= segment.out_sf) continue;
      inRange = true;
      if (list.some((piece) => mid >= piece.inSf && mid < piece.outSf)) return segment;
    }
  }
  throw new CommandRejected(inRange ? "nothing_to_remove" : "removal_outside_segment");
}

function putTrack(doc, track) {
  const tracks = doc.tracks.filter((item) => item.kind !== track.kind);
  const at = tracks.findIndex((item) => (TRACKS[item.kind]?.order ?? 9) > TRACKS[track.kind].order);
  tracks.splice(at < 0 ? tracks.length : at, 0, track);
  return { ...doc, tracks };
}

function dropTrack(doc, kind) {
  return { ...doc, tracks: doc.tracks.filter((track) => track.kind !== kind) };
}

/** `assets` = exactly the assets the items reference (`added` gives metadata for new ones). */
function syncAssets(doc, added = {}) {
  const assets = {};
  for (const track of doc.tracks) {
    for (const item of track.items) {
      const id = item.payload?.asset;
      if (typeof id !== "string") continue;
      const meta = added[id] ?? doc.assets[id];
      need(meta, "asset_invalid");
      assets[id] = meta;
    }
  }
  return { ...doc, assets };
}

function withItem(doc, kind, patch) {
  const track = trackOf(doc, kind);
  const item = track.items[0];
  const next = { ...track, items: [{ ...item, ...patch(item) }] };
  return { ...doc, tracks: doc.tracks.map((entry) => (entry === track ? next : entry)) };
}

/** Normalises an asset reference from a document id or the upload DTO (plan §4.2 `POST /assets`). */
function assetArg(asset, meta, kind) {
  need(meta && typeof meta === "object", "asset_invalid");
  let id = typeof asset === "string" ? asset : meta.sha256;
  if (typeof id === "string" && /^[0-9a-f]{64}$/.test(id)) id = `sha256:${id}`;
  need(typeof id === "string" && ASSET_ID_PATTERN.test(id), "asset_invalid");
  const metaKind = meta.kind === "logo" ? "image" : meta.kind === "music" ? "audio" : meta.kind;
  need(metaKind === kind, "asset_invalid");
  if (kind === "image") {
    need(meta.mime === "image/png", "asset_invalid");
    need(Number.isSafeInteger(meta.w) && meta.w >= 1 && meta.w <= 4096, "asset_invalid");
    need(Number.isSafeInteger(meta.h) && meta.h >= 1 && meta.h <= 4096, "asset_invalid");
    return { id, meta: { kind, mime: meta.mime, w: meta.w, h: meta.h } };
  }
  const duration = meta.duration_ms ?? meta.durationMs;
  const lufs = meta.lufs_c ?? meta.lufsC;
  need(meta.mime === "audio/mp4", "asset_invalid");
  need(Number.isSafeInteger(duration) && duration >= 1, "asset_invalid");
  need(Number.isSafeInteger(lufs), "asset_invalid");
  return { id, meta: { kind, mime: meta.mime, duration_ms: duration, lufs_c: lufs } };
}

// --- logo geometry -------------------------------------------------------------------------

function box(ctx, transform, meta) {
  return logoBox({ x_e5: transform.x_e5, y_e5: transform.y_e5, w_e5: transform.w_e5, asset_w: meta.w, asset_h: meta.h,
    out_w: ctx.output.w, out_h: ctx.output.h });
}

function boxInside(ctx, transform, meta) {
  const [x0, y0, w, h] = box(ctx, transform, meta);
  return x0 >= 0 && y0 >= 0 && x0 + w <= ctx.output.w && y0 + h <= ctx.output.h;
}

/** Smallest e5 in [0, 100000] with ok(e5) (ok monotone false→true), or null. */
function firstTrue(ok) {
  if (!ok(100000)) return null;
  let lo = 0;
  let hi = 100000;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ok(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Largest e5 in [0, 100000] with ok(e5) (ok monotone true→false), or null. */
function lastTrue(ok) {
  if (!ok(0)) return null;
  let lo = 0;
  let hi = 100000;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ok(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function clampPosition(ctx, meta, x, y, w) {
  const at = (xe, ye) => box(ctx, { x_e5: xe, y_e5: ye, w_e5: w }, meta);
  const xlo = firstTrue((xe) => at(xe, 50000)[0] >= 0);
  const xhi = lastTrue((xe) => at(xe, 50000)[0] + at(xe, 50000)[2] <= ctx.output.w);
  const ylo = firstTrue((ye) => at(50000, ye)[1] >= 0);
  const yhi = lastTrue((ye) => at(50000, ye)[1] + at(50000, ye)[3] <= ctx.output.h);
  if (xlo === null || xhi === null || ylo === null || yhi === null || xlo > xhi || ylo > yhi) return null;
  return [Math.min(Math.max(x, xlo), xhi), Math.min(Math.max(y, ylo), yhi)];
}

/** Fits a logo transform into the frame: shrinks `w_e5` if the box is taller than the frame, then clamps the centre. */
function fitLogo(ctx, transform, meta) {
  let w = transform.w_e5;
  const fits = (we) => {
    const [, , bw, bh] = box(ctx, { x_e5: 50000, y_e5: 50000, w_e5: we }, meta);
    return bw <= ctx.output.w && bh <= ctx.output.h;
  };
  if (!fits(w)) {
    let lo = 4000;
    let hi = w;
    need(fits(lo), "item_out_of_frame");
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (fits(mid)) lo = mid;
      else hi = mid - 1;
    }
    w = lo;
  }
  const position = clampPosition(ctx, meta, transform.x_e5, transform.y_e5, w);
  need(position, "item_out_of_frame");
  return { ...transform, x_e5: position[0], y_e5: position[1], w_e5: w };
}

/** For drags: the nearest `[x_e5, y_e5]` that keeps the current logo's box inside the frame. */
export function clampLogoPosition(doc, x, y, ctx) {
  const item = logoItem(doc);
  if (!item) return [x, y];
  const meta = doc.assets[item.payload.asset];
  return clampPosition(ctx, meta, x, y, item.transform.w_e5) ?? [item.transform.x_e5, item.transform.y_e5];
}

// --- handlers --------------------------------------------------------------------------------

function trimBody(doc, ctx, edge, sf) {
  const segment = body(doc);
  need(segment, "range_invalid");
  const next = edge === "in" ? { ...segment, in_sf: sf } : { ...segment, out_sf: sf };
  need(next.in_sf < next.out_sf, "range_invalid");
  insideWindow(ctx, next.in_sf, next.out_sf);
  return withMain(doc, {
    segments: replaceSegment(doc, segment, next),
    removals: clampRemovals(doc.main.removals, segment.id, next.in_sf, next.out_sf),
  });
}

function removeWords(doc, args, ctx) {
  need(Array.isArray(args.wordIds) && args.wordIds.length > 0 && args.wordIds.length <= 10000, "invalid_args", { arg: "wordIds" });
  const indexes = [...new Set(args.wordIds.map((id) => wordIndex(ctx, id)))].sort((a, b) => a - b);
  need(indexes.every((index, k) => k === 0 || index === indexes[k - 1] + 1), "not_contiguous");
  const reason = args.reason ?? "user";
  need(["user", "filler", "repeat"].includes(reason), "invalid_args", { arg: "reason" });
  const origin = originArg(args.origin, REMOVAL_ORIGIN_PATTERN, "user");
  const segment = chooseSegment(doc, ctx, args.seg, indexes);
  const a = Math.max(bound(ctx.boundBefore(indexes[0])), segment.in_sf);
  const b = Math.min(bound(ctx.boundAfter(indexes.at(-1))), segment.out_sf);
  need(a < b, "range_empty");
  const words = indexes.filter((index) => ctx.midSf(index) >= a && ctx.midSf(index) < b).map((index) => ctx.wordList[index].id);
  const result = insertRemoval(doc, ctx, segment, { in_sf: a, out_sf: b, words, reason, origin }, args.id);
  return { doc: result.doc, args: { wordIds: indexes.map((index) => ctx.wordList[index].id), reason, origin, seg: segment.id, id: result.id } };
}

function removeGap(doc, args, ctx) {
  const index = wordIndex(ctx, args.afterWord);
  need(index + 1 < ctx.wordList.length, "gap_invalid");
  need(Number.isSafeInteger(args.inSf) && Number.isSafeInteger(args.outSf), "invalid_args", { arg: "inSf" });
  const left = ctx.wordList[index];
  const right = ctx.wordList[index + 1];
  const lo = sfCeil(left.e, ctx.fps);
  const hi = sfFloor(right.s, ctx.fps);
  need(lo <= args.inSf && args.inSf < args.outSf && args.outSf <= hi, "gap_invalid");
  need(ctx.gapAfter(left.id)?.class !== "laughter", "laughter_locked");
  need(!ctx.laughter.some(([s, e]) => s <= right.s + 500 && e >= left.e - 500), "laughter_locked");
  const reason = args.reason ?? "gap_silent";
  need(reason === "gap_silent" || reason === "user", "invalid_args", { arg: "reason" });
  const origin = originArg(args.origin, REMOVAL_ORIGIN_PATTERN, "user");
  let segment;
  if (args.seg !== undefined) segment = doc.main.segments.find((item) => item.id === args.seg);
  else segment = [body(doc), coldOpen(doc)].find((item) => item && item.in_sf <= args.inSf && args.outSf <= item.out_sf);
  need(segment && segment.in_sf <= args.inSf && args.outSf <= segment.out_sf, "removal_outside_segment");
  const result = insertRemoval(doc, ctx, segment, { in_sf: args.inSf, out_sf: args.outSf, words: [], reason, origin }, args.id);
  return { doc: result.doc, args: { afterWord: left.id, inSf: args.inSf, outSf: args.outSf, reason, origin, seg: segment.id, id: result.id } };
}

function setWordEdit(doc, ctx, wordId, patch) {
  wordIndex(ctx, wordId);
  const current = doc.captions.word_edits[wordId] ?? {};
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  const edits = { ...doc.captions.word_edits };
  if (Object.keys(next).length) edits[wordId] = next;
  else delete edits[wordId];
  need(Object.keys(edits).length <= LIMITS.wordEdits, "too_many_word_edits");
  return withCaptions(doc, { word_edits: edits });
}

function hookText(ctx, text, origin) {
  const seedItem = hookItem(ctx.seed);
  return seedItem && seedItem.payload.text === text ? seedItem.origin : origin;
}

function setHookText(doc, args, ctx) {
  const text = textArg(args.text, LIMITS.hookText);
  const requested = originArg(args.origin, ITEM_ORIGIN_PATTERN, "user");
  const origin = hookText(ctx, text, requested);
  return {
    doc: withItem(doc, "hook", (item) => ({ payload: { ...item.payload, text }, origin })),
    args: { text, origin: requested },
  };
}

function requireItem(doc, kind, code) {
  need(trackOf(doc, kind)?.items.length, code);
}

function snapTarget(ctx, transform, meta, corner) {
  const { w: width, h: height } = ctx.output;
  const [, , w, h] = box(ctx, transform, meta);
  const mx = divRoundHalfUp(4 * width, 100);
  const my = divRoundHalfUp(25 * height, 1000);
  const x0 = corner.endsWith("left") ? mx : width - mx - w;
  const y0 = corner.startsWith("top") ? my : height - my - h;
  return [divRoundHalfUp((2 * x0 + w) * 100000, 2 * width), divRoundHalfUp((2 * y0 + h) * 100000, 2 * height)];
}

const HANDLERS = {
  TrimStart(doc, args, ctx) {
    const index = wordIndex(ctx, args.gapWord);
    return { doc: trimBody(doc, ctx, "in", bound(ctx.boundBefore(index))), args: { gapWord: args.gapWord } };
  },

  TrimEnd(doc, args, ctx) {
    const index = wordIndex(ctx, args.gapWord);
    return { doc: trimBody(doc, ctx, "out", bound(ctx.boundAfter(index))), args: { gapWord: args.gapWord } };
  },

  RemoveWords: removeWords,
  RemoveGap: removeGap,

  RestoreRemoval(doc, args) {
    need(typeof args.removalId === "string", "invalid_args", { arg: "removalId" });
    const removals = doc.main.removals.filter((removal) => removal.id !== args.removalId);
    need(removals.length < doc.main.removals.length, "removal_missing");
    return { doc: withMain(doc, { removals }), args: { removalId: args.removalId } };
  },

  ApplyCleanup(doc, args, ctx) {
    need(Array.isArray(args.items), "invalid_args", { arg: "items" });
    need(args.items.length > 0, "nothing_to_apply");
    need(args.items.length <= LIMITS.removals, "too_many_removals");
    let next = doc;
    const items = [];
    args.items.forEach((item, index) => {
      try {
        need(item && typeof item === "object" && typeof item.id === "string" && /^[a-z]{2,3}_[0-9a-z]{1,16}$/.test(item.id), "invalid_args");
        const origin = `suggestion:${item.id}`;
        let result;
        if (item.kind === "gap_silent") {
          result = removeGap(next, { afterWord: item.afterWord, inSf: item.inSf, outSf: item.outSf, origin, id: item.removalId }, ctx);
          items.push({ id: item.id, kind: item.kind, afterWord: item.afterWord, inSf: item.inSf, outSf: item.outSf, removalId: result.args.id });
        } else {
          need(item.kind === "filler" || item.kind === "repeat", "invalid_args");
          result = removeWords(next, { wordIds: item.wordIds, reason: item.kind, origin, id: item.removalId }, ctx);
          items.push({ id: item.id, kind: item.kind, wordIds: result.args.wordIds, removalId: result.args.id });
        }
        next = result.doc;
      } catch (error) {
        if (error instanceof CommandRejected) throw new CommandRejected(error.code, { ...error.detail, item: index });
        throw error;
      }
    });
    return { doc: next, args: { items } };
  },

  SetColdOpen(doc, args, ctx) {
    const co = coldOpen(doc);
    if (args === null || args.off === true) {
      if (!co) return { doc, args: null };
      return {
        doc: withMain(doc, {
          segments: doc.main.segments.filter((segment) => segment !== co),
          removals: doc.main.removals.filter((removal) => removal.seg !== co.id),
          joins: [],
        }),
        args: null,
      };
    }
    need(typeof args === "object", "invalid_args");
    const first = wordIndex(ctx, args.firstWord);
    const last = wordIndex(ctx, args.lastWord);
    need(first <= last, "invalid_args", { arg: "lastWord" });
    const inSf = bound(ctx.boundBefore(first));
    const outSf = bound(ctx.boundAfter(last));
    need(inSf < outSf, "cold_open_invalid");
    insideWindow(ctx, inSf, outSf);
    const id = co?.id ?? freeId(documentIds(doc), "seg_co");
    const segment = { id, role: "cold_open", in_sf: inSf, out_sf: outSf };
    const fade = doc.main.joins[0]?.audio_fade_ms ?? JOIN_FADE_MS;
    return {
      doc: withMain(doc, {
        segments: [segment, ...doc.main.segments.filter((item) => item.role !== "cold_open")],
        removals: co ? doc.main.removals.filter((removal) => removal.seg !== co.id) : doc.main.removals,
        joins: [{ after: id, style: "cut", audio_fade_ms: fade }],
      }),
      args: { firstWord: args.firstWord, lastWord: args.lastWord },
    };
  },

  NudgeColdOpen(doc, args, ctx) {
    const co = coldOpen(doc);
    need(co, "cold_open_missing");
    need(args.edge === "in" || args.edge === "out", "invalid_args", { arg: "edge" });
    need(Number.isSafeInteger(args.words) && args.words !== 0 && Math.abs(args.words) <= 50, "invalid_args", { arg: "words" });
    const sfs = ctx.boundSfs;
    const current = args.edge === "in" ? co.in_sf : co.out_sf;
    let target;
    if (args.words > 0) {
      const position = sfs.findIndex((sf) => sf > current);
      target = position < 0 ? undefined : sfs[position + args.words - 1];
    } else {
      const position = sfs.findLastIndex((sf) => sf < current);
      target = position < 0 ? undefined : sfs[position + args.words + 1];
    }
    need(target !== undefined, "cold_open_invalid");
    const next = { ...co, [args.edge === "in" ? "in_sf" : "out_sf"]: target };
    need(next.in_sf < next.out_sf, "cold_open_invalid");
    insideWindow(ctx, next.in_sf, next.out_sf);
    return {
      doc: withMain(doc, {
        segments: replaceSegment(doc, co, next),
        removals: clampRemovals(doc.main.removals, co.id, next.in_sf, next.out_sf),
      }),
      args: { edge: args.edge, words: args.words },
    };
  },

  EditWordText(doc, args, ctx) {
    const index = wordIndex(ctx, args.wordId);
    const text = textArg(args.text, LIMITS.wordText);
    return {
      doc: setWordEdit(doc, ctx, args.wordId, { text: text === ctx.wordList[index].t ? null : text }),
      args: { wordId: args.wordId, text },
    };
  },

  SetWordHidden(doc, args, ctx) {
    const on = boolArg(args, "on");
    return { doc: setWordEdit(doc, ctx, args.wordId, { hidden: on ? true : null }), args: { wordId: args.wordId, on } };
  },

  SetWordEmphasis(doc, args, ctx) {
    const on = boolArg(args, "on");
    return { doc: setWordEdit(doc, ctx, args.wordId, { emphasis: on ? true : null }), args: { wordId: args.wordId, on } };
  },

  SetCaptionsEnabled(doc, args) {
    const on = boolArg(args, "on");
    return { doc: withCaptions(doc, { enabled: on }), args: { on } };
  },

  SetCaptionPack(doc, args) {
    need(PACK_IDS.includes(args.id), "pack_unknown");
    const previous = doc.captions.pack.id;
    const overrides = doc.captions.overrides.case === PACK_DEFAULT_CASE[previous]
      && PACK_DEFAULT_CASE[previous] !== PACK_DEFAULT_CASE[args.id]
      ? { ...doc.captions.overrides, case: PACK_DEFAULT_CASE[args.id] } : doc.captions.overrides;
    return { doc: withCaptions(doc, { pack: { id: args.id, v: 1 }, overrides }), args: { id: args.id } };
  },

  SetCaptionOverride(doc, args) {
    const rule = Object.hasOwn(CAPTION_OVERRIDE_RULES, args.key) ? CAPTION_OVERRIDE_RULES[args.key] : null;
    need(rule, "invalid_args", { arg: "key" });
    if (args.key === "y_e5" || args.key === "size_pm") need(Number.isSafeInteger(args.value), "invalid_args", { arg: "value" });
    need(rule(args.value), "value_out_of_range");
    return { doc: withCaptions(doc, { overrides: { ...doc.captions.overrides, [args.key]: args.value } }), args: { key: args.key, value: args.value } };
  },

  SetHookEnabled(doc, args, ctx) {
    const on = boolArg(args, "on");
    const current = hookItem(doc);
    if (!on) return { doc: current ? dropTrack(doc, "hook") : doc, args: { on } };
    if (current) {
      if (args.text === undefined) return { doc, args: { on } };
      const result = setHookText(doc, args, ctx);
      return { doc: result.doc, args: { on, ...result.args } };
    }
    const seedTrack = trackOf(ctx.seed, "hook");
    const seedItem = seedTrack?.items[0] ?? null;
    if (args.text === undefined) {
      need(seedItem, "text_empty");
      return { doc: putTrack(doc, seedTrack), args: { on } };
    }
    const text = textArg(args.text, LIMITS.hookText);
    const requested = originArg(args.origin, ITEM_ORIGIN_PATTERN, "user");
    const origin = hookText(ctx, text, requested);
    const used = documentIds(doc);
    const dur = seedItem?.dur_f ?? Math.min(sfFloor(30000, ctx.fps), divRoundHalfUp(DEFAULT_HOOK_MS * ctx.fps[0], 1000 * ctx.fps[1]));
    const item = {
      id: seedItem?.id && !used.has(seedItem.id) ? seedItem.id : freeId(used, TRACKS.hook.item),
      type: "hook", start: { at: "out", f: 0 }, dur_f: dur,
      transform: { x_e5: 50000, y_e5: seedItem?.transform.y_e5 ?? 13000 },
      payload: { text, design: { id: "legacy-bar", v: 1 } }, origin,
    };
    used.add(item.id);
    const track = { id: seedTrack?.id && !used.has(seedTrack.id) ? seedTrack.id : freeId(used, TRACKS.hook.track), kind: "hook", items: [item] };
    return { doc: putTrack(doc, track), args: { on, text, origin: requested } };
  },

  SetHookText(doc, args, ctx) {
    requireItem(doc, "hook", "hook_missing");
    return setHookText(doc, args, ctx);
  },

  SetHookDuration(doc, args, ctx) {
    requireItem(doc, "hook", "hook_missing");
    const dur = intArg(args, "dur_f", 15, sfFloor(30000, ctx.fps));
    return { doc: withItem(doc, "hook", () => ({ dur_f: dur })), args: { dur_f: dur } };
  },

  SetHookY(doc, args) {
    requireItem(doc, "hook", "hook_missing");
    const y = intArg(args, "y_e5", 6000, 40000);
    return { doc: withItem(doc, "hook", (item) => ({ transform: { ...item.transform, y_e5: y } })), args: { y_e5: y } };
  },

  SetLayout(doc, args) {
    need(LAYOUT_MODES.includes(args.mode), "value_out_of_range");
    return { doc: { ...doc, layout: { ...doc.layout, default: { ...doc.layout.default, mode: args.mode } } }, args: { mode: args.mode } };
  },

  SetLogo(doc, args, ctx) {
    const { id, meta } = assetArg(args.asset, args.meta, "image");
    const origin = originArg(args.origin, ITEM_ORIGIN_PATTERN, "user");
    const track = trackOf(doc, "visual");
    const current = track?.items[0] ?? null;
    const transform = fitLogo(ctx, current ? current.transform : DEFAULT_LOGO, meta);
    const used = documentIds(doc);
    const item = {
      id: current?.id ?? freeId(used, TRACKS.visual.item), type: "image", start: { at: "clip_start" }, end: { at: "clip_end" },
      transform, payload: { asset: id, mode: "free" }, origin,
    };
    const next = { id: track?.id ?? freeId(used, TRACKS.visual.track), kind: "visual", band: "over_text", role: "overlay", items: [item] };
    return { doc: syncAssets(putTrack(doc, next), { [id]: meta }), args: { asset: id, meta, origin } };
  },

  RemoveLogo(doc) {
    requireItem(doc, "visual", "logo_missing");
    return { doc: syncAssets(dropTrack(doc, "visual")), args: {} };
  },

  MoveLogo(doc, args, ctx) {
    requireItem(doc, "visual", "logo_missing");
    const x = intArg(args, "x_e5", 0, 100000);
    const y = intArg(args, "y_e5", 0, 100000);
    const item = logoItem(doc);
    need(boxInside(ctx, { ...item.transform, x_e5: x, y_e5: y }, doc.assets[item.payload.asset]), "item_out_of_frame");
    return { doc: withItem(doc, "visual", () => ({ transform: { ...item.transform, x_e5: x, y_e5: y } })), args: { x_e5: x, y_e5: y } };
  },

  ResizeLogo(doc, args, ctx) {
    requireItem(doc, "visual", "logo_missing");
    const w = intArg(args, "w_e5", 4000, 40000);
    const item = logoItem(doc);
    need(boxInside(ctx, { ...item.transform, w_e5: w }, doc.assets[item.payload.asset]), "item_out_of_frame");
    return { doc: withItem(doc, "visual", () => ({ transform: { ...item.transform, w_e5: w } })), args: { w_e5: w } };
  },

  SetLogoOpacity(doc, args) {
    requireItem(doc, "visual", "logo_missing");
    const opacity = intArg(args, "opacity_pm", 200, 1000);
    return { doc: withItem(doc, "visual", (item) => ({ transform: { ...item.transform, opacity_pm: opacity } })), args: { opacity_pm: opacity } };
  },

  SnapLogo(doc, args, ctx) {
    requireItem(doc, "visual", "logo_missing");
    need(CORNERS.includes(args.corner), "invalid_args", { arg: "corner" });
    const item = logoItem(doc);
    const meta = doc.assets[item.payload.asset];
    const [x, y] = snapTarget(ctx, item.transform, meta, args.corner);
    const position = clampPosition(ctx, meta, x, y, item.transform.w_e5);
    need(position, "item_out_of_frame");
    return {
      doc: withItem(doc, "visual", () => ({ transform: { ...item.transform, x_e5: position[0], y_e5: position[1] } })),
      args: { corner: args.corner },
    };
  },

  SetMusic(doc, args, ctx) {
    const { id, meta } = assetArg(args.asset, args.meta, "audio");
    const origin = originArg(args.origin, ITEM_ORIGIN_PATTERN, "user");
    const track = trackOf(doc, "audio");
    const used = documentIds(doc);
    const fadeMax = sfFloor(10000, ctx.fps);
    const item = {
      id: track?.items[0]?.id ?? freeId(used, TRACKS.audio.item), type: "audio", start: { at: "clip_start" }, end: { at: "clip_end" },
      payload: {
        asset: id, src_in_smp: 0, loop: true, gain_cdb: defaultMusicGain(meta.lufs_c),
        fade_in_f: Math.min(15, fadeMax), fade_out_f: Math.min(30, fadeMax), duck: { ...DEFAULT_DUCK },
      },
      origin,
    };
    const next = { id: track?.id ?? freeId(used, TRACKS.audio.track), kind: "audio", role: "music", items: [item] };
    return { doc: syncAssets(putTrack(doc, next), { [id]: meta }), args: { asset: id, meta, origin } };
  },

  RemoveMusic(doc) {
    requireItem(doc, "audio", "music_missing");
    return { doc: syncAssets(dropTrack(doc, "audio")), args: {} };
  },

  SetMusicGain(doc, args) {
    requireItem(doc, "audio", "music_missing");
    const gain = intArg(args, "gain_cdb", -4800, 600);
    return { doc: withItem(doc, "audio", (item) => ({ payload: { ...item.payload, gain_cdb: gain } })), args: { gain_cdb: gain } };
  },

  SetMusicOffset(doc, args) {
    requireItem(doc, "audio", "music_missing");
    const meta = doc.assets[musicItem(doc).payload.asset];
    const offset = intArg(args, "src_in_smp", 0, meta.duration_ms * 48 - 1);
    return { doc: withItem(doc, "audio", (item) => ({ payload: { ...item.payload, src_in_smp: offset } })), args: { src_in_smp: offset } };
  },

  SetMusicLoop(doc, args) {
    requireItem(doc, "audio", "music_missing");
    const loop = boolArg(args, "loop");
    return { doc: withItem(doc, "audio", (item) => ({ payload: { ...item.payload, loop } })), args: { loop } };
  },

  SetMusicFades(doc, args, ctx) {
    requireItem(doc, "audio", "music_missing");
    need(args.fade_in_f !== undefined || args.fade_out_f !== undefined, "invalid_args", { arg: "fade_in_f" });
    const max = sfFloor(10000, ctx.fps);
    const patch = {};
    if (args.fade_in_f !== undefined) patch.fade_in_f = intArg(args, "fade_in_f", 0, max);
    if (args.fade_out_f !== undefined) patch.fade_out_f = intArg(args, "fade_out_f", 0, max);
    return { doc: withItem(doc, "audio", (item) => ({ payload: { ...item.payload, ...patch } })), args: patch };
  },

  SetDuck(doc, args) {
    requireItem(doc, "audio", "music_missing");
    const patch = {};
    if (args.preset !== undefined) {
      need(Object.hasOwn(DUCK_PRESETS, args.preset), "invalid_args", { arg: "preset" });
      patch.on = true;
      patch.depth_cdb = DUCK_PRESETS[args.preset];
    }
    if (args.on !== undefined) patch.on = boolArg(args, "on");
    const ranges = { depth_cdb: [300, 2400], attack_ms: [5, 500], release_ms: [50, 2000], hold_ms: [0, 1000] };
    for (const [key, [lo, hi]] of Object.entries(ranges)) {
      if (args[key] !== undefined) patch[key] = intArg(args, key, lo, hi);
    }
    need(Object.keys(patch).length, "invalid_args", { arg: "duck" });
    return {
      doc: withItem(doc, "audio", (item) => ({ payload: { ...item.payload, duck: { ...item.payload.duck, ...patch } } })),
      args: args.preset !== undefined ? { preset: args.preset, ...patch } : patch,
    };
  },

  SetSourceGain(doc, args) {
    const gain = intArg(args, "gain_cdb", -2400, 1200);
    return { doc: { ...doc, audio: { ...doc.audio, source: { ...doc.audio.source, gain_cdb: gain } } }, args: { gain_cdb: gain } };
  },

  SetLoudness(doc, args) {
    need(args.mode === "off" || args.mode === "normalize", "value_out_of_range");
    const master = { ...doc.audio.master, mode: args.mode };
    if (args.target_clufs !== undefined) master.target_clufs = intArg(args, "target_clufs", -2400, -900);
    if (args.tp_cdb !== undefined) master.tp_cdb = intArg(args, "tp_cdb", -300, 0);
    const normalized = { mode: args.mode };
    if (args.target_clufs !== undefined) normalized.target_clufs = master.target_clufs;
    if (args.tp_cdb !== undefined) normalized.tp_cdb = master.tp_cdb;
    return { doc: { ...doc, audio: { ...doc.audio, master } }, args: normalized };
  },

  ResetToSeed(doc, _args, ctx) {
    const seed = ctx.seed;
    const next = {};
    for (const key of Object.keys(seed)) if (key !== "revision" && key !== "parent_sha256" && key !== "audit") next[key] = seed[key];
    next.revision = doc.revision;
    next.parent_sha256 = doc.parent_sha256;
    next.audit = { ...doc.audit, created_at_ms: seed.audit.created_at_ms };
    return { doc: next, args: {} };
  },
};

/**
 * Applies one Appendix B command. Returns `{ doc, args }` (normalised args for replay). Throws
 * `CommandRejected` when a precondition or a document rule fails; the input is never changed.
 */
export function applyCommand(doc, type, args, ctx) {
  const handler = Object.hasOwn(HANDLERS, type) ? HANDLERS[type] : null;
  if (!handler) throw new CommandRejected("unknown_command");
  const input = args === undefined ? {} : args;
  if (!(type === "SetColdOpen" && input === null)) need(input && typeof input === "object" && !Array.isArray(input), "invalid_args");
  const result = handler(doc, input, ctx);
  if (result.doc !== doc) {
    const issues = checkDoc(result.doc, ctx);
    if (issues.length) throw new CommandRejected(issues[0].code, { path: issues[0].path });
  }
  const audit = { ...result.doc.audit, editor: EDITOR_ID, last_command: type };
  return { doc: { ...result.doc, audit }, args: result.args };
}

/** Appendix B's mergeKey for a command (null: never merged). */
export function defaultMergeKey(type, args = {}) {
  switch (type) {
    case "NudgeColdOpen": return args?.edge ? `co:${args.edge}` : null;
    case "EditWordText": return args?.wordId ? `word:${args.wordId}` : null;
    case "SetCaptionOverride": return args?.key ? `cap:${args.key}` : null;
    case "SetHookEnabled": return "hook:on";
    case "SetHookText": return "hook:text";
    case "SetHookDuration": return "hook:dur";
    case "SetHookY": return "hook:y";
    case "MoveLogo": return "logo:move";
    case "ResizeLogo": return "logo:size";
    case "SetLogoOpacity": return "logo:opacity";
    case "SetMusicGain": return "music:gain";
    case "SetMusicOffset": return "music:offset";
    case "SetMusicLoop": return "music:loop";
    case "SetMusicFades": return "music:fades";
    case "SetDuck": return "music:duck";
    case "SetSourceGain": return "audio:source";
    case "SetLoudness": return "audio:master";
    default: return null;
  }
}
