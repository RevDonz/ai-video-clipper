// The Rapikan review model (plan §7.3, T3.5): which items of the review list apply to the
// current document, what the transcript marks, what "Terapkan (n)" dispatches and what "Putar"
// plays. Pure and synchronous, like model.mjs; the panel memoises it per document.
//
// - The list comes from GET …/cleanup (edit_v2/cleanup.py; immutable per words and lexicon) or
//   the fakes; `normalizeListing` keeps the fields `ApplyCleanup` takes (CONTRACTS §5.17).
// - An item is shown when all its words (or both words around its gap) are visible in the clip
//   and it applies alone to the current document with the real Appendix B command; an item
//   already applied (a removal with origin `suggestion:<id>`) is counted, not shown. Voiced gaps
//   are shown for audition only (not checkable: shortening them is Stage 2).
// - `planApply` replays the checked items one by one on the current document, in transcript
//   order, so the single `ApplyCleanup` it returns always succeeds; an item another checked item
//   already covers ("nothing_to_remove") or that no longer fits is skipped with its reason.
import { CommandRejected, applyCommand, commandMessage } from "../../../lib/editor/commands.mjs";
import { wordStatus } from "../../../lib/editor/doc-model.mjs";
import { sfCeil, sfFloor } from "./model.mjs";

export const KIND_ORDER = Object.freeze(["filler", "repeat", "gap_silent", "gap_voiced"]);
export const KIND_LABELS = Object.freeze({
  filler: "Kata pengisi", repeat: "Pengulangan", gap_silent: "Jeda hening", gap_voiced: "Jeda bersuara",
});
export const SKIP_MESSAGES = Object.freeze({
  nothing_to_remove: "Sudah ikut terpotong oleh saran lain.",
  range_empty: "Sudah ikut terpotong oleh saran lain.",
});

const ITEM_ID = /^[a-z]{2,3}_[0-9a-z]{1,16}$/;
const WORD_ID = /^w[0-9]{6,7}$/;
const CONTEXT_WORDS = 3;
const AUDITION_LEAD_MS = 800;
const SUGGESTION = "suggestion:";

const isInt = (value) => Number.isSafeInteger(value) && value >= 0;
const wordList = (value) => Array.isArray(value) && value.length > 0 && value.every((id) => typeof id === "string" && WORD_ID.test(id));

function normalizeItem(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !ITEM_ID.test(raw.id) || !KIND_ORDER.includes(raw.kind)) return null;
  const item = { id: raw.id, kind: raw.kind, defaultOn: typeof raw.defaultOn === "boolean" ? raw.defaultOn : raw.kind === "gap_silent" };
  if (isInt(raw.s) && isInt(raw.e)) Object.assign(item, { s: raw.s, e: raw.e });
  if (raw.kind === "filler" || raw.kind === "repeat") {
    if (!wordList(raw.wordIds)) return null;
    item.wordIds = [...raw.wordIds];
    item.repeatOf = wordList(raw.repeatOf) ? [...raw.repeatOf] : [];
    return item;
  }
  if (typeof raw.afterWord !== "string" || !WORD_ID.test(raw.afterWord)) return null;
  item.afterWord = raw.afterWord;
  if (raw.kind === "gap_voiced") return { ...item, defaultOn: false };
  if (!isInt(raw.inSf) || !isInt(raw.outSf) || raw.inSf >= raw.outSf) return null;
  return { ...item, inSf: raw.inSf, outSf: raw.outSf };
}

/** `{ok, items, locked, precheck, missing}` from the route DTO or the fakes' `{items}`. */
export function normalizeListing(listing) {
  if (!listing || typeof listing !== "object" || !Array.isArray(listing.items)) {
    return { ok: false, items: [], locked: [], precheck: false, missing: [] };
  }
  const items = [];
  const seen = new Set();
  for (const raw of listing.items) {
    const item = normalizeItem(raw);
    if (item && !seen.has(item.id)) {
      seen.add(item.id);
      items.push(item);
    }
  }
  return {
    ok: true, items,
    locked: Array.isArray(listing.locked) ? listing.locked : [],
    precheck: listing.fillerPrecheck === true,
    missing: Array.isArray(listing.missing) ? listing.missing.filter((name) => typeof name === "string") : [],
  };
}

/** The `ApplyCleanup` item of a review item (CONTRACTS §5.17). */
export function commandItem(item) {
  return item.kind === "gap_silent"
    ? { id: item.id, kind: item.kind, afterWord: item.afterWord, inSf: item.inSf, outSf: item.outSf }
    : { id: item.id, kind: item.kind, wordIds: [...item.wordIds] };
}

