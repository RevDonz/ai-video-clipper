// Manual framing, "Atur bingkai" (CONTRACTS §5.44): the browser mirror of
// src/ai_clipper/edit_v2/layouts.py `pan_limit` and `keyframe_positions`. Both are checked against
// tests/fixtures/edit_v2/framing-vectors.json, so the box the gizmo draws is the crop the render
// takes, to the pixel. Pure functions, no DOM.
//
// Geometry: the crop layouts scale the source to cover the output height (`scaledSize`, FFmpeg's
// `force_original_aspect_ratio=increase`) and take an output-sized window at an even x in
// [0, limit], `limit` = scaled width − output width floored to even. A keyframe's `pan_e5` puts
// that window at `pan_e5 · limit / 100000`. Integers only: BigInt for the products.
//
// "Zoom" and the content rect (CONTRACTS §5.52, tests/fixtures/edit_v2/zoom-vectors.json): the
// scales cover the output enlarged by `layout.zoom_pm` (`zoomedOutput`) while the window stays
// output-sized, so the travel widens and the window's row is `cropY`; every layout sees only the
// picture inside the source's black bars (`base.source.content_rect`, `pictureSize`).
import { CROP_MODES, KEYFRAME_MOVES, MAX_KEYFRAMES, PAN_E5_MAX, ZOOM_RANGE, zoomOf } from "./doc-model.mjs";
import { divRoundHalfUp, floorDiv, outToSrc, srcToOut } from "./timemap.mjs";

const pair = (value, name) => {
  const [w, h] = Array.isArray(value) ? value : [value?.w, value?.h];
  if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w <= 0 || h <= 0) throw new TypeError(`${name} must be [w, h]`);
  return [w, h];
};

/** `scale=W:H:force_original_aspect_ratio=increase`: each side rounded to nearest, halves up. */
export function scaledSize(source, output) {
  const [srcW, srcH] = pair(source, "source");
  const [outW, outH] = pair(output, "output");
  const width = floorDiv(outH * srcW + floorDiv(srcH, 2), srcH);
  const height = floorDiv(outW * srcH + floorDiv(srcW, 2), srcW);
  return [Math.max(width, outW), Math.max(height, outH)];
}

/** The size the scales cover at `zoomPm`: each output side times zoom/1000, halves up (layouts.zoomed_output). */
export function zoomedOutput(output, zoomPm = ZOOM_RANGE[0]) {
  const [w, h] = pair(output, "output");
  if (!Number.isSafeInteger(zoomPm) || zoomPm < ZOOM_RANGE[0] || zoomPm > ZOOM_RANGE[1]) throw new RangeError("zoom must be an integer in 1000..1500");
  if (zoomPm === ZOOM_RANGE[0]) return [w, h];
  return [divRoundHalfUp(w * zoomPm, 1000), divRoundHalfUp(h * zoomPm, 1000)];
}

const zoomedScale = (source, output, zoomPm) => scaledSize(source, zoomedOutput(output, zoomPm));

/** The crop's travel in the scaled source; 0 when the source is 9:16 or taller at 100 % (nothing to pan). */
export function panLimit(source, output, zoomPm = ZOOM_RANGE[0]) {
  const limit = Math.max(zoomedScale(source, output, zoomPm)[0] - pair(output, "output")[0], 0);
  return limit - (limit % 2);
}

/** The centred crop's x, `(in_w − out_w)/2` truncated (layouts.centre_x): Potong tengah's crop. */
export function centreX(source, output, zoomPm = ZOOM_RANGE[0]) {
  return floorDiv(zoomedScale(source, output, zoomPm)[0] - pair(output, "output")[0], 2);
}

/** The row of every crop, `(in_h − out_h)/2` truncated (layouts.crop_y): 0 for a wide source at 100 %. */
export function cropY(source, output, zoomPm = ZOOM_RANGE[0]) {
  return floorDiv(zoomedScale(source, output, zoomPm)[1] - pair(output, "output")[1], 2);
}

/** Latar blur's picture before it is cropped to the frame: fit into the zoomed output (layouts.foreground_size). */
export function foregroundSize(source, output, zoomPm = ZOOM_RANGE[0]) {
  const [srcW, srcH] = pair(source, "source");
  const [outW, outH] = zoomedOutput(output, zoomPm);
  return [Math.min(floorDiv(outH * srcW + floorDiv(srcH, 2), srcH), outW),
    Math.min(floorDiv(outW * srcH + floorDiv(srcW, 2), srcW), outH)];
}

/** What the layouts lay out: the content rect's size (`[x, y, w, h]` or `{x, y, w, h}`), else the whole source. */
export function pictureSize(source, content = null) {
  const [w, h] = pair(source, "source");
  if (content === null || content === undefined) return [w, h];
  return Array.isArray(content) ? [content[2], content[3]] : [content.w, content.h];
}

/** Throws unless `keyframes` is a valid `layout.keyframes` list (the window rule aside). */
export function checkKeyframes(keyframes) {
  if (!Array.isArray(keyframes) || keyframes.length < 1 || keyframes.length > MAX_KEYFRAMES) {
    throw new RangeError("manual framing needs 1 to 100 keyframes");
  }
  let previous = -1;
  for (const keyframe of keyframes) {
    if (!keyframe || typeof keyframe !== "object") throw new TypeError("a keyframe is an object");
    if (!Number.isSafeInteger(keyframe.sf) || keyframe.sf <= previous) throw new RangeError("keyframe frames must be integers, strictly increasing");
    if (!Number.isSafeInteger(keyframe.pan_e5) || keyframe.pan_e5 < 0 || keyframe.pan_e5 > PAN_E5_MAX) throw new RangeError("pan_e5 must be in 0..100000");
    if (!KEYFRAME_MOVES.includes(keyframe.move)) throw new RangeError("move must be cut or slide");
    previous = keyframe.sf;
  }
}

