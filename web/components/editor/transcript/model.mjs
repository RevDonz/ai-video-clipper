// The transcript model (plan Appendix C.2, §3.4): what every word of the analysis window looks
// like for the current document, computed locally and synchronously from the document and the
// words artifact, so a command updates the transcript at once (the plan DTO arrives later).
//
// - Word state: display text (word edits applied), hidden / emphasis / edited flags, the zone
//   relative to the body (before, body, after), the removal that cuts it, cold-open membership
//   and low ASR confidence. States that did not change are the same objects as in the previous
//   model, and so are unchanged paragraphs, so React re-renders only what changed.
// - Paragraphs: sentence units (`u`) in word order, with the removal chips placed in them.
// - The cold-open rules of §3.4 for a candidate range, and the active word at an output frame.
//
// The time map is `web/lib/editor/timemap.mjs` (T2.5), the browser mirror of
// `edit_v2/timemap.py` checked against `tests/fixtures/edit_v2/timemap-vectors.json`; this module
// re-exports the names the panels use (T3.5 took over the T2.7 copy, W2 phase-B request). All
// arithmetic stays below 2^53 for sources under 10 h.
import {
  divRoundHalfUp,
  floorDiv,
  outToSrc,
  pieces as timemapPieces,
  sfCeil,
  sfFloor,
  totalFrames,
  wordFrames,
} from "../../../lib/editor/timemap.mjs";

export { divRoundHalfUp, outToSrc, sfCeil, sfFloor, totalFrames, wordFrames };

