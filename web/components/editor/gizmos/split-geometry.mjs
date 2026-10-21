// The "Atur layar terbagi" gizmo's geometry (CONTRACTS §5.45): each band's box over the source
// picture, a drag, a corner pulled, the keys, and the 9:16 result drawn from the still. Pure
// functions, no DOM; SplitGizmo.jsx, SplitDialog.jsx and their node tests use them.
//
// Boxes are the render's own crops (web/lib/editor/split.mjs), in fractions of the source. The
// still is the latar blur truth frame: the source fitted in the middle of the output, so the
// result is a CSS crop of that picture per band.
import { PAN_E5_MAX, SPLIT_ZOOM_RANGE } from "../../../lib/editor/doc-model.mjs";
import { splitCrop } from "../../../lib/editor/split.mjs";

export const NUDGE_E5 = 1000; // an arrow key: 1 % of the travel
export const BIG_NUDGE_E5 = 10000; // Shift + arrow: 10 %
export const ZOOM_STEP_PM = 100; // + or −: 10 % of the largest box
const ZOOM_GRID_PM = 10; // a pulled corner lands on the zoom slider's 1 % steps
const [ZOOM_MIN, ZOOM_MAX] = SPLIT_ZOOM_RANGE;
const clamp = (value, lo, hi) => Math.min(Math.max(value, lo), hi);
const evenFloor = (value) => value - (value % 2);

/** A band's crop as `{left, top, width, height}` fractions of the source picture. */
export function bandBox(geometry, band, source) {
  const [x, y, w, h] = geometry[band].crop;
  return { left: x / source[0], top: y / source[1], width: w / source[0], height: h / source[1] };
}

/** `crop` placed with its top-left corner nearest `left`, `top` (source pixels); an axis without travel keeps its place. */
export function cropForPlace({ crop, left, top, source, band }) {
  const [, , w, h] = splitCrop(source, band, crop);
  const travelX = evenFloor(source[0] - w);
  const travelY = evenFloor(source[1] - h);
  const place = (offset, travel, current) => (travel > 0 ? clamp(Math.round((offset * PAN_E5_MAX) / travel), 0, PAN_E5_MAX) : current);
  return { x_e5: place(left, travelX, crop.x_e5), y_e5: place(top, travelY, crop.y_e5), zoom_pm: crop.zoom_pm };
}

/**
 * A corner (`nw`, `ne`, `sw`, `se`) pulled to `pointer` (source pixels) while the opposite corner
 * stays at `anchor`: the box keeps the band's shape and takes the larger of the two pulls.
 */
export function cropForCorner({ corner, anchor, pointer, crop, source, band }) {
  const [, , fullW, fullH] = splitCrop(source, band, { ...crop, zoom_pm: ZOOM_MIN });
  const width = Math.max(Math.abs(pointer.x - anchor.x), (Math.abs(pointer.y - anchor.y) * fullW) / fullH, 1);
  const zoom = clamp(Math.round((fullW * 1000) / width / ZOOM_GRID_PM) * ZOOM_GRID_PM, ZOOM_MIN, ZOOM_MAX);
  const sized = { ...crop, zoom_pm: zoom };
  const [, , w, h] = splitCrop(source, band, sized);
  const left = corner.includes("w") ? anchor.x - w : anchor.x;
  const top = corner.includes("n") ? anchor.y - h : anchor.y;
  return cropForPlace({ crop: sized, left, top, source, band });
}

/** The crop after a key on a box (arrows move, + and − zoom), or null for a key the box leaves alone. */
export function nudgedCrop(crop, key, shift) {
  const step = shift ? BIG_NUDGE_E5 : NUDGE_E5;
  const place = (value) => clamp(value, 0, PAN_E5_MAX);
  switch (key) {
    case "ArrowLeft": return { ...crop, x_e5: place(crop.x_e5 - step) };
    case "ArrowRight": return { ...crop, x_e5: place(crop.x_e5 + step) };
    case "ArrowUp": return { ...crop, y_e5: place(crop.y_e5 - step) };
    case "ArrowDown": return { ...crop, y_e5: place(crop.y_e5 + step) };
    case "+":
    case "=": return { ...crop, zoom_pm: clamp(crop.zoom_pm + ZOOM_STEP_PM, ZOOM_MIN, ZOOM_MAX) };
    case "-":
    case "_": return { ...crop, zoom_pm: clamp(crop.zoom_pm - ZOOM_STEP_PM, ZOOM_MIN, ZOOM_MAX) };
    default: return null;
  }
}

/**
 * One band of the result as a CSS crop of the still (`output` sized, the source fitted in its
 * middle): `{size, position}` for background-size and background-position, so the band's crop
 * fills the band.
 */
export function bandBackground(geometry, band, source, output) {
  const [srcW, srcH] = source;
  const [outW, outH] = output;
  const [x, y, w] = geometry[band].crop;
  const [bandW, bandH] = geometry[band].size;
  const fgW = Math.min(outW, (outH * srcW) / srcH);
  const fgH = Math.min(outH, (outW * srcH) / srcW);
  const fgX = (outW - fgW) / 2;
  const fgY = (outH - fgH) / 2;
  const size = ((outW * srcW) / (w * fgW)) * 100;
  const spanX = outW * srcW - w * fgW;
  const spanY = outH * srcW - (bandH * w * fgW) / bandW;
  const px = spanX > 0 ? ((fgX * srcW + x * fgW) / spanX) * 100 : 0;
  const py = spanY > 0 ? ((fgY * srcW + y * fgW) / spanY) * 100 : 0;
  return { size: `${size}% auto`, position: `${px}% ${py}%` };
}

/** The result's band heights in percent of the frame (the line takes the 1 px between them). */
export function resultRows(geometry, output) {
  return { top: (geometry.top.size[1] / output[1]) * 100, bottom: (geometry.bottom.size[1] / output[1]) * 100 };
}
