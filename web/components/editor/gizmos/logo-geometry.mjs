// Logo geometry for the stage gizmo and the Logo panel (plan §3.3 logo item, §3.4 logo box, §5.9
// G5, Appendix B MoveLogo/ResizeLogo/SnapLogo). Pure integer arithmetic in output pixels at the
// document's output size; the only stored values are the e5 transforms the commands take.
//
// - `boxOf` is plan §3.4's box (timemap.logoBox), the box the server derives and overlays.
// - `positionFor` inverts it: the centre e5 of a box starting at an integer pixel. A 1 e5 step is
//   0.0072 px at 720 wide, so every pixel position is reachable and gives back exactly its box.
// - `zoneHits` mirrors plan.unsafe_zone_issues for the logo (top, bottom and right bands of the
//   TikTok UI zone); web/tests/editor-logo.test.mjs checks it against the Python compiler's
//   vectors, so the live hint during a drag says what the server's G5 warning will say.
// - Corner presets reproduce SnapLogo: 4 % from the left edge and against the TikTok zone's
//   right, top and bottom edges, so a preset never brings the G5 warning. The "margin" guides
//   (4 % of the width, 2.5 % of the height) stay as magnets for a deliberate placement.
import { divRoundHalfUp, logoBox } from "../../../lib/editor/timemap.mjs";

export const LOGO_WIDTH_E5 = Object.freeze({ min: 4000, max: 40000 });
export const OPACITY_PM = Object.freeze({ min: 200, max: 1000 });
export const CORNERS = Object.freeze(["top_left", "top_right", "bottom_left", "bottom_right"]);
// The TikTok UI zone at 720×1280 (plan §5.9 G5), scaled like plan.ui_zone.
const UI_ZONE_720 = Object.freeze({ top: 93, bottom: 280, right: 93 });
const E5 = 100000;

const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

/** The document's logo: `{ item, meta, transform, assetId, index }` (index: its track), or null. */
export function logoOf(doc) {
  const tracks = Array.isArray(doc?.tracks) ? doc.tracks : [];
  const index = tracks.findIndex((track) => track?.kind === "visual" && track.items?.length);
  if (index < 0) return null;
  const item = tracks[index].items[0];
  const assetId = item?.payload?.asset;
  const meta = typeof assetId === "string" ? doc.assets?.[assetId] : null;
  if (!meta || !item.transform) return null;
  return { item, meta, transform: item.transform, assetId, index };
}

/** Plan §3.4's integer box `{ x, y, w, h }` of a transform at the output size. */
export function boxOf(transform, meta, output) {
  const [x, y, w, h] = logoBox({
    x_e5: transform.x_e5, y_e5: transform.y_e5, w_e5: transform.w_e5,
    asset_w: meta.w, asset_h: meta.h, out_w: output.w, out_h: output.h,
  });
  return { x, y, w, h };
}

export function insideFrame(box, output) {
  return box.x >= 0 && box.y >= 0 && box.x + box.w <= output.w && box.y + box.h <= output.h;
}

/** The TikTok UI zone in output pixels: `{ top, bottom, right }` band sizes (plan.ui_zone). */
export function uiZone(output) {
  return {
    top: divRoundHalfUp(UI_ZONE_720.top * output.h, 1280),
    bottom: divRoundHalfUp(UI_ZONE_720.bottom * output.h, 1280),
    right: divRoundHalfUp(UI_ZONE_720.right * output.w, 720),
  };
}

/** Which bands of the zone the box touches; `any` is the server's `unsafe_zone` for the logo. */
export function zoneHits(box, output) {
  const zone = uiZone(output);
  const top = box.y < zone.top;
  const bottom = box.y + box.h > output.h - zone.bottom;
  const right = box.x + box.w > output.w - zone.right;
  return { top, bottom, right, any: top || bottom || right };
}

/** The centre e5 values of a `size` box whose top-left pixel is (x, y). */
export function positionFor(x, y, size, output) {
  return {
    x_e5: divRoundHalfUp((2 * x + size.w) * E5, 2 * output.w),
    y_e5: divRoundHalfUp((2 * y + size.h) * E5, 2 * output.h),
  };
}

function cornerMargins(output) {
  return { mx: divRoundHalfUp(4 * output.w, 100), my: divRoundHalfUp(25 * output.h, 1000) };
}

// SnapLogo's spots: 4 % from the left edge, against the TikTok zone's right, top and bottom edges.
function cornerStart(corner, size, output) {
  const { mx } = cornerMargins(output);
  const zone = uiZone(output);
  return {
    x: clamp(corner.endsWith("left") ? mx : output.w - zone.right - size.w, 0, Math.max(0, output.w - size.w)),
    y: clamp(corner.startsWith("top") ? zone.top : output.h - zone.bottom - size.h, 0, Math.max(0, output.h - size.h)),
  };
}