const SECONDS = new Intl.NumberFormat("id-ID", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const LOW_CONFIDENCE_PM = 500;

// --- time map ----------------------------------------------------------------------------------

/** The source-grid frame containing a word's midpoint `(s+e)/2` (plan §3.4 visibility rule). */
export function midSf(word, [num, den]) {
  return floorDiv((word.s + word.e) * num, 2000 * den);
}

/** Pieces of `doc.main` in output order, plan DTO shape (timemap.py `pieces`). */
export function piecesOf(doc) {
  return timemapPieces(doc);
}

/** "1,4 dtk": a frame count as Indonesian seconds with one decimal. */
export function formatDuration(frames, [num, den]) {
  return `${SECONDS.format((frames * den) / num)} dtk`;
}

/** "01:12,3": an output frame as minutes, seconds and a tenth. */
export function formatClock(frames, [num, den]) {
  const tenths = Math.floor((frames * den * 10) / num);
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor((tenths % 600) / 10);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${tenths % 10}`;
}

// --- bounds ------------------------------------------------------------------------------------

const boundsCache = new WeakMap();

/** `{before, after}`: Maps from a word id to its `bounds` entry on that side (plan §3.6). */
export function boundsIndex(words) {
  if (boundsCache.has(words)) return boundsCache.get(words);
  const before = new Map();
  const after = new Map();
  for (const entry of words.bounds ?? []) {
    if (entry.before) before.set(entry.before, entry);
    if (entry.after) after.set(entry.after, entry);
  }
  const index = { before, after };
  boundsCache.set(words, index);
  return index;
}

// --- the model ---------------------------------------------------------------------------------

function containing(pieces, mid) {
  // pieces of one segment are in increasing source order
  let lo = 0;
  let hi = pieces.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (pieces[m].outSf <= mid) lo = m + 1;
    else if (pieces[m].inSf > mid) hi = m - 1;
    else return pieces[m];
  }
  return null;
}

function removalAt(removals, mid) {
  // the removal holding `mid`, else the nearest one (a sliver shorter than 2 frames joins it)
  let best = null;
  let distance = Infinity;
  for (const removal of removals) {
    if (removal.in_sf <= mid && mid < removal.out_sf) return removal.id;
    const d = mid < removal.in_sf ? removal.in_sf - mid : mid - removal.out_sf + 1;
    if (d < distance) {
      distance = d;
      best = removal.id;
    }
  }
  return best;
}

const STATE_KEYS = ["text", "asr", "edited", "hidden", "emphasis", "zone", "removal", "coRemoval", "cold", "lowConf"];

function sameState(a, b) {
  if (!a || !b) return false;
  for (const key of STATE_KEYS) if (a[key] !== b[key]) return false;
  return true;
}

function paragraphRanges(list) {
  const ranges = [];
  for (let i = 0; i < list.length; i += 1) {
    const unit = list[i].u ?? null;
    if (ranges.length && ranges.at(-1).unit === unit) ranges.at(-1).end = i + 1;
    else ranges.push({ unit, start: i, end: i + 1 });
  }
  return ranges;
}

const rangesCache = new WeakMap();

/**
 * The transcript model of `doc` over the words artifact `words`. Pass the previous model to
 * reuse unchanged word states and paragraphs.
 */
export function buildTranscriptModel(words, doc, previous = null) {
  const fps = doc.output.fps;
  const list = words.words;
  const pieces = piecesOf(doc);
  const body = doc.main.segments.find((segment) => segment.role === "body") ?? null;
  const coldOpen = doc.main.segments.find((segment) => segment.role === "cold_open") ?? null;
  const bodyPieces = body ? pieces.filter((piece) => piece.seg === body.id) : [];
  const coPieces = coldOpen ? pieces.filter((piece) => piece.seg === coldOpen.id) : [];
  const bodyRemovals = body ? (doc.main.removals ?? []).filter((removal) => removal.seg === body.id) : [];
  const coRemovals = coldOpen ? (doc.main.removals ?? []).filter((removal) => removal.seg === coldOpen.id) : [];
  const edits = doc.captions?.word_edits ?? {};
  const reuse = previous && previous.words === words ? previous : null;
  const mids = reuse ? reuse.mids : list.map((word) => midSf(word, fps));

  const states = new Array(list.length);
  const firstWordOf = new Map();
  let firstBody = -1;
  let lastBody = -1;
  for (let i = 0; i < list.length; i += 1) {
    const word = list[i];
    const mid = mids[i];
    const edit = edits[word.id];
    const zone = !body || mid < body.in_sf ? "before" : mid >= body.out_sf ? "after" : "body";
    let removal = null;
    if (zone === "body" && !containing(bodyPieces, mid)) removal = removalAt(bodyRemovals, mid) ?? "sliver";
    let cold = false;
    let coRemoval = null;
    if (coldOpen && coldOpen.in_sf <= mid && mid < coldOpen.out_sf) {
      cold = containing(coPieces, mid) !== null;
      if (!cold) coRemoval = removalAt(coRemovals, mid) ?? "sliver";
    }
    const text = edit?.text ?? word.t;
    const state = {
      i, id: word.id, text, asr: word.t, edited: text !== word.t, hidden: Boolean(edit?.hidden), emphasis: Boolean(edit?.emphasis),
      zone, removal, coRemoval, cold, lowConf: word.p_pm !== null && word.p_pm !== undefined && word.p_pm < LOW_CONFIDENCE_PM,
    };
    const old = reuse?.states[i];
    states[i] = old && old.id === word.id && sameState(old, state) ? old : state;
    for (const id of [removal, coRemoval]) if (id !== null && !firstWordOf.has(id)) firstWordOf.set(id, i);
    if (zone === "body" && removal === null) {
      if (firstBody < 0) firstBody = i;
      lastBody = i;
    }
  }

  // Removal chips, each placed before the first word it cuts (or where it starts).
  const chips = [];
  for (const removal of [...bodyRemovals, ...coRemovals]) {
    const key = removal.seg === body?.id ? "removal" : "coRemoval";
    let before = firstWordOf.get(removal.id) ?? -1;
    if (before < 0) {
      before = mids.findIndex((mid) => mid >= removal.in_sf);
      if (before < 0) before = list.length;
    }
    const frames = removal.out_sf - removal.in_sf;
    chips.push({ removalId: removal.id, seg: removal.seg, cold: key === "coRemoval", before, frames,
      label: `⋯ ${formatDuration(frames, fps)}` });
  }
  chips.sort((a, b) => a.before - b.before || Number(a.cold) - Number(b.cold));

  if (!rangesCache.has(words)) rangesCache.set(words, paragraphRanges(list));
  const ranges = rangesCache.get(words);
  const paragraphs = ranges.map((range, p) => {
    const isLast = p === ranges.length - 1;
    const paraChips = chips.filter((chip) => chip.before >= range.start && (chip.before < range.end || (isLast && chip.before === range.end)));
    let zone = null;
    let cold = false;
    for (let i = range.start; i < range.end; i += 1) {
      zone = zone === null || zone === states[i].zone ? states[i].zone : "mixed";
      cold ||= states[i].cold || states[i].coRemoval !== null;
    }
    const old = reuse?.paragraphs[p];
    const same = old && old.start === range.start && old.end === range.end && old.zone === zone && old.cold === cold
      && old.chips.length === paraChips.length
      && old.chips.every((chip, k) => chip.removalId === paraChips[k].removalId && chip.before === paraChips[k].before && chip.label === paraChips[k].label)
      && states.slice(range.start, range.end).every((state, k) => state === old.states[k]);
    if (same) return old;
    return { key: `${range.unit ?? "u"}:${range.start}`, unit: range.unit, start: range.start, end: range.end, zone, cold,
      states: states.slice(range.start, range.end), chips: paraChips };
  });

  return { words, doc, fps, pieces, bodyPieces, coPieces, body, coldOpen, mids, states, paragraphs, chips, firstBody, lastBody,
    total: totalFrames(pieces), bounds: boundsIndex(words) };
}

// --- cold open ---------------------------------------------------------------------------------

const REASONS = {
  empty: () => "Pilih kata di Transkrip dulu",
  too_short: (frames, fps) => `Cold open minimal 0,5 dtk (pilihan ${formatDuration(frames, fps)})`,
  too_long: (frames, fps) => `Cold open maksimal 8 dtk (pilihan ${formatDuration(frames, fps)})`,
  repeats_opening: () => "Cold open ini hanya mengulang awal klip",
  no_word: () => "Tidak ada kata lagi di arah ini",
};

/**
 * The §3.4 cold-open rules for the words `[first, last]` snapped through `bounds` (the frames
 * SetColdOpen would store): `{ok, code, reason, inSf, outSf, frames}`.
 */
export function coldOpenCheck(model, first, last) {
  const list = model.words.words;
  if (!(first >= 0 && last >= first && last < list.length)) return { ok: false, code: "empty", reason: REASONS.empty() };
  const fps = model.fps;
  const inSf = model.bounds.before.get(list[first].id)?.sf;
  const outSf = model.bounds.after.get(list[last].id)?.sf;
  if (inSf === undefined || outSf === undefined || outSf <= inSf) return { ok: false, code: "empty", reason: REASONS.empty() };
  const frames = outSf - inSf;
  const result = { inSf, outSf, frames };
  if (frames < sfCeil(500, fps)) return { ...result, ok: false, code: "too_short", reason: REASONS.too_short(frames, fps) };
  if (frames > sfFloor(8000, fps)) return { ...result, ok: false, code: "too_long", reason: REASONS.too_long(frames, fps) };
  const body = model.body;
  if (body) {
    const [num, den] = fps;
    // More than 80% inside [body.in, body.in + L + 2 s): it only repeats the opening (§3.4).
    const end = (body.in_sf + frames) * den + 2 * num;
    const overlap = Math.max(0, Math.min(outSf * den, end) - Math.max(inSf, body.in_sf) * den);
    if (inSf === body.in_sf || 5 * overlap > 4 * frames * den) {
      return { ...result, ok: false, code: "repeats_opening", reason: REASONS.repeats_opening() };
    }
  }
  return { ...result, ok: true, code: null, reason: null };
}

/**
 * The current cold open: its words, text, length and the four one-word nudges with their
 * availability, or null without a cold open.
 */
export function coldOpenInfo(model) {
  if (!model.coldOpen) return null;
  let firstIndex = -1;
  let lastIndex = -1;
  for (const state of model.states) {
    if (!state.cold && state.coRemoval === null) continue;
    if (firstIndex < 0) firstIndex = state.i;
    lastIndex = state.i;
  }
  const frames = model.coPieces.reduce((sum, piece) => sum + piece.frames, 0);
  const text = firstIndex < 0 ? "" : model.states.slice(firstIndex, lastIndex + 1)
    .filter((state) => state.cold).map((state) => state.text).join(" ");
  const nudge = (first, last) => {
    if (firstIndex < 0 || first < 0 || last >= model.states.length) return { ok: false, reason: REASONS.no_word() };
    const check = coldOpenCheck(model, first, last);
    return { ok: check.ok, reason: check.reason };
  };
  return {
    segment: model.coldOpen, firstIndex, lastIndex, frames, text,
    nudges: {
      inEarlier: nudge(firstIndex - 1, lastIndex), inLater: nudge(firstIndex + 1, lastIndex),
      outEarlier: nudge(firstIndex, lastIndex - 1), outLater: nudge(firstIndex, lastIndex + 1),
    },
  };
}

// --- playback ----------------------------------------------------------------------------------

/** The output frame to seek to for word `index` (its body occurrence first), or null. */
export function seekFrameOf(model, index) {
  const word = model.words.words[index];
  if (!word) return null;
  const frames = wordFrames(word.s, word.e, model.bodyPieces, model.fps) ?? wordFrames(word.s, word.e, model.coPieces, model.fps);
  return frames ? frames[0] : null;
}

/**
 * The word shown at output frame n (its output frames hold n), or -1. In a short pause (under
 * 300 ms) the word just spoken stays active, so the highlight does not flicker between words.
 */
export function activeWordAt(model, n) {
  if (!Number.isInteger(n) || n < 0 || n >= model.total) return -1;
  const [piece, sf] = outToSrc(n, model.pieces);
  const [num, den] = model.fps;
  const list = model.words.words;
  // last word starting before the end of frame sf
  const endMs = ((sf + 1) * 1000 * den) / num;
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (list[m].s < endMs) {
      found = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  const hold = Math.ceil((300 * num) / (1000 * den));
  let recent = -1;
  let recentOff = -Infinity;
  for (let i = found; i >= 0 && i > found - 4; i -= 1) {
    const frames = wordFrames(list[i].s, list[i].e, [piece], model.fps);
    if (!frames) continue;
    if (frames[0] <= n && n < frames[1]) return i;
    if (frames[1] <= n && frames[1] > recentOff) {
      recent = i;
      recentOff = frames[1];
    }
  }
  return recent >= 0 && n - recentOff < hold ? recent : -1;
}
