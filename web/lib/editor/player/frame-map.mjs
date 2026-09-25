// Frame mapping of the editor player (plan §6.2 "Plate source", §3.4). Pure functions over the
// plan DTO's pieces (§4.3 names: inSf, outSf, outF0, frames):
//
//   output frame n → piece (binary search on outF0) → source-grid frame sf = inSf + (n − outF0)
//   → plate cell k = ⌊sf / cellFrames⌋, index j = sf mod cellFrames
//   → the decoded sample at (j + 0.5)·den/num inside the cell (cells restart at t = 0).
//
// The decode-ahead schedule follows the output order, so the frames after a cut (a jump to any
// source position) are requested as soon as the cut enters the look-ahead window, i.e. at least
// `aheadFrames` before it is shown (plan: pre-rolled ≥ 500 ms before every cut).
//
// All arithmetic is exact on integers below 2^53 (10 h at 60 fps is 2.2e6 frames; smp needs
// n·48000·den < 2^53, true below 1.8e8 frames).

export function fpsParts(fps) {
  const [num, den] = Array.isArray(fps) ? fps : [fps?.num, fps?.den];
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || num <= 0 || den <= 0) {
    throw new TypeError("fps must be [num, den] with positive integers");
  }
  return [num, den];
}

/** Σ frames of the pieces (the clip length in output frames). */
export function totalFrames(pieces) {
  let total = 0;
  for (const piece of pieces) total += piece.frames;
  return total;
}

/** Position of the piece holding output frame n (pieces sorted by outF0), or −1. */
export function pieceIndexAt(pieces, n) {
  if (!Number.isInteger(n) || n < 0 || !pieces.length) return -1;
  let lo = 0;
  let hi = pieces.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pieces[mid].outF0 <= n) lo = mid;
    else hi = mid - 1;
  }
  const piece = pieces[lo];
  return n >= piece.outF0 && n < piece.outF0 + piece.frames ? lo : -1;
}

/** `{ i, sf }` of output frame n (i = the piece's own `i`), or null outside the clip. */
export function outToSrc(pieces, n) {
  const index = pieceIndexAt(pieces, n);
  if (index < 0) return null;
  const piece = pieces[index];
  return { i: piece.i, sf: piece.inSf + (n - piece.outF0) };
}

/** timemap.cell_frames: 2·⌈num/den⌉ (60 at 29.97 and 30, 50 at 25, 48 at 24 and 23.976). */
export function cellFramesFor(fps) {
  const [num, den] = fpsParts(fps);
  return 2 * Math.ceil(num / den);
}

export function cellOf(sf, cellFrames) {
  return { k: Math.floor(sf / cellFrames), j: sf % cellFrames };
}

/** The media time (s) inside a cell at which frame j is fetched: the middle of the frame. */
export function sampleTimestamp(j, fps) {
  const [num, den] = fpsParts(fps);
  return ((j + 0.5) * den) / num;
}

/** The frame index inside a cell of a decoded sample with media time `seconds`. */
export function sampleIndex(seconds, fps) {
  const [num, den] = fpsParts(fps);
  return Math.floor((seconds * num) / den + 0.25);
}

/** Start time (s) of output frame n: n·den/num. */
export function frameStart(n, fps) {
  const [num, den] = fpsParts(fps);
  return (n * den) / num;
}

/** The output frame whose interval [n·den/num, (n+1)·den/num) holds `seconds` (≥ 0). */
export function frameAt(seconds, fps) {
  const [num, den] = fpsParts(fps);
  if (!(seconds > 0)) return 0;
  // The epsilon absorbs the rounding of n·den/num·num/den; it is 1e-6 of a frame.
  return Math.floor((seconds * num) / den + 1e-6);
}

/** timemap.smp: the first sample of output frame n, ⌊n·rate·den / num⌋. */
export function smp(n, fps, rate = 48_000) {
  const [num, den] = fpsParts(fps);
  return Math.floor((n * rate * den) / num);
}

/** Output frames that follow a join (the first frame of every piece but the first). */
export function cutFrames(pieces) {
  return pieces.slice(1).map((piece) => piece.outF0);
}

/** ⌈ms·num / (1000·den)⌉: frames covering `ms` milliseconds. */
export function preRollFrames(fps, ms = 500) {
  const [num, den] = fpsParts(fps);
  return Math.ceil((ms * num) / (1000 * den));
}

/** The next `count` output frames from n (clipped to the clip), with their cell and index. */
export function upcoming(pieces, n, count, cellFrames) {
  const out = [];
  let index = pieceIndexAt(pieces, n);
  if (index < 0) return out;
  let frame = n;
  const end = n + count;
  while (frame < end && index < pieces.length) {
    const piece = pieces[index];
    const pieceEnd = piece.outF0 + piece.frames;
    for (; frame < end && frame < pieceEnd; frame += 1) {
      const sf = piece.inSf + (frame - piece.outF0);
      out.push({ n: frame, i: piece.i, sf, k: Math.floor(sf / cellFrames), j: sf % cellFrames });
    }
    index += 1;
  }
  return out;
}

/**
 * The frames to decode ahead of output frame n, grouped per cell in first-need order:
 * `[{ k, js: sorted indices, firstN: the first output frame that needs the cell }]`.
 * `has(k, j)` (optional) leaves out frames already decoded; a cell whose frames are all there is
 * left out.
 */
export function decodeSchedule(pieces, n, { cellFrames, aheadFrames, has = null }) {
  const byCell = new Map();
  for (const frame of upcoming(pieces, n, aheadFrames, cellFrames)) {
    if (has && has(frame.k, frame.j)) continue;
    let entry = byCell.get(frame.k);
    if (!entry) {
      entry = { k: frame.k, js: new Set(), firstN: frame.n };
      byCell.set(frame.k, entry);
    }
    entry.js.add(frame.j);
  }
  return [...byCell.values()].map((entry) => ({
    k: entry.k, js: [...entry.js].sort((a, b) => a - b), firstN: entry.firstN,
  }));
}