function appliedIds(doc) {
  const ids = new Set();
  for (const removal of doc.main.removals ?? []) {
    if (typeof removal.origin === "string" && removal.origin.startsWith(SUGGESTION)) ids.add(removal.origin.slice(SUGGESTION.length));
  }
  return ids;
}

function tryAlone(doc, item, ctx) {
  try {
    applyCommand(doc, "ApplyCleanup", { items: [commandItem(item)] }, ctx);
    return null;
  } catch (error) {
    if (error instanceof CommandRejected) return error.code;
    throw error;
  }
}

function displayText(doc, word) {
  return doc.captions?.word_edits?.[word.id]?.text ?? word.t;
}

function textOf(doc, list, from, to) {
  const parts = [];
  for (let i = Math.max(0, from); i < Math.min(list.length, to); i += 1) parts.push(displayText(doc, list[i]));
  return parts.join(" ");
}

/**
 * The review of `listing` on `doc`: `{ok, entries, hidden: {applied, removed, outside, blocked},
 * counts, locked, missing, precheck}`. Each entry: `{id, kind, item, status: "open"|"listen",
 * checkable, defaultOn, wordIdx, keepIdx, afterIdx, beforeIdx, s, e, durationMs, keptMs,
 * context: {before, removed, kept, after}}` in transcript order.
 */
