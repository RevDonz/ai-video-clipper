// The Logo panel's view of the store state (plan §11.3 T3.2): the logo item, its pixel box at
// the output size, the corner preset it sits on, and the server's G5 warning for it. Pure.
import { assetThumbUrl } from "../gizmos/logo-upload.mjs";
import { boxOf, cornerOf, logoOf, safePlacement } from "../gizmos/logo-geometry.mjs";

function tenths(value) {
  const whole = Math.trunc(value / 10);
  const rest = value % 10;
  return rest ? `${whole},${rest}` : `${whole}`;
}

/** "16% lebar video · 115 px" (w_e5 to a tenth of a percent, half up; the box's pixel width). */
export function sizeLabel(wE5, box) {
  return `${tenths(Math.floor((2 * wE5 + 100) / 200))}% lebar video · ${box.w} px`;
}

/** "85%" from per-mille. */
export function opacityLabel(opacityPm) {
  return `${tenths(opacityPm)}%`;
}

/**
 * `{ status, ready, readOnly, jobId, output, logo }`; `logo` is null without a logo, else
 * `{ item, meta, transform, assetId, box, corner, unsafe, safeTarget, thumbUrl }`. `unsafe` is
 * the plan's `unsafe_zone` warning for this item (the server's G5), never a local guess.
 */
export function logoPanelView(state) {
  const status = state?.status ?? "loading";
  const doc = state?.doc ?? null;
  const readOnly = status === "readOnly";
  const ready = (status === "ready" || readOnly) && Boolean(doc);
  const output = doc?.output ? { w: doc.output.w, h: doc.output.h } : null;
  const view = { status, ready, readOnly, jobId: state?.jobId ?? null, output, logo: null };
  if (!ready || !output) return view;
  const found = logoOf(doc);
  if (!found) return view;
  const box = boxOf(found.transform, found.meta, output);
  const warnings = Array.isArray(state?.plan?.warnings) ? state.plan.warnings : [];
  const unsafe = warnings.some((warning) => warning?.code === "unsafe_zone" && warning.ref === found.item.id);
  view.logo = {
    ...found,
    box,
    corner: cornerOf(found.transform, found.meta, output),
    unsafe,
    safeTarget: safePlacement(box, output),
    thumbUrl: assetThumbUrl(view.jobId, found.assetId),
  };
  return view;
}
