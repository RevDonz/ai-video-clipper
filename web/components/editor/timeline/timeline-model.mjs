// Timeline geometry and word-snapped trimming (plan Appendix C.3; §3.6 `bounds`; Appendix B
// TrimStart/TrimEnd). Positions are output frames (the plan DTO's `pieces`, §4.3); trims are
// source-grid frames and are always a `bounds` frame: the client never invents a cut point.
// Pure functions, unit-tested in web/tests/editor-timeline-model.test.mjs.
import { formatClock } from "../shell-model.mjs";

export const MIN_PX_PER_FRAME = 0.02;
export const MAX_PX_PER_FRAME = 16;

function fpsParts(fps) {
  const [num, den] = Array.isArray(fps) ? fps : [30, 1];
  return [Number(num) || 30, Number(den) || 1];
}

/** ⌈ms·num / (1000·den)⌉ and ⌊…⌋ (plan §3.4), in exact integer arithmetic below 2^53. */
function sfCeil(ms, [num, den]) {
  return Math.ceil((ms * num) / (1000 * den));
}

function sfFloor(ms, [num, den]) {
  return Math.floor((ms * num) / (1000 * den));
}

export function bodySegment(doc) {
  return doc?.main?.segments?.find((segment) => segment.role === "body") ?? null;
}

function docFps(doc, words) {
  return fpsParts(doc?.output?.fps ?? words?.fps);
}

function trimLimits(doc, words) {
  const fps = docFps(doc, words);
  const body = bodySegment(doc);
  const window = Array.isArray(doc?.base?.window_ms) ? doc.base.window_ms : null;
  return {
    body,
    minFrames: sfCeil(3000, fps),
    windowSf: window ? [sfFloor(window[0], fps), sfCeil(window[1], fps)] : [-Infinity, Infinity],
  };
}

/** Bounds entries a trim edge may use (start: a word follows; end: a word precedes). */
function eligible(edge, doc, words) {
  const { body, minFrames, windowSf } = trimLimits(doc, words);
  if (!body || !Array.isArray(words?.bounds)) return [];
  return words.bounds.filter((bound) => {
    if (!Number.isInteger(bound?.sf) || bound.sf < windowSf[0] || bound.sf > windowSf[1]) return false;
    if (edge === "start") return bound.before !== null && bound.before !== undefined && bound.sf <= body.out_sf - minFrames;
    if (edge === "end") return bound.after !== null && bound.after !== undefined && bound.sf >= body.in_sf + minFrames;
    return false;
  });
}

function result(edge, bound) {
  return bound ? { sf: bound.sf, gapWord: edge === "start" ? bound.before : bound.after } : null;
}

/**
 * The `bounds` frame nearest to a dragged source frame `sf` for the body's start or end edge,
 * keeping the body ≥ 3 s and inside the analysis window. `gapWord` is the first kept word
 * (start) or the last kept word (end), the argument of TrimStart/TrimEnd.
 */
export function snapTrim({ edge, sf, words, doc }) {
  let best = null;
  for (const bound of eligible(edge, doc, words)) {
    if (!best || Math.abs(bound.sf - sf) < Math.abs(best.sf - sf)) best = bound;
  }
  return result(edge, best);
}

/** The adjacent word gap before (direction −1) or after (+1) the edge's current frame. */
export function stepTrim({ edge, direction, words, doc }) {
  const body = bodySegment(doc);
  if (!body) return null;
  const current = edge === "start" ? body.in_sf : body.out_sf;
  let best = null;
  for (const bound of eligible(edge, doc, words)) {
    if (direction < 0 && bound.sf < current && (!best || bound.sf > best.sf)) best = bound;
    if (direction > 0 && bound.sf > current && (!best || bound.sf < best.sf)) best = bound;
  }
  return result(edge, best);
}

/** Output frame → [piece, source frame], or null outside the clip. */
export function outToSrc(frame, pieces) {
  for (const piece of pieces ?? []) {
    if (frame >= piece.outF0 && frame < piece.outF0 + piece.frames) return [piece, piece.inSf + (frame - piece.outF0)];
  }
  return null;
}

/**
 * I / O at the playhead (Appendix C.4): the word under the playhead, else the next word (start)
 * or the previous word (end).
 */
export function wordForTrimAt({ edge, frame, plan, words }) {
  const hit = outToSrc(frame, plan?.pieces);
  const list = Array.isArray(words?.words) ? words.words : [];
  if (!hit || !list.length) return null;
  const [num, den] = fpsParts(plan?.fps ?? words?.fps);
  const startMs = (hit[1] * 1000 * den) / num;
  const endMs = ((hit[1] + 1) * 1000 * den) / num;
  if (edge === "start") return list.find((word) => word.e > startMs)?.id ?? null;
  let last = null;
  for (const word of list) if (word.s < endMs) last = word;
  return last?.id ?? null;
}