export function cleanupView({ listing, doc, words, ctx }) {
  const list = normalizeListing(listing);
  const view = {
    ok: list.ok, entries: [], hidden: { applied: 0, removed: 0, outside: 0, blocked: 0 },
    counts: Object.fromEntries(KIND_ORDER.map((kind) => [kind, 0])), locked: list.locked.length,
    lockedBy: {
      laughter: list.locked.filter((entry) => entry.reason === "laughter").length,
      no_quiet_cut: list.locked.filter((entry) => entry.reason === "no_quiet_cut").length,
    },
    missing: list.missing, precheck: list.precheck,
  };
  if (!list.ok || !doc || !words?.words) return view;
  const all = words.words;
  const index = new Map(all.map((word, i) => [word.id, i]));
  const status = wordStatus(doc, ctx);
  const applied = appliedIds(doc);
  // Touching cuts merge into one removal that keeps the last item's origin (Appendix B), so an
  // item also counts as applied when a Rapikan removal covers it.
  const suggested = (doc.main.removals ?? []).filter((removal) => removal.origin?.startsWith(SUGGESTION));
  const suggestedIds = new Set(suggested.map((removal) => removal.id));
  const [num, den] = ctx.fps;
  const frameMs = (sf) => (sf * 1000 * den) / num;
  for (const item of list.items) {
    const covered = item.wordIds
      ? item.wordIds.every((id) => suggestedIds.has(status.get(id)?.removal))
      : item.kind === "gap_silent" && suggested.some((removal) => removal.in_sf <= item.inSf && removal.out_sf >= item.outSf);
    if (applied.has(item.id) || covered) {
      view.hidden.applied += 1;
      continue;
    }
    const base = { id: item.id, kind: item.kind, defaultOn: item.defaultOn, wordIdx: [], keepIdx: [], afterIdx: -1, beforeIdx: -1 };
    let entry;
    if (item.wordIds) {
      const wordIdx = item.wordIds.map((id) => index.get(id));
      const keepIdx = item.repeatOf.map((id) => index.get(id)).filter((i) => i !== undefined);
      if (wordIdx.some((i) => i === undefined)) {
        view.hidden.outside += 1;
        continue;
      }
      const states = wordIdx.map((i) => status.get(all[i].id));
      if (states.every((state) => state.removal)) {
        view.hidden.removed += 1;
        continue;
      }
      if (states.some((state) => !state.visibleIn || state.removal)) {
        view.hidden.outside += 1;
        continue;
      }
      const first = wordIdx[0];
      const last = wordIdx.at(-1);
      const tail = keepIdx.length ? Math.max(last, keepIdx.at(-1)) : last;
      entry = {
        ...base, wordIdx, keepIdx, s: all[first].s, e: all[last].e, playEnd: all[tail].e,
        durationMs: all[last].e - all[first].s, keptMs: null,
        context: {
          before: textOf(doc, all, first - CONTEXT_WORDS, first), removed: textOf(doc, all, first, last + 1),
          kept: keepIdx.length ? textOf(doc, all, keepIdx[0], keepIdx.at(-1) + 1) : "",
          after: textOf(doc, all, tail + 1, tail + 1 + CONTEXT_WORDS),
        },
      };
    } else {
      const afterIdx = index.get(item.afterWord);
      if (afterIdx === undefined || afterIdx + 1 >= all.length) {
        view.hidden.outside += 1;
        continue;
      }
      // A gap at a clip edge has one neighbour outside the clip; it still counts when its cut
      // lies in the clip (the command below decides), but not when a neighbour was cut.
      const left = status.get(all[afterIdx].id);
      const right = status.get(all[afterIdx + 1].id);
      if ((!left.visibleIn && !right.visibleIn) || left.removal || right.removal
        || (left.visibleIn && right.visibleIn && left.visibleIn !== right.visibleIn)) {
        view.hidden.outside += 1;
        continue;
      }
      if (item.kind === "gap_voiced" && !(left.visibleIn && right.visibleIn)) {
        view.hidden.outside += 1;
        continue;
      }
      const s = item.s ?? all[afterIdx].e;
      const e = item.e ?? all[afterIdx + 1].s;
      entry = {
        ...base, afterIdx, beforeIdx: afterIdx + 1, s, e, playEnd: e, durationMs: e - s,
        keptMs: item.kind === "gap_silent" ? Math.round(frameMs(item.inSf) - s + (e - frameMs(item.outSf))) : null,
        context: {
          before: textOf(doc, all, afterIdx + 1 - CONTEXT_WORDS, afterIdx + 1), removed: "", kept: "",
          after: textOf(doc, all, afterIdx + 1, afterIdx + 1 + CONTEXT_WORDS),
        },
      };
    }
    if (item.kind === "gap_voiced") {
      view.entries.push({ ...entry, item: null, status: "listen", checkable: false, defaultOn: false });
      view.counts.gap_voiced += 1;
      continue;
    }
    const code = tryAlone(doc, item, ctx);
    if (code) {
      if (code === "nothing_to_remove" || code === "range_empty") view.hidden.removed += 1;
      else view.hidden.blocked += 1;
      continue;
    }
    view.entries.push({ ...entry, item: commandItem(item), status: "open", checkable: true });
    view.counts[item.kind] += 1;
  }
  view.entries.sort((a, b) => a.s - b.s || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  return view;
}

/** The ids checked by default: checkable items whose `defaultOn` is set. */
export function defaultChecked(view) {
  return new Set(view.entries.filter((entry) => entry.checkable && entry.defaultOn).map((entry) => entry.id));
}

/**
 * The `ApplyCleanup` args of the checked entries: each is replayed on the running document in
 * transcript order; one that no longer applies is skipped with `{id, code, message}`.
 */
export function planApply({ view, checked, doc, ctx }) {
  let current = doc;
  const items = [];
  const skipped = [];
  for (const entry of view.entries) {
    if (!entry.checkable || !checked.has(entry.id)) continue;
    try {
      current = applyCommand(current, "ApplyCleanup", { items: [entry.item] }, ctx).doc;
      items.push(entry.item);
    } catch (error) {
      if (!(error instanceof CommandRejected)) throw error;
      skipped.push({ id: entry.id, code: error.code, message: SKIP_MESSAGES[error.code] ?? commandMessage(error.code) });
    }
  }
  return { args: { items }, skipped };
}

/** `{words: Map(word index → kind), gaps: Map(index of the word before the gap → kind)}`. */
export function badgeMarks(view) {
  const words = new Map();
  const gaps = new Map();
  for (const entry of view.entries) {
    if (entry.wordIdx.length) for (const index of entry.wordIdx) words.set(index, entry.kind);
    else gaps.set(entry.afterIdx, entry.kind);
  }
  return { words, gaps };
}

// Output frames `[a, b]` of the source span `[sMs, eMs]` in one segment's pieces (in source
// order), clamped to the pieces it overlaps; null when it overlaps none.
function spanFrames(sMs, eMs, pieces, [num, den]) {
  const lo = sfFloor(sMs, [num, den]);
  const hi = sfCeil(eMs, [num, den]);
  let a = null;
  let b = null;
  for (const piece of pieces) {
    if (piece.outSf <= lo || piece.inSf >= hi) continue;
    if (a === null) a = piece.outF0 + Math.max(0, lo - piece.inSf);
    b = piece.outF0 + Math.min(piece.frames, hi - piece.inSf);
  }
  return a === null ? null : [a, b];
}

/**
 * The output frames `{from, to}` to play for an entry: its words (with the kept occurrence of a
 * repeat) or its gap, with 0.8 s before and after, clamped to the clip; the body occurrence
 * first, then the cold open. Null when the entry is not on the timeline.
 */
export function auditionRange(entry, model) {
  const span = spanFrames(entry.s, entry.playEnd ?? entry.e, model.bodyPieces, model.fps)
    ?? spanFrames(entry.s, entry.playEnd ?? entry.e, model.coPieces, model.fps);
  if (!span) return null;
  const [num, den] = model.fps;
  const lead = Math.round((AUDITION_LEAD_MS * num) / (1000 * den));
  const from = Math.max(0, span[0] - lead);
  const to = Math.min(model.total, span[1] + lead);
  return from < to ? { from, to } : null;
}
