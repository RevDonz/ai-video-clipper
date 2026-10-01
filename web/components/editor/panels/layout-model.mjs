// The layout panel's rules (plan §11.3 T3.6, §5.7, §3.3 `layout.default.mode`, Appendix B
// `SetLayout`, Appendix C.6). Pure functions, no DOM; the panel (LayoutPanel.jsx) and its node
// tests use them.
//
// - Three layouts for the whole clip (Essentials): fit-blur, face-track (`camera`), center-crop.
// - A thumbnail is the truth frame (plan §4.2 `preview/frame`) of the current document with only
//   its layout changed, at the playhead: the export's own pixels, text included.
// - Face-track needs the clip's camera plan (§5.7). `prepare {layout: "camera"}` builds it once for
//   the clip window (idempotent: instant when it exists), so the panel analyses first and switches
//   after; the stage never shows a layout the server cannot plan.
// - The runs without a face are the plan's `no_face` warnings (one per run and piece, at the output
//   frame where it starts); each is a jump-to target.
import { formatClock, frameToMs, messageFor } from "../shell-model.mjs";

const option = (fields) => Object.freeze(fields);

export const LAYOUT_OPTIONS = Object.freeze([
  option({ id: "fit_blur", name: "Latar blur", note: "Seluruh gambar terlihat. Bagian atas dan bawah diisi versi blur dari gambar yang sama." }),
  option({ id: "camera", name: "Ikuti wajah", note: "Potongan 9:16 bergeser mengikuti wajah. Butuh analisis wajah sekali per klip; bagian tanpa wajah dipusatkan." }),
  option({ id: "fill_center", name: "Potong tengah", note: "Potongan 9:16 tetap di tengah gambar. Sisi kiri dan kanan terpotong." }),
]);
const IDS = LAYOUT_OPTIONS.map((entry) => entry.id);

export const ANALYSIS_TEXT = Object.freeze({
  running: "Menganalisis wajah…",
  failed: "Analisis wajah gagal:",
  needed: "Perlu analisis wajah",
  unavailable: "Contoh belum tersedia",
});

function knownLayout(mode) {
  if (!IDS.includes(mode)) throw new TypeError(`unknown layout: ${mode}`);
  return mode;
}

