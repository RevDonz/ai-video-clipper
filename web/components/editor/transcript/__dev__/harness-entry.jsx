// Entry of the T2.7 e2e harness page (bundled by ./bundle.mjs; never imported by the app).
// It mounts the W2 left-panel tabs from the real registry (panels/index.mjs) the way the editor
// shell does, over the harness store and player, at the editor's panel width. Config comes from
// `window.__HARNESS_CONFIG__` = { dataset: "demo" | "long1500", panel, readOnly, words?, doc? }.
import { Suspense, lazy, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import editorStyles from "../../editor.module.css";
import { PANELS } from "../../panels/index.mjs";
import { dataset } from "./harness-data.mjs";
import { createHarnessPlayer } from "./harness-player.mjs";
import { createHarnessStore } from "./harness-store.mjs";

const lazyPanels = new Map(PANELS.map((entry) => [entry.id, lazy(entry.load)]));

function Harness({ store, player, initialPanel }) {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const [panelId, setPanelId] = useState(initialPanel);
  const Panel = lazyPanels.get(panelId);
  return (
    <div className={editorStyles.tokens} style={{ display: "grid", gridTemplateColumns: "var(--ed-panel-width) 1fr",
      height: "100vh", background: "var(--bg)", color: "var(--text)", fontFamily: "var(--ed-font-ui)" }}>
      <aside style={{ overflow: "auto", borderRight: "1px solid var(--border)", background: "var(--surface)" }}>
        <div role="tablist" aria-label="Panel editor">
          {PANELS.map((entry) => (
            <button key={entry.id} type="button" role="tab" id={`editor-tab-${entry.id}`} aria-selected={entry.id === panelId}
              aria-controls="editor-panel" onClick={() => setPanelId(entry.id)}>
              {entry.label}
            </button>
          ))}
        </div>
        <div role="tabpanel" id="editor-panel" aria-labelledby={`editor-tab-${panelId}`}>
          <Suspense fallback={<p>Membuka panel…</p>}>
            <Panel state={state} dispatch={store.dispatch} player={player} />
          </Suspense>
        </div>
      </aside>
      <main aria-label="Panggung" data-harness-stage style={{ background: "var(--bg)" }} />
    </div>
  );
}

const config = window.__HARNESS_CONFIG__ ?? {};
const data = config.words && config.doc ? { words: config.words, doc: config.doc } : dataset(config.dataset ?? "demo");
const store = createHarnessStore({ words: data.words, doc: data.doc, readOnly: Boolean(config.readOnly) });
const player = createHarnessPlayer({ fps: data.doc.output.fps });
player.load(store.getState().plan);
store.subscribe((state) => { if (state.plan) player.load(state.plan); });

window.__harness = { store, player, words: data.words, config, ready: false };
createRoot(document.getElementById("root")).render(
  <Harness store={store} player={player} initialPanel={config.panel ?? PANELS[0].id} />,
);
window.__harness.ready = true;
