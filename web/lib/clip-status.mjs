// A clip that failed to render. The pipeline keeps one failing clip from failing the whole job
// (src/ai_clipper/pipeline.py, "One clip failing to render"): its manifest entry has no file,
// `status: "failed"` and an `error_code`, and the job stores it as `{status: "failed",
// errorCode}` without any file link. Every view shows it as "Gagal", with nothing to play,
// pick, download or edit. Client-safe: no Node built-ins.
import { d } from "./i18n/descriptor.mjs";

export const CLIP_ERROR_CODES = Object.freeze(["render_failed", "render_timeout"]);
const DEFAULT_ERROR_CODE = CLIP_ERROR_CODES[0];

// The failed clip's card, as catalog descriptors.
const FAILED_LABEL = Object.freeze(d("status.process.failed"));
const FAILED_TEXT = Object.freeze({
  render_failed: Object.freeze(d("project.failedClip.render_failed")),
  render_timeout: Object.freeze(d("project.failedClip.render_timeout")),
});
const FAILED_HINT = Object.freeze(d("project.failedClip.hint"));

/** One of the engine's codes; anything else (missing, unknown, free text) is `render_failed`. */
export function clipErrorCode(value) {
  return CLIP_ERROR_CODES.includes(value) ? value : DEFAULT_ERROR_CODE;
}

export function isFailedClip(clip) {
  return clip !== null && typeof clip === "object" && clip.status === "failed";
}

/** The clips that have a file: everything but the failed ones. */
export function readyClips(clips) {
  return (Array.isArray(clips) ? clips : []).filter((clip) => !isFailedClip(clip));
}

export function clipCounts(clips) {
  const list = Array.isArray(clips) ? clips : [];
  const ready = readyClips(list).length;
  return { total: list.length, ready, failed: list.length - ready };
}

/** "5 klip", or "4 klip · 1 gagal" when some failed. */
export function clipCountText(clips) {
  const { ready, failed } = clipCounts(clips);
  return failed ? `${ready} klip · ${failed} gagal` : `${ready} klip`;
}

/** What a failed clip's card says (`{label, text, hint}` descriptors), or null for a clip that rendered. */
export function failedClipView(clip) {
  if (!isFailedClip(clip)) return null;
  return { label: FAILED_LABEL, text: FAILED_TEXT[clipErrorCode(clip.errorCode)], hint: FAILED_HINT };
}