/** The document with only `layout.default.mode` changed (the same object when unchanged). */
export function withLayout(doc, mode) {
  knownLayout(mode);
  if (doc.layout.default.mode === mode) return doc;
  return { ...doc, layout: { ...doc.layout, default: { ...doc.layout.default, mode } } };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * What a thumbnail depends on besides its layout and frame: the document without its layout,
 * revision, parent and audit (canonical text), so an edit elsewhere refreshes the thumbnails and a
 * switch or a save does not.
 */
export function contentKey(doc) {
  if (!doc || typeof doc !== "object") return null;
  const { layout: _layout, revision: _revision, parent_sha256: _parent, audit: _audit, ...rest } = doc;
  return canonical(rest);
}

/** The layouts in the order their thumbnails are asked for: the current one first. */
export function thumbnailOrder(current) {
  return IDS.includes(current) ? [current, ...IDS.filter((id) => id !== current)] : [...IDS];
}

/** The output frame of the thumbnails: the playhead inside the clip (null without a plan). */
export function thumbnailFrame(playhead, plan) {
  const total = plan?.totalFrames;
  if (!Number.isSafeInteger(total) || total < 1) return null;
  const frame = Number.isFinite(playhead) ? Math.trunc(playhead) : 0;
  return Math.min(Math.max(frame, 0), total - 1);
}

/**
 * How a switch happens: "none" (already there), "dispatch" (`SetLayout` at once) or "analyze"
 * (face-track without its camera plan: `prepare {layout: "camera"}` first, then `SetLayout`).
 */
export function switchSteps({ target, current, cameraReady }) {
  knownLayout(target);
  if (target === current) return "none";
  if (target === "camera" && !cameraReady) return "analyze";
  return "dispatch";
}

/**
 * Whether the clip's camera plan is known to exist from the store alone: the seed names one (a
 * face-track seed). Otherwise it is unknown, and `prepare {layout: "camera"}` finds out (it answers
 * at once when the plan exists, so asking again costs one request).
 */
export function cameraReadyFromState(state = {}) {
  const named = state?.seed?.base?.camera?.sha256 ?? state?.doc?.base?.camera?.sha256 ?? null;
  return typeof named === "string" && /^[0-9a-f]{64}$/.test(named);
}

// Seconds per 180 s window of the camera analysis, measured on the five real sources in the
// image at 4 CPUs (docs/editor/evidence/W3/T3.6-camera-plan.json): the usual range shown while it
// runs without the server's progress.
export const CAMERA_SECONDS_PER_180S = Object.freeze([4.6, 13.4]);

/** The usual length of the camera analysis of this clip: `{minMs, maxMs}` scaled by its window. */
export function analysisRangeMs(doc) {
  const window = doc?.base?.window_ms;
  if (!Array.isArray(window) || !Number.isFinite(window[0]) || !Number.isFinite(window[1])) return null;
  const seconds = Math.max(0, window[1] - window[0]) / 1000;
  const [low, high] = CAMERA_SECONDS_PER_180S;
  return {
    minMs: Math.max(1, Math.round((seconds * low) / 180)) * 1000,
    maxMs: Math.max(1, Math.ceil((seconds * high) / 180)) * 1000,
  };
}

/** "5-15 dtk" (a hyphen: R-02 keeps dashes out of the copy). */
export function rangeText(range) {
  if (!range) return null;
  const low = Math.round(range.minMs / 1000);
  const high = Math.round(range.maxMs / 1000);
  return low === high ? `${high} dtk` : `${low}-${high} dtk`;
}

/**
 * The analysis line: `null` when nothing runs, otherwise `{determinate, value, max, percent, text,
 * tone}` (plus `seconds` when the progress is unknown). With the server's progress (`done`/`total`) it is a percentage; without, the elapsed
 * seconds and the usual range (never a made-up percentage).
 */
export function analysisView(analysis, nowMs) {
  if (!analysis || (analysis.state !== "running" && analysis.state !== "failed")) return null;
  if (analysis.state === "failed") {
    return { determinate: false, value: null, max: null, percent: null, tone: "danger",
      text: `${ANALYSIS_TEXT.failed} ${messageFor(analysis.code ?? "internal_error")}` };
  }
  if (Number.isSafeInteger(analysis.total) && analysis.total > 0 && Number.isSafeInteger(analysis.done)) {
    const done = Math.min(Math.max(analysis.done, 0), analysis.total);
    const percent = Math.floor((done * 100) / analysis.total);
    return { determinate: true, value: done, max: analysis.total, percent, tone: "busy",
      text: `${ANALYSIS_TEXT.running} ${percent}%` };
  }
  const elapsed = Math.max(0, Math.floor((nowMs - (analysis.startedAt ?? nowMs)) / 1000));
  const range = analysis.range ?? null;
  const tail = !range ? "" : elapsed * 1000 > range.maxMs * 2 ? " (lebih lama dari biasanya)" : ` (biasanya ${rangeText(range)})`;
  return { determinate: false, value: null, max: null, percent: null, seconds: elapsed, tone: "busy",
    text: `${ANALYSIS_TEXT.running} ${elapsed} dtk${tail}` };
}

/** The runs without a face of a plan: `[{f, time}]`, one per start frame inside the clip, sorted. */
export function noFaceList(plan) {
  const warnings = Array.isArray(plan?.warnings) ? plan.warnings : [];
  const total = Number.isSafeInteger(plan?.totalFrames) ? plan.totalFrames : 0;
  const frames = new Set();
  for (const warning of warnings) {
    if (warning?.code !== "no_face" || !Number.isSafeInteger(warning.f)) continue;
    if (warning.f < 0 || warning.f >= total) continue;
    frames.add(warning.f);
  }
  return [...frames].sort((a, b) => a - b).map((f) => ({ f, time: formatClock(frameToMs(f, plan.fps)) }));
}