/** The e5 position SnapLogo gives `corner` for this transform's size. */
export function cornerTransform(transform, meta, output, corner) {
  const box = boxOf(transform, meta, output);
  const start = cornerStart(corner, box, output);
  return positionFor(start.x, start.y, box, output);
}

/** The corner preset the box sits on (compared in pixels), or null. */
export function cornerOf(transform, meta, output) {
  const box = boxOf(transform, meta, output);
  return CORNERS.find((corner) => {
    const start = cornerStart(corner, box, output);
    return start.x === box.x && start.y === box.y;
  }) ?? null;
}

/**
 * The magnet guides for a box of `size`: per axis `{ id, kind, at, line }`, where `at` is the box
 * start that aligns with the guide and `line` the coordinate drawn on the stage. Kinds: "margin"
 * (4 % / 2.5 % from the frame edges), "safe" (the TikTok zone's edges, where the corner presets
 * sit), "center" (x_e5 or y_e5 = 50000).
 */
export function guideLines(size, output) {
  const { mx, my } = cornerMargins(output);
  const zone = uiZone(output);
  const center = boxOf({ x_e5: E5 / 2, y_e5: E5 / 2, w_e5: divRoundHalfUp(size.w * E5, output.w) }, { w: size.w, h: size.h }, output);
  const x = [
    { id: "margin_left", kind: "margin", at: mx, line: mx },
    { id: "margin_right", kind: "margin", at: output.w - mx - size.w, line: output.w - mx },
    { id: "safe_right", kind: "safe", at: output.w - zone.right - size.w, line: output.w - zone.right },
    { id: "center", kind: "center", at: center.x, line: center.x + size.w / 2 },
  ];
  const y = [
    { id: "margin_top", kind: "margin", at: my, line: my },
    { id: "margin_bottom", kind: "margin", at: output.h - my - size.h, line: output.h - my },
    { id: "safe_top", kind: "safe", at: zone.top, line: zone.top },
    { id: "safe_bottom", kind: "safe", at: output.h - zone.bottom - size.h, line: output.h - zone.bottom },
    { id: "center", kind: "center", at: center.y, line: center.y + size.h / 2 },
  ];
  return { x, y };
}

function nearest(value, guides, threshold) {
  let best = null;
  for (const guide of guides) {
    const distance = Math.abs(guide.at - value);
    if (distance <= threshold && (!best || distance < best.distance)) best = { guide, distance };
  }
  return best?.guide ?? null;
}

/**
 * A drag's box start: the pointer's (fractional) start snapped to the nearest guide within
 * `threshold` output pixels (none with `magnet: false`), rounded, then kept inside the frame.
 */
export function snapDrag(point, size, output, { threshold = 0, magnet = true } = {}) {
  const guides = guideLines(size, output);
  const snapX = magnet ? nearest(point.x, guides.x, threshold) : null;
  const snapY = magnet ? nearest(point.y, guides.y, threshold) : null;
  const x = clamp(snapX ? snapX.at : Math.round(point.x), 0, Math.max(0, output.w - size.w));
  const y = clamp(snapY ? snapY.at : Math.round(point.y), 0, Math.max(0, output.h - size.h));
  return { x, y, snapX: snapX && snapX.at === x ? snapX : null, snapY: snapY && snapY.at === y ? snapY : null };
}

/** The box start after a keyboard nudge, kept inside the frame; null when it cannot move. */
export function nudged(box, output, dx, dy) {
  const x = clamp(box.x + dx, 0, Math.max(0, output.w - box.w));
  const y = clamp(box.y + dy, 0, Math.max(0, output.h - box.h));
  return x === box.x && y === box.y ? null : { x, y };
}

/** The nearest box start outside the TikTok zone; null when already outside or impossible. */
export function safePlacement(box, output) {
  if (!zoneHits(box, output).any) return null;
  const zone = uiZone(output);
  const maxX = output.w - zone.right - box.w;
  const minY = zone.top;
  const maxY = output.h - zone.bottom - box.h;
  if (maxX < 0 || maxY < minY) return null;
  return { x: clamp(box.x, 0, maxX), y: clamp(box.y, minY, maxY) };
}

/** The edges a resize keeps: an edge resting on a guide or on the frame, else the centre. */
export function anchorFor(box, output) {
  const guides = guideLines(box, output);
  const onX = (edge) => (edge === "left"
    ? box.x === 0 || guides.x.some((guide) => guide.kind !== "center" && guide.line === box.x)
    : box.x + box.w === output.w || guides.x.some((guide) => guide.kind !== "center" && guide.line === box.x + box.w));
  const onY = (edge) => (edge === "top"
    ? box.y === 0 || guides.y.some((guide) => guide.kind !== "center" && guide.line === box.y)
    : box.y + box.h === output.h || guides.y.some((guide) => guide.kind !== "center" && guide.line === box.y + box.h));
  return {
    x: onX("right") ? "right" : onX("left") ? "left" : "center",
    y: onY("top") ? "top" : onY("bottom") ? "bottom" : "center",
  };
}

