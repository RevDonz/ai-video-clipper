// Colours that belong to the clip, not to the app: the caption and hook colours a document may
// carry (the caption packs own them, DESIGN.md "Di luar dokumen ini") and the stand-in video frames
// of the logo harness and the dashboard preview. The UI's own colours are the tokens on :root in
// app/globals.css; pages and components import these values instead of writing colour literals
// (web/tests/ui-guards.test.mjs).

/** The caption highlight and emphasis colours the Teks panel offers. */
export const CAPTION_SWATCHES = Object.freeze([
  Object.freeze({ value: "#FFE14D", name: "Kuning" }),
  Object.freeze({ value: "#FFFFFF", name: "Putih" }),
  Object.freeze({ value: "#3DF5A6", name: "Hijau" }),
  Object.freeze({ value: "#52C7FF", name: "Biru" }),
  Object.freeze({ value: "#FF5C8A", name: "Merah muda" }),
  Object.freeze({ value: "#FF9F1C", name: "Oranye" }),
]);

/** The seed's highlight and emphasis colours when a document names none. */
export const DEFAULT_HIGHLIGHT = "#FFE14D";
export const DEFAULT_EMPHASIS = "#FF5C8A";

/**
 * The dashboard's 9:16 preview (app/dashboard/LookPreview.jsx) in place of a video: the backdrop
 * the subtitle thumbnails were rendered on (pack-thumbs/manifest.json), so they sit on it without
 * an edge, and the darker landscape picture of "Utuh + latar blur".
 */
export const PREVIEW_BACKDROP = "#4B5563";
export const PREVIEW_PICTURE = "#1F2937";

/** The two corners of the gradient the logo harness draws in place of a video frame. */
export const HARNESS_FRAME_GRADIENT = Object.freeze(["#1b2230", "#3b3024"]);
