// The caption rules both editor views share (docs/plans/2026-10-02-editor-mode-cepat.md §1.4,
// §3, AC5, AC7): the packs, the Cepat size and position presets, the commands each caption
// control sends, and the notes under the controls. Mode Cepat's Caption card and Mode Lengkap's
// Teks panel both call these, so the two views build the same command and show the same text for
// the same document. Pure; no DOM.
import { CAPTION_SWATCHES } from "../../../lib/editor/content-colours.mjs";
import { captionAtSeedSpot } from "../shell-model.mjs";

export { CAPTION_SWATCHES };

const freeze = (list) => Object.freeze(list.map((entry) => Object.freeze(entry)));

/** The four packs, in the panel's order; their thumbnails live with the components (pack-thumbs/). */
export const CAPTION_PACKS = freeze([
  { id: "classic", name: "Klasik", note: "Putih bergaris hitam" },
  { id: "karaoke", name: "Karaoke", note: "Kata terucap menyala" },
  { id: "bold", name: "Bold", note: "Tebal, kata aktif berwarna" },
  { id: "box", name: "Box", note: "Teks di kotak gelap" },
]);

/** The packs that light the spoken word in the highlight colour. */
export const HIGHLIGHT_PACKS = Object.freeze(["karaoke", "bold"]);

/** Mode Cepat's "Ukuran" (`size_pm`): Sedang is the seed size. */
export const CAPTION_SIZES = freeze([
  { id: "kecil", label: "Kecil", value: 850 },
  { id: "sedang", label: "Sedang", value: 1000 },
  { id: "besar", label: "Besar", value: 1200 },
]);

/** Mode Cepat's "Posisi" (`y_e5`, the bottom of the caption block): Bawah is the seed spot (K5). */
export const CAPTION_POSITIONS = freeze([
  { id: "atas", label: "Atas", value: 38000 },
  { id: "tengah", label: "Tengah", value: 60000 },
  { id: "bawah", label: "Bawah", value: 83000 },
]);

/** The hook hint shows when the caption's bottom is less than this above the hook's top (§3). */
export const HOOK_NEAR_BAND_E5 = 35000;

export const CAPTION_NOTES = Object.freeze({
  highlightOn: "Kata yang sedang diucapkan.",
  highlightOff: "Dipakai oleh Karaoke dan Bold; tidak tampak di gaya ini.",
  zoneAtSeed: "Posisi bawaan, dekat tombol TikTok. Kalau tertutup, geser caption ke atas.",
  zoneMoved: "Caption masuk area tombol TikTok/Reels; geser ke atas bila tertutup.",
  hookNear: "Caption dekat teks hook. Kalau bertumpuk di pratinjau, turunkan caption.",
});

/** The id of the preset whose value is `value`; null when the value is off the presets. */
export function presetId(options, value) {
  return options.find((option) => option.value === value)?.id ?? null;
}

/**
 * One caption override (`size_pm`, `y_e5`, `case`, `highlight`, `emphasis`). A pick (a pill, a
 * swatch, a checkbox) is its own undo step; a slider drag merges per key (`cap:<key>`).
 */
export function captionCommand(key, value, { drag = false } = {}) {
  return { type: "SetCaptionOverride", args: { key, value }, mergeKey: drag ? `cap:${key}` : null };
}

export function captionPackCommand(id) {
  return { type: "SetCaptionPack", args: { id }, mergeKey: null };
}

export function captionsEnabledCommand(on) {
  return { type: "SetCaptionsEnabled", args: { on: Boolean(on) }, mergeKey: null };
}

/** The note under "Warna sorot" for the pack in use. */
export function highlightNote(packId) {
  return HIGHLIGHT_PACKS.includes(packId) ? CAPTION_NOTES.highlightOn : CAPTION_NOTES.highlightOff;
}

/**
 * The caption's TikTok-zone note from the plan's `unsafe_zone` warning (plan §3.7, K5), or null.
 * The caption's warning points at /captions (or names no item: the hook's carries its id). At the
 * auto clip's own spot it is a calm note, elsewhere a warning: `{ tone: "note" | "warning", text }`.
 */
export function captionZoneNote(doc, seed, plan) {
  const warnings = Array.isArray(plan?.warnings) ? plan.warnings : [];
  const caption = warnings.some((warning) => warning?.code === "unsafe_zone"
    && (typeof warning.path === "string" ? warning.path.startsWith("/captions") : !warning.ref));
  if (!caption) return null;
  return captionAtSeedSpot(doc, seed)
    ? { tone: "note", text: CAPTION_NOTES.zoneAtSeed }
    : { tone: "warning", text: CAPTION_NOTES.zoneMoved };
}

function hookItemOf(doc) {
  return doc?.tracks?.find((track) => track.kind === "hook")?.items?.[0] ?? null;
}

/**
 * The hint that the caption sits close under the hook (§3): with captions and the hook on, when
 * the caption block's bottom is less than HOOK_NEAR_BAND_E5 below the hook's top. A hint, not a
 * check: the preview is exact, so the text says "kalau". Null otherwise.
 */
export function hookNearNote(doc) {
  if (doc?.captions?.enabled !== true) return null;
  const hook = hookItemOf(doc);
  const top = hook?.transform?.y_e5;
  const bottom = doc.captions.overrides?.y_e5;
  if (!Number.isFinite(top) || !Number.isFinite(bottom)) return null;
  return bottom < top + HOOK_NEAR_BAND_E5 ? CAPTION_NOTES.hookNear : null;
}
