// Mode Cepat's card summaries and the Tata letak card's order (docs/plans/2026-10-02-editor-mode-cepat.md
// §1.3, §1.4). Each card header shows one line that says what the card is set to, so the viewer
// reads the clip's setup without opening the cards. Pure; no DOM.
import { JOIN_STYLE_NAMES, coldOpen, musicItem } from "../../../lib/editor/doc-model.mjs";
import { linesSummary } from "../../../lib/editor/caption-lines.mjs";
import { logoOf } from "../gizmos/logo-geometry.mjs";
import { CAPTION_PACKS, CAPTION_POSITIONS, CAPTION_SIZES, presetId } from "../panels/caption-model.mjs";
import { hookItemOf } from "../panels/hook-model.mjs";
import { analysisBusy } from "../panels/layout-analysis.mjs";
import { LAYOUT_OPTIONS } from "../panels/layout-model.mjs";

const OFF = "Mati";
const byId = (list, id) => list.find((entry) => entry.id === id) ?? null;

/** The card's three layouts in the mockup's order (the panel lists face-track second). */
export const CARD_LAYOUTS = Object.freeze(["fit_blur", "fill_center", "camera"].map((id) => byId(LAYOUT_OPTIONS, id)));

/** "Karaoke · Sedang · Bawah"; an off-preset size or position shows its percent; "Mati" when off. */
export function captionSummary(doc) {
  const captions = doc?.captions;
  if (!captions) return "";
  if (captions.enabled === false) return OFF;
  const pack = byId(CAPTION_PACKS, captions.pack?.id)?.name ?? captions.pack?.id ?? "";
  const overrides = captions.overrides ?? {};
  const size = byId(CAPTION_SIZES, presetId(CAPTION_SIZES, overrides.size_pm))?.label ?? `${Math.round(overrides.size_pm / 10)}%`;
  const position = byId(CAPTION_POSITIONS, presetId(CAPTION_POSITIONS, overrides.y_e5))?.label
    ?? `posisi ${Math.round(overrides.y_e5 / 1000)}%`;
  return [pack, size, position].join(" · ");
}

/** The hook text, or "Mati". */
export function hookSummary(doc) {
  if (!doc) return "";
  return hookItemOf(doc)?.payload?.text || OFF;
}

/** The transition at the join ("Kilat putih + whoosh"), or "Mati" without a cold open. */
export function coldOpenSummary(doc) {
  if (!doc) return "";
  const join = coldOpen(doc) ? doc.main?.joins?.[0] ?? null : null;
  if (!join) return OFF;
  const name = JOIN_STYLE_NAMES[join.style] ?? join.style;
  return join.sfx ? `${name} + whoosh` : name;
}

/** The layout's name, plus " · menganalisis…" while the face analysis runs. */
export function layoutSummary(doc, analysis = null) {
  const mode = doc?.layout?.default?.mode;
  if (!mode) return "";
  const name = byId(LAYOUT_OPTIONS, mode)?.name ?? mode;
  return analysisBusy(analysis) ? `${name} · menganalisis…` : name;
}

/** "Belum ada", "Logo", "Musik" or "Logo dan musik". */
export function extrasSummary(doc) {
  if (!doc) return "";
  const logo = logoOf(doc) !== null;
  const music = musicItem(doc) !== null;
  if (logo && music) return "Logo dan musik";
  if (logo) return "Logo";
  if (music) return "Musik";
  return "Belum ada";
}

/** The summary of card `id` for the store state (and the clip's face analysis). */
export function cardSummary(id, { state = null, analysis = null } = {}) {
  const doc = state?.doc ?? null;
  switch (id) {
    case "hook": return hookSummary(doc);
    case "caption": return captionSummary(doc);
    case "lines": return state ? linesSummary({ plan: state.plan ?? null, doc, words: state.words ?? null }) : "";
    case "coldopen": return coldOpenSummary(doc);
    case "layout": return layoutSummary(doc, analysis);
    case "extras": return extrasSummary(doc);
    default: return "";
  }
}