function sizeAt(wE5, meta, output) {
  return boxOf({ x_e5: E5 / 2, y_e5: E5 / 2, w_e5: wE5 }, meta, output);
}

/** The largest width ≤ wE5 whose box fits `room` (`{ w, h }` pixels), or null. */
function fittingWidth(wE5, meta, output, room) {
  const fits = (value) => {
    const size = sizeAt(value, meta, output);
    return size.w <= room.w && size.h <= room.h;
  };
  if (!fits(LOGO_WIDTH_E5.min)) return null;
  if (fits(wE5)) return wE5;
  let low = LOGO_WIDTH_E5.min;
  let high = wE5;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (fits(mid)) low = mid;
    else high = mid - 1;
  }
  return low;
}

function placed(box, output, meta, wE5, keepCentre) {
  const x = clamp(box.x, 0, Math.max(0, output.w - box.w));
  const y = clamp(box.y, 0, Math.max(0, output.h - box.h));
  const position = positionFor(x, y, box, output);
  const target = {
    x_e5: keepCentre.x !== null && x === box.x ? keepCentre.x : position.x_e5,
    y_e5: keepCentre.y !== null && y === box.y ? keepCentre.y : position.y_e5,
    w_e5: wE5,
  };
  return insideFrame(boxOf(target, meta, output), output) ? target : null;
}

/**
 * A new width (clamped to plan §3.3's 4–40 %) that keeps the anchored edges (`anchorFor`) or the
 * centre, then stays inside the frame: `{ x_e5, y_e5, w_e5 }`, or null when no width fits.
 */
export function resizeTo(transform, meta, output, wE5, anchor = { x: "center", y: "center" }) {
  const wanted = fittingWidth(clamp(Math.round(wE5), LOGO_WIDTH_E5.min, LOGO_WIDTH_E5.max), meta, output, output);
  if (wanted === null) return null;
  const old = boxOf(transform, meta, output);
  const size = sizeAt(wanted, meta, output);
  const centred = boxOf({ ...transform, w_e5: wanted }, meta, output);
  const x = anchor.x === "left" ? old.x : anchor.x === "right" ? old.x + old.w - size.w : centred.x;
  const y = anchor.y === "top" ? old.y : anchor.y === "bottom" ? old.y + old.h - size.h : centred.y;
  const keep = { x: anchor.x === "center" ? transform.x_e5 : null, y: anchor.y === "center" ? transform.y_e5 : null };
  return placed({ x, y, w: size.w, h: size.h }, output, meta, wanted, keep);
}

/**
 * A corner handle dragged to `point` (output pixels): the aspect-locked box whose opposite corner
 * stays where it was, as large as the pointer asks within 4–40 % of the width and the frame.
 */
export function handleResize(start, meta, output, handle, point) {
  const right = handle.endsWith("right");
  const bottom = handle.startsWith("bottom");
  const anchor = { x: right ? start.x : start.x + start.w, y: bottom ? start.y : start.y + start.h };
  const fromX = right ? point.x - anchor.x : anchor.x - point.x;
  const fromY = ((bottom ? point.y - anchor.y : anchor.y - point.y) * meta.w) / meta.h;
  const wanted = Math.max(fromX, fromY, 0);
  const room = { w: right ? output.w - anchor.x : anchor.x, h: bottom ? output.h - anchor.y : anchor.y };
  const wE5 = clamp(divRoundHalfUp(Math.round(wanted) * E5, output.w), LOGO_WIDTH_E5.min, LOGO_WIDTH_E5.max);
  const fitted = fittingWidth(wE5, meta, output, room);
  if (fitted === null) return null;
  const size = sizeAt(fitted, meta, output);
  const box = { x: right ? anchor.x : anchor.x - size.w, y: bottom ? anchor.y : anchor.y - size.h, w: size.w, h: size.h };
  return placed(box, output, meta, fitted, { x: null, y: null });
}

/**
 * The MoveLogo/ResizeLogo commands that turn `transform` into `target`, in an order whose
 * intermediate box stays inside the frame (the commands reject any other); [] when nothing
 * changes, null when no order works.
 */
export function transformSteps(transform, meta, output, target) {
  const move = target.x_e5 !== transform.x_e5 || target.y_e5 !== transform.y_e5;
  const resize = target.w_e5 !== transform.w_e5;
  const moveStep = { type: "MoveLogo", args: { x_e5: target.x_e5, y_e5: target.y_e5 } };
  const resizeStep = { type: "ResizeLogo", args: { w_e5: target.w_e5 } };
  const fits = (candidate) => insideFrame(boxOf(candidate, meta, output), output);
  if (!fits(target)) return null;
  if (!move && !resize) return [];
  if (!resize) return [moveStep];
  if (!move) return [resizeStep];
  if (fits({ ...transform, w_e5: target.w_e5 })) return [resizeStep, moveStep];
  if (fits({ ...transform, x_e5: target.x_e5, y_e5: target.y_e5 })) return [moveStep, resizeStep];
  return null;
}
