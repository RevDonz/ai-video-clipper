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

/** The name of a job's render mode, or null for an unknown one. */
export function renderModeName(renderMode) {
  return Object.hasOwn(RENDER_MODE_LAYOUTS, renderMode) ? LAYOUT_NAMES[RENDER_MODE_LAYOUTS[renderMode]] : null;
}