/** One block per piece, in output frames. */
export function pieceBlocks(plan) {
  return (plan?.pieces ?? []).map((piece) => ({
    key: `${piece.seg}:${piece.i}`, i: piece.i, seg: piece.seg, role: piece.role, f0: piece.outF0, f1: piece.outF0 + piece.frames,
    inSf: piece.inSf, outSf: piece.outSf,
  }));
}

/** A "join" between the cold open and the body; a "cut" where a removal splits a segment. */
export function cutMarkers(plan) {
  const pieces = plan?.pieces ?? [];
  const markers = [];
  for (let i = 1; i < pieces.length; i += 1) {
    const previous = pieces[i - 1];
    const piece = pieces[i];
    if (previous.seg !== piece.seg) markers.push({ f: piece.outF0, kind: "join" });
    else if (previous.outSf !== piece.inSf) markers.push({ f: piece.outF0, kind: "cut" });
  }
  return markers;
}

/** The body's first and last output frames (where the trim handles sit). */
export function edgeFrames(plan) {
  const body = (plan?.pieces ?? []).filter((piece) => piece.role === "body");
  if (!body.length) return null;
  return { startF: body[0].outF0, endF: body.at(-1).outF0 + body.at(-1).frames };
}

/** Output ranges of plate cells that are not ready yet (hatched bands, Appendix C.3). */
export function pendingBands(plan) {
  const cellFrames = plan?.plate?.cellFrames;
  const cells = Array.isArray(plan?.plate?.cells) ? plan.plate.cells : [];
  if (!Number.isInteger(cellFrames) || cellFrames <= 0) return [];
  const bands = [];
  for (const cell of cells) {
    if (!cell || cell.state === "ready" || !Number.isInteger(cell.k)) continue;
    const s0 = cell.k * cellFrames;
    const s1 = s0 + cellFrames;
    for (const piece of plan.pieces ?? []) {
      const a = Math.max(s0, piece.inSf);
      const b = Math.min(s1, piece.outSf);
      if (a < b) bands.push({ f0: piece.outF0 + a - piece.inSf, f1: piece.outF0 + b - piece.inSf });
    }
  }
  bands.sort((x, y) => x.f0 - y.f0);
  const merged = [];
  for (const band of bands) {
    const last = merged.at(-1);
    if (last && band.f0 <= last.f1) last.f1 = Math.max(last.f1, band.f1);
    else merged.push({ ...band });
  }
  return merged;
}

export function clampZoom(pxPerFrame) {
  return Math.min(MAX_PX_PER_FRAME, Math.max(MIN_PX_PER_FRAME, pxPerFrame));
}

/** The zoom that fits the whole clip into `widthPx`. */
export function fitZoom(totalFrames, widthPx) {
  if (!(totalFrames > 0) || !(widthPx > 0)) return 1;
  return clampZoom(widthPx / totalFrames);
}

/** Ctrl+scroll zoom that keeps the frame under the pointer in place. */
export function zoomAround({ pxPerFrame, factor, anchorPx, scrollLeft }) {
  const next = clampZoom(pxPerFrame * factor);
  const frame = (scrollLeft + anchorPx) / pxPerFrame;
  return { pxPerFrame: next, scrollLeft: Math.max(0, frame * next - anchorPx) };
}

const TICK_STEPS_S = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

/** Ruler ticks at least `minGapPx` apart, labelled "mm:ss" from the clip start (output time). */
export function rulerTicks({ totalFrames, fps, pxPerFrame, minGapPx = 64 }) {
  if (!(totalFrames > 0) || !(pxPerFrame > 0)) return [];
  const [num, den] = fpsParts(fps);
  const framesPerSecond = num / den;
  const step = TICK_STEPS_S.find((seconds) => seconds * framesPerSecond * pxPerFrame >= minGapPx) ?? TICK_STEPS_S.at(-1);
  const durationS = (totalFrames * den) / num;
  const ticks = [];
  for (let k = 0; k * step <= durationS + 1e-9; k += 1) {
    const seconds = k * step;
    const clock = formatClock(Math.round(seconds * 1000));
    ticks.push({ f: (seconds * num) / den, label: step < 1 ? clock : clock.slice(0, -2), major: true });
  }
  return ticks;
}

/** The hook's `dur_f` range (plan §3.3): 15 to ⌊30·F⌋. */
export function hookDurationBounds(fps) {
  return { min: 15, max: sfFloor(30_000, fpsParts(fps)) };
}

export function clampHookDuration(durF, fps) {
  const { min, max } = hookDurationBounds(fps);
  return Math.min(max, Math.max(min, Math.round(durF)));
}

/** A dragged hook width in px → `dur_f`, on the frame grid and inside the §3.3 range. */
export function hookDurationFromPx({ px, pxPerFrame, fps }) {
  return clampHookDuration(px / pxPerFrame, fps);
}
