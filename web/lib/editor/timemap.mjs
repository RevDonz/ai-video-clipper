// Integer time map of clip-edit-v2 documents: the browser mirror of
// src/ai_clipper/edit_v2/timemap.py (plan §3.4, Appendix A.2, CONTRACTS §5.10). Both are checked
// against tests/fixtures/edit_v2/timemap-vectors.json.
//
// Units: `Sf` is a source-grid frame at the output rate, `F`/`n` an output frame, `Ms` source
// milliseconds, samples are 48 kHz unless `rate` says otherwise. `fps` is `[num, den]` (the
// document form) or `{ num, den }`. All arithmetic is exact on integers below 2^53 (true for any
// clip under 10 h at 30 fps); the only floating-point function is `nowMs`, which reproduces
// FFmpeg's `vf_subtitles` double expression on purpose.
//
// Pieces use the plan DTO names: `{ i, seg, role, inSf, outSf, outF0, frames }`.

export const SAMPLE_RATE = 48000;
export const MIN_PIECE_FRAMES = 2; // a remaining sub-range shorter than this joins the adjacent cut

function integer(value, name) {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be an integer`);
  return value;
}

function rate(fps) {
  const [num, den] = Array.isArray(fps) ? fps : [fps?.num, fps?.den];
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den)) throw new TypeError("fps must be [num, den]");
  if (num <= 0 || den <= 0) throw new RangeError("fps must be positive");
  return [num, den];
}

/** Exact ⌊a / b⌋ for safe integers (b > 0): float division, then corrected by one if needed. */
export function floorDiv(a, b) {
  let q = Math.floor(a / b);
  while (q * b > a) q -= 1;
  while ((q + 1) * b <= a) q += 1;
  return q;
}

/** round_half_up(numerator / denominator) for integers; halves round toward +∞. */
export function divRoundHalfUp(numerator, denominator) {
  integer(numerator, "numerator");
  if (integer(denominator, "denominator") <= 0) throw new RangeError("denominator must be positive");
  return floorDiv(2 * numerator + denominator, 2 * denominator);
}

function keptRanges(inSf, outSf, cuts) {
  const kept = [];
  let cursor = inSf;
  for (const [cutStart, cutEnd] of [...cuts].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const start = Math.max(cutStart, inSf);
    const end = Math.min(cutEnd, outSf);
    if (start >= end) continue;
    if (start > cursor) kept.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < outSf) kept.push([cursor, outSf]);
  return kept.filter(([start, end]) => end - start >= MIN_PIECE_FRAMES);
}

/**
 * Pieces of `doc.main` in output order: for each segment `[in_sf, out_sf)` minus the union of
 * its removals, sub-ranges under two frames dropped, laid out back to back from frame 0.
 * Removals naming another segment are ignored (the validator reports them).
 */
export function pieces(doc) {
  const main = doc.main;
  const cuts = new Map();
  for (const removal of main.removals ?? []) {
    const start = integer(removal.in_sf, "removal in_sf");
    const end = integer(removal.out_sf, "removal out_sf");
    if (end <= start) throw new RangeError("removal must satisfy in_sf < out_sf");
    if (!cuts.has(removal.seg)) cuts.set(removal.seg, []);
    cuts.get(removal.seg).push([start, end]);
  }
  const result = [];
  let outF0 = 0;
  for (const segment of main.segments) {
    const inSf = integer(segment.in_sf, "segment in_sf");
    const outSf = integer(segment.out_sf, "segment out_sf");
    if (inSf < 0 || outSf <= inSf) throw new RangeError("segment must satisfy 0 <= in_sf < out_sf");
    for (const [start, end] of keptRanges(inSf, outSf, cuts.get(segment.id) ?? [])) {
      const frames = end - start;
      result.push({ i: result.length, seg: segment.id, role: segment.role, inSf: start, outSf: end, outF0, frames });
      outF0 += frames;
    }
  }
  return result;
}

/** Output length in frames: the sum of the piece lengths. */
export function totalFrames(list) {
  let total = 0;
  for (const piece of list) total += piece.frames;
  return total;
}

/** First sample of output frame n: ⌊n·rate·den / num⌋ (1601/1602 at 29.97, no drift). */
export function smp(n, fps, sampleRate = SAMPLE_RATE) {
  const [num, den] = rate(fps);
  return floorDiv(integer(n, "n") * integer(sampleRate, "rate") * den, num);
}

/** The source-grid frame containing millisecond ms: ⌊ms·num / (1000·den)⌋. */
export function sfFloor(ms, fps) {
  const [num, den] = rate(fps);
  return floorDiv(integer(ms, "ms") * num, 1000 * den);
}

/** ⌈ms·num / (1000·den)⌉: the first frame boundary at or after ms. */
export function sfCeil(ms, fps) {
  const [num, den] = rate(fps);
  return -floorDiv(-integer(ms, "ms") * num, 1000 * den);
}

function lastAtOrBefore(values, target) {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

// Pieces arrays are treated as immutable; their lookup structures are cached per array.
const indexCache = new WeakMap();

function indexOf(list) {
  let index = indexCache.get(list);
  if (index) return index;
  const runs = [];
  for (const piece of list) {
    const last = runs.at(-1);
    if (last && last.pieces.at(-1).outSf <= piece.inSf) {
      last.starts.push(piece.inSf);
      last.pieces.push(piece);
    } else {
      runs.push({ starts: [piece.inSf], pieces: [piece] });
    }
  }
  index = { outStarts: list.map((piece) => piece.outF0), runs };
  indexCache.set(list, index);
  return index;
}

/** `[piece, sf]`: the piece showing output frame n and the source-grid frame it shows. */
export function outToSrc(n, list) {
  const total = list.length ? list.at(-1).outF0 + list.at(-1).frames : 0;
  if (integer(n, "n") < 0 || n >= total) throw new RangeError("output frame outside the clip");
  const piece = list[lastAtOrBefore(indexOf(list).outStarts, n)];
  return [piece, piece.inSf + (n - piece.outF0)];
}

/** The output frame showing source-grid frame sf in the first piece (output order) holding it, or null. */
export function srcToOut(sf, list) {
  integer(sf, "sf");
  for (const run of indexOf(list).runs) {
    const position = lastAtOrBefore(run.starts, sf);
    if (position < 0) continue;
    const piece = run.pieces[position];
    if (sf < piece.outSf) return piece.outF0 + (sf - piece.inSf);
  }
  return null;
}

/**
 * Output frames `[nOn, nOff]` of a word, or null when it is not visible (plan §3.4): the first
 * piece (output order) whose source span contains the midpoint (s+e)/2; both frames clamped to
 * the piece and nOff >= nOn. Pass one segment's pieces to get that segment's occurrence.
 */
export function wordFrames(sMs, eMs, list, fps) {
  const [num, den] = rate(fps);
  if (integer(eMs, "e_ms") < integer(sMs, "s_ms")) throw new RangeError("word must satisfy s_ms <= e_ms");
  const scale = 1000 * den;
  const midSf = floorDiv((sMs + eMs) * num, 2 * scale);
  for (const run of indexOf(list).runs) {
    const position = lastAtOrBefore(run.starts, midSf);
    if (position < 0 || midSf >= run.pieces[position].outSf) continue;
    const piece = run.pieces[position];
    const base = piece.inSf * scale;
    const last = piece.outF0 + piece.frames;
    let on = piece.outF0 + divRoundHalfUp(sMs * num - base, scale);
    let off = piece.outF0 + divRoundHalfUp(eMs * num - base, scale);
    on = Math.min(Math.max(on, piece.outF0), last);
    off = Math.max(Math.min(Math.max(off, piece.outF0), last), on);
    return [on, off];
  }
  return null;
}

/**
 * Output sample spans `[smp(nOn), smp(nOff))` of every kept word occurrence, per segment (a word
 * shown in the cold open and the body yields two spans); empty spans dropped; sorted, not merged.
 */
export function speechSpans(words, list, fps, sampleRate = SAMPLE_RATE) {
  const groups = new Map();
  for (const piece of list) {
    if (!groups.has(piece.seg)) groups.set(piece.seg, []);
    groups.get(piece.seg).push(piece);
  }
  const spans = [];
  for (const group of groups.values()) {
    for (const [sMs, eMs] of words) {
      const frames = wordFrames(sMs, eMs, group, fps);
      if (frames && frames[1] > frames[0]) spans.push([smp(frames[0], fps, sampleRate), smp(frames[1], fps, sampleRate)]);
    }
  }
  return spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/** The time libass sees for output frame n inside FFmpeg: trunc(n · (den/num) · 1000) in doubles. */
export function nowMs(n, fps) {
  const [num, den] = rate(fps);
  return Math.trunc(integer(n, "n") * (den / num) * 1000);
}

/** Frame-safe ASS centisecond for "visible from frame n": ⌊(nowMs(n) − 2) / 10⌋. */
export function safeCs(n, fps) {
  return Math.floor((nowMs(n, fps) - 2) / 10);
}

/** Plate cell length: 2·⌈num/den⌉ frames (60 at 29.97 and 30, 50 at 25, 48 at 24). */
export function cellFrames(fps) {
  const [num, den] = rate(fps);
  return 2 * -floorDiv(-num, den);
}

/**
 * Integer logo box `[x0, y0, wPx, hPx]` in output pixels (plan §3.4 "Logo box"); the box may lie
 * partly outside the frame (the validator reports item_out_of_frame).
 */
export function logoBox({ x_e5: x, y_e5: y, w_e5: w, asset_w: assetW, asset_h: assetH, out_w: outW, out_h: outH }) {
  for (const [name, value] of [["asset_w", assetW], ["asset_h", assetH], ["out_w", outW], ["out_h", outH]]) {
    if (integer(value, name) <= 0) throw new RangeError(`${name} must be positive`);
  }
  for (const [name, value] of [["x_e5", x], ["y_e5", y], ["w_e5", w]]) integer(value, name);
  const wPx = divRoundHalfUp(w * outW, 100000);
  const hPx = divRoundHalfUp(wPx * assetH, assetW);
  const x0 = divRoundHalfUp(2 * x * outW - wPx * 100000, 200000);
  const y0 = divRoundHalfUp(2 * y * outH - hPx * 100000, 200000);
  return [x0, y0, wPx, hPx];
}
