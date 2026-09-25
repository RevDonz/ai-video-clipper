// Registry of the editor's left-panel tabs (plan Appendix C.1), landed by the W1 integrator
// (T1.Z) before W2 starts. It lists every W2 panel; each W2 task replaces its own placeholder
// file and never edits this list (plan §11.0). T2.Z added the W3 entries (Tata letak, Logo,
// Musik) at the end of W2; W3 tasks replace their placeholder files.
//
// Every panel component receives the same props: `{ state, dispatch, player }`, where `state`
// is `store.getState()` and `dispatch` is `store.dispatch` (Appendix A.2).
// `load` is a lazy import, so this file stays importable outside the bundler (node tests).
const entry = (fields) => Object.freeze(fields);

export const PANELS = Object.freeze([
  entry({
    id: "transcript", label: "Transkrip", wave: "W2", owner: "T2.7", component: "TranscriptPanel",
    file: "transcript/TranscriptPanel.jsx", load: () => import("../transcript/TranscriptPanel.jsx"),
  }),
  entry({
    id: "text", label: "Teks", wave: "W2", owner: "T2.7", component: "TextPanel",
    file: "panels/TextPanel.jsx", load: () => import("./TextPanel.jsx"),
  }),
  entry({
    id: "coldopen", label: "Cold open", wave: "W2", owner: "T2.7", component: "ColdOpenPanel",
    file: "panels/ColdOpenPanel.jsx", load: () => import("./ColdOpenPanel.jsx"),
  }),
  // W3 (landed by T2.Z; each task replaces its placeholder file, never this list).
  entry({
    id: "layout", label: "Tata letak", wave: "W3", owner: "T3.6", component: "LayoutPanel",
    file: "panels/LayoutPanel.jsx", load: () => import("./LayoutPanel.jsx"),
  }),
  entry({
    id: "logo", label: "Logo", wave: "W3", owner: "T3.2", component: "LogoPanel",
    file: "panels/LogoPanel.jsx", load: () => import("./LogoPanel.jsx"),
  }),
  entry({
    id: "music", label: "Musik", wave: "W3", owner: "T3.3", component: "MusicPanel",
    file: "panels/MusicPanel.jsx", load: () => import("./MusicPanel.jsx"),
  }),
]);

export function panelById(id) {
  return PANELS.find((panel) => panel.id === id) ?? null;
}
