// Registry of Mode Cepat's cards (docs/plans/2026-10-02-editor-mode-cepat.md §1.2, §10), landed by
// Z0 with placeholder bodies. Each task replaces its own card file and never edits this list:
// B owns every card but Teks caption, which is C's.
//
// Every card body receives the panel props bundle (`state`, `dispatch`, `player`, `api`,
// `previewClient`, `uploadAsset`, `uploadsEnabled`, `notify`, `readOnly`) plus `frameBus` and
// `showLengkap(panelId)`. `load` is a lazy import, so this file stays importable in node tests.
const entry = (fields) => Object.freeze(fields);

export const CARDS = Object.freeze([
  entry({
    id: "hook", label: "Hook", owner: "B", component: "HookCard", panel: "text",
    file: "quick/HookCard.jsx", load: () => import("./HookCard.jsx"),
  }),
  entry({
    id: "caption", label: "Caption", owner: "B", component: "CaptionCard", panel: "text",
    file: "quick/CaptionCard.jsx", load: () => import("./CaptionCard.jsx"),
  }),
  entry({
    id: "lines", label: "Teks caption", owner: "C", component: "CaptionLinesCard", panel: "transcript",
    file: "quick/CaptionLinesCard.jsx", load: () => import("./CaptionLinesCard.jsx"),
  }),
  entry({
    id: "coldopen", label: "Cold open", owner: "B", component: "ColdOpenCard", panel: "coldopen",
    file: "quick/ColdOpenCard.jsx", load: () => import("./ColdOpenCard.jsx"),
  }),
  entry({
    id: "layout", label: "Tata letak", owner: "B", component: "LayoutCard", panel: "layout",
    file: "quick/LayoutCard.jsx", load: () => import("./LayoutCard.jsx"),
  }),
  entry({
    id: "extras", label: "Logo & Musik", owner: "B", component: "ExtrasCard", panel: "logo",
    file: "quick/ExtrasCard.jsx", load: () => import("./ExtrasCard.jsx"),
  }),
]);

/** The card open when Mode Cepat loads (§1.3): Caption, so no card asks the LLM on load (R1). */
export const DEFAULT_CARD = "caption";

export function cardById(id) {
  return CARDS.find((card) => card.id === id) ?? null;
}
