// Entry of the T3.7 e2e harness page (bundled by transcript/__dev__/bundle.mjs; never imported by
// the app). It lays out the editor's frame (shell.module.css) with the Cold open panel from the
// real panel registry and the real Timeline with every lane of timeline/lanes.mjs, over the
// harness store and player. The page fetches peaks and cold-open suggestions from the real URLs;
// the spec answers them. Config: `window.__HARNESS_CONFIG__` = { words, doc, readOnly }.
import { Suspense, lazy, useMemo, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import tokens from "../../../editor.module.css";
import { PANELS } from "../../../panels/index.mjs";
import { createFrameBus } from "../../../runtime.mjs";
import styles from "../../../shell.module.css";
import { LANES } from "../../lanes.mjs";
import Timeline from "../../Timeline.jsx";
import { createHarnessPlayer, createHarnessStore } from "./markers-harness-store.mjs";

const coldOpenEntry = PANELS.find((entry) => entry.id === "coldopen");
const ColdOpenPanel = lazy(coldOpenEntry.load);

function Harness({ store, player, frameBus }) {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const notify = useMemo(() => (text) => { window.__harness.toasts.push(text); }, []);
  return (
    <div className={`${tokens.tokens} ${styles.shell}`} data-editor-root="" data-editor-ready="true">
      <div className={styles.topBar} aria-hidden="true" />
      <aside className={styles.panels} aria-label="Panel editor">
        <div className={styles.tabs} role="tablist" aria-label="Panel editor">
          <button type="button" role="tab" id="editor-tab-coldopen" className={styles.tab} aria-selected="true"
            aria-controls="editor-panel">{coldOpenEntry.label}</button>
        </div>
        <div className={styles.tabPanel} role="tabpanel" id="editor-panel" aria-labelledby="editor-tab-coldopen">
          <Suspense fallback={<p className={styles.muted}>Membuka panel…</p>}>
            <ColdOpenPanel state={state} dispatch={store.dispatch} player={player} />
          </Suspense>
        </div>
      </aside>
      <main className={styles.stageRegion} aria-label="Panggung" data-harness-stage="" />
      <Timeline plan={state.plan} state={state} dispatch={store.dispatch} player={player} frameBus={frameBus}
        notify={notify} readOnly={state.status !== "ready"} lanes={LANES} />
    </div>
  );
}

const config = window.__HARNESS_CONFIG__ ?? {};
const store = createHarnessStore({ words: config.words, doc: config.doc, readOnly: Boolean(config.readOnly) });
const frameBus = createFrameBus();
const player = createHarnessPlayer({ fps: config.doc.output.fps, frameBus });
player.load(store.getState().plan);
store.subscribe((state) => { if (state.plan) player.load(state.plan); });

window.__harness = { store, player, frameBus, config, toasts: [], ready: false };
createRoot(document.getElementById("root")).render(<Harness store={store} player={player} frameBus={frameBus} />);
window.__harness.ready = true;
