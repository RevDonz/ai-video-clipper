// One Indonesian name per layout, shared by the dashboard's job form (dashboard-choices.mjs) and
// the editor (components/editor/panels/layout-model.mjs), so a clip's layout reads the same
// everywhere. Keys are the document's `layout.default.mode`; a job's render modes
// (jobs.mjs RENDER_MODES) are the same layouts under the engine's older ids. Client-safe.

export const LAYOUT_NAMES = Object.freeze({
  fit_blur: "Latar blur",
  camera: "Ikuti wajah",
  fill_center: "Potong tengah",
  split: "Layar terbagi",
});

export const RENDER_MODE_LAYOUTS = Object.freeze({
  "fit-blur": "fit_blur",
  "face-track": "camera",
  "center-crop": "fill_center",
});

// The catalog keys (messages/*/layout.json names.<mode>): every layout plus Otomatis, which the
// job form offers from Fase 7 (rombak 04 §A8.3). Components read them through
// components/layout-names.jsx.
export const LAYOUT_NAME_MODES = Object.freeze([...Object.keys(LAYOUT_NAMES), "auto"]);

/** The layout mode of a job's render mode ("face-track" -> "camera"), or null. */
export function renderModeLayout(renderMode) {
  return Object.hasOwn(RENDER_MODE_LAYOUTS, renderMode) ? RENDER_MODE_LAYOUTS[renderMode] : null;
}

/** The name of a job's render mode, or null for an unknown one. */
export function renderModeName(renderMode) {
  return Object.hasOwn(RENDER_MODE_LAYOUTS, renderMode) ? LAYOUT_NAMES[RENDER_MODE_LAYOUTS[renderMode]] : null;
}
