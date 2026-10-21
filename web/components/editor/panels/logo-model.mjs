// The Logo panel's view of the store state (plan §11.3 T3.2): the logo item, its pixel box at
// the output size, the corner preset it sits on, and the server's G5 warning for it. Pure.
import { WATERMARK_POSITIONS, WATERMARK_POSITION_NAMES } from "../../../lib/editor/doc-model.mjs";
import { assetThumbUrl } from "../gizmos/logo-upload.mjs";
import { boxOf, cornerOf, logoOf, safePlacement } from "../gizmos/logo-geometry.mjs";

/** SnapLogo's corners as the Posisi cepat pills name them. */
export const LOGO_CORNERS = Object.freeze([
  Object.freeze({ id: "top_left", label: "Kiri atas" }), Object.freeze({ id: "top_right", label: "Kanan atas" }),
  Object.freeze({ id: "bottom_left", label: "Kiri bawah" }), Object.freeze({ id: "bottom_right", label: "Kanan bawah" }),
]);

export const LOGO_CAPTION_TEXT = Object.freeze({
  logo: "Logo menutupi caption.",
  logoNoFix: "Logo menutupi caption. Kecilkan logo atau geser caption.",
  watermark: "Teks watermark menutupi caption.",
  watermarkNoFix: "Teks watermark menutupi caption. Kecilkan teksnya atau geser caption.",
});

const WATERMARK_PATH = "/watermark/pos";

function captionPart(warning) {
  if (warning?.code !== "logo_over_caption" || typeof warning.path !== "string") return null;
  return warning.path === WATERMARK_PATH ? "watermark" : "logo";
}

/**
 * The fix of the plan's `logo_over_caption` warning (CONTRACTS §5.51): `ref` names the SnapLogo
 * corner (logo) or the watermark place that clears the caption. `{ id, part, label, command }`,
 * one undo step, or null (another warning, or nothing clears).
 */
export function logoCaptionFix(warning) {
  const part = captionPart(warning);
  if (part === "logo") {
    const corner = LOGO_CORNERS.find((entry) => entry.id === warning.ref);
    return corner
      ? { id: corner.id, part, label: `Pindah ke ${corner.label}`, command: { type: "SnapLogo", args: { corner: corner.id }, mergeKey: null } }
      : null;
  }
  if (part === "watermark" && WATERMARK_POSITIONS.includes(warning.ref)) {
    const pos = warning.ref;
    return { id: pos, part, label: `Pindah ke ${WATERMARK_POSITION_NAMES[pos]}`, command: { type: "SetWatermarkPosition", args: { pos }, mergeKey: null } };
  }
  return null;
}

/** The line a part ("logo" or "watermark") shows for the plan's warning: `{ text, fix }`, or null. */
export function logoCaptionNote(plan, part) {
  const warnings = Array.isArray(plan?.warnings) ? plan.warnings : [];
  const warning = warnings.find((item) => captionPart(item) === part);
  if (!warning) return null;
  const fix = logoCaptionFix(warning);
  return { text: LOGO_CAPTION_TEXT[fix ? part : `${part}NoFix`], fix };
}

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

export const LOGO_TOO_TALL = "Logo ini terlalu tinggi untuk video. Pakai gambar yang lebih lebar.";
const REFUSED = "Perubahan ini tidak bisa diterapkan.";

/** The command that puts an uploaded logo (the POST /assets DTO) in the clip. */
export function logoUploadCommand(dto) {
  return { type: "SetLogo", args: { asset: dto.sha256, meta: dto }, mergeKey: null };
}

/** Runs logo commands through the store; returns null, or the refusal `{ code, message }`. */
export function runLogoSteps(dispatch, steps, mergeKey = null) {
  try {
    for (const step of steps) dispatch(step.type, step.args, { mergeKey: step.mergeKey ?? mergeKey });
    return null;
  } catch (error) {
    return { code: error?.code ?? null, message: typeof error?.message === "string" && error.message ? error.message : REFUSED };
  }
}

/** What an upload's `onUploaded` answers after SetLogo: null when applied, else the message. */
export function logoUploadMessage(refused) {
  if (!refused) return null;
  return refused.code === "item_out_of_frame" ? LOGO_TOO_TALL : refused.message;
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
    // A logo in the seed is the Pengaturan default logo the job was created with.
    label: found.item.origin === "seed" ? "Logo bawaan" : "Logo",
  };
  return view;
}
