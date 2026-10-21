// The "Atur bingkai" gizmo's geometry (CONTRACTS §5.44): the 9:16 box over the source picture, in
// fractions of that picture, from the crop x of web/lib/editor/framing.mjs (the render's own x).
// Pure functions, no DOM; FrameGizmo.jsx and its node tests use them.
//
// The crop layouts scale the source to `scaledW × scaledH` (cover) and take an output-sized window
// at x; the picture the gizmo draws on is the whole source, so the box is `x / scaledW` from its
// left and `W / scaledW` wide (full height for a source wider than 9:16).
import { PAN_E5_MAX } from "../../../lib/editor/doc-model.mjs";
import { panForCrop, panLimit, scaledSize } from "../../../lib/editor/framing.mjs";

export const NUDGE_E5 = 1000; // an arrow key: 1 % of the travel
export const BIG_NUDGE_E5 = 10000; // Shift + arrow, PageUp, PageDown: 10 %
export const SNAP_SCREEN_PX = 8; // the centre's magnet on screen, whatever the picture's size
const CENTRE_E5 = PAN_E5_MAX / 2;

export function frameGeometry(source, output) {
  const [scaledW, scaledH] = scaledSize(source, output);
  const [outW, outH] = output;
  return Object.freeze({
    source, output, scaledW, scaledH,
    limit: panLimit(source, output),
    travel: Math.max(scaledW - outW, 0),
    boxWidth: Math.min(outW / scaledW, 1),
    boxTop: (scaledH - outH) / 2 / scaledH,
    boxHeight: outH / scaledH,
  });
}

/** The box at crop x: `{left, width, top, height}` as fractions of the picture. */
export function boxRect(x, geometry) {
  return { left: x / geometry.scaledW, width: geometry.boxWidth, top: geometry.boxTop, height: geometry.boxHeight };
}

/**
 * The 9:16 result as a CSS crop of the still (the whole source across its width): the picture
 * scaled so the source fills the output height, moved so the crop at x fills the box.
 */
export function resultBackground(x, geometry) {
  const position = geometry.travel > 0 ? (x / geometry.travel) * 100 : 50;
  return { size: `${(geometry.scaledW / geometry.output[0]) * 100}% auto`, position: `${position}% 50%` };
}

/** Where a drag holds the box: the pointer's offset in it, or its middle when the press is outside. */
export function grabOffset(pointer, x, geometry) {
  const left = x / geometry.scaledW;
  return pointer >= left && pointer <= left + geometry.boxWidth ? pointer - left : geometry.boxWidth / 2;
}

/**
 * The pan of a drag: the box's left edge at `pointer − grab` (fractions of the picture), as the
 * nearest pan of the travel. Within `reach` of the centre it is exactly the centre (`snapped`).
 */
export function panAtPointer({ pointer, grab, geometry, reach = 0 }) {
  const left = pointer - grab;
  const centre = geometry.limit / 2 / geometry.scaledW;
  if (reach > 0 && Math.abs(left - centre) <= reach) return { pan: CENTRE_E5, snapped: true };
  return { pan: panForCrop(left * geometry.scaledW, geometry.limit), snapped: false };
}

/** The pan after a key on the box, or null for a key the box leaves alone. */
export function nudgedPan(pan, key, shift) {
  const clamp = (value) => Math.min(Math.max(value, 0), PAN_E5_MAX);
  switch (key) {
    case "ArrowLeft": return clamp(pan - (shift ? BIG_NUDGE_E5 : NUDGE_E5));
    case "ArrowRight": return clamp(pan + (shift ? BIG_NUDGE_E5 : NUDGE_E5));
    case "PageDown": return clamp(pan - BIG_NUDGE_E5);
    case "PageUp": return clamp(pan + BIG_NUDGE_E5);
    case "Home": return 0;
    case "End": return PAN_E5_MAX;
    default: return null;
  }
}