/** The index of the last keyframe at or before `sf` (−1 before the first). */
export function keyframeBefore(keyframes, sf) {
  let lo = 0;
  let hi = keyframes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keyframes[mid].sf <= sf) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

const LIMIT_BIG = BigInt(PAN_E5_MAX);

/**
 * Even crop x for source-grid frames `firstSf … firstSf+count−1` (layouts.keyframe_positions):
 * before the first keyframe the first holds, after the last the last; towards the next keyframe
 * the crop holds until that frame (`cut`) or moves linearly in the frame index (`slide`); exact
 * rationals rounded once to the nearest even integer.
 */
export function keyframePositions(keyframes, { source, output, firstSf, count, zoomPm = ZOOM_RANGE[0] }) {
  checkKeyframes(keyframes);
  if (!Number.isSafeInteger(firstSf) || !Number.isSafeInteger(count) || count < 0) throw new TypeError("firstSf and count must be integers");
  const limit = panLimit(source, output, zoomPm);
  const big = BigInt(limit);
  const last = keyframes.length - 1;
  const values = [];
  for (let sf = firstSf; sf < firstSf + count; sf += 1) {
    const index = Math.max(keyframeBefore(keyframes, sf), 0);
    const here = keyframes[index];
    const next = index < last ? keyframes[index + 1] : null;
    let numerator;
    let denominator;
    if (sf < keyframes[0].sf || !next || next.move === "cut" || here.pan_e5 === next.pan_e5) {
      numerator = BigInt(here.pan_e5) * big;
      denominator = LIMIT_BIG;
    } else {
      const span = BigInt(next.sf - here.sf);
      const offset = BigInt(sf - here.sf);
      numerator = (BigInt(here.pan_e5) * span + BigInt(next.pan_e5 - here.pan_e5) * offset) * big;
      denominator = LIMIT_BIG * span;
    }
    // round_half_up(numerator / (2·denominator)), times 2: the one rounding, to even
    const value = 2 * Number((2n * numerator + 2n * denominator) / (4n * denominator));
    values.push(Math.min(Math.max(value, 0), limit));
  }
  return values;
}

/** The crop x of one source frame. */
export function cropAt(keyframes, sf, source, output, zoomPm = ZOOM_RANGE[0]) {
  return keyframePositions(keyframes, { source, output, firstSf: sf, count: 1, zoomPm })[0];
}

/** The `pan_e5` that puts the crop at x (the nearest; the travel's ends at 0 and 100000). */
export function panForCrop(x, limit) {
  if (!(limit > 0)) return PAN_E5_MAX / 2;
  const pan = Math.round((x * PAN_E5_MAX) / limit);
  return Math.min(Math.max(pan, 0), PAN_E5_MAX);
}

/**
 * The document's picture (the source inside its black bars, CONTRACTS §5.52) and output as
 * `[w, h]` pairs, and its zoom per mille: what every crop of the layouts is taken from.
 */
export function framingSizes(doc) {
  const source = pictureSize([doc.base.source.w, doc.base.source.h], doc.base.source.content_rect ?? null);
  return { source, output: [doc.output.w, doc.output.h], zoom: zoomOf(doc) };
}

/** The keyframes of the document (an empty list for the layout's own framing). */
export function keyframesOf(doc) {
  const list = doc?.layout?.keyframes;
  return Array.isArray(list) ? list : [];
}

/**
 * Whether "Atur bingkai" can frame this clip: `{ok: true}`, or `{ok: false, reason}` with reason
 * "layout" (latar blur shows the whole picture) or "portrait" (the source is 9:16 or taller).
 */
export function framingAvailability(doc) {
  if (!doc?.layout?.default || !CROP_MODES.includes(doc.layout.default.mode)) return { ok: false, reason: "layout" };
  const { source, output, zoom } = framingSizes(doc);
  if (panLimit(source, output, zoom) <= 0) return { ok: false, reason: "portrait" };
  return { ok: true, reason: null };
}

/** The source frame output frame `f` shows (null outside the clip or without a plan). */
export function sourceFrameAt(plan, f) {
  const list = plan?.pieces;
  const total = plan?.totalFrames;
  if (!Array.isArray(list) || !list.length || !Number.isSafeInteger(f) || !Number.isSafeInteger(total) || f < 0 || f >= total) return null;
  return outToSrc(f, list)[1];
}

/**
 * The keyframes on the output timeline: `[{f, sf, index}]` for each keyframe whose frame the clip
 * shows (a keyframe inside a cut is still part of the framing, but has no place on the timeline).
 */
export function keyframeMarks(doc, plan) {
  const list = plan?.pieces;
  if (!Array.isArray(list) || !list.length) return [];
  const marks = [];
  keyframesOf(doc).forEach((keyframe, index) => {
    const f = srcToOut(keyframe.sf, list);
    if (f !== null) marks.push({ f, sf: keyframe.sf, index });
  });
  return marks.sort((a, b) => a.f - b.f || a.index - b.index);
}
