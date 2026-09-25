"use client";

// Editor V3 shell skeleton (plan Appendix C.1), landed by the W1 integrator (T1.Z). T2.6
// replaces this file with the real shell; until then it fixes the seams W2 builds against:
//
// - `store` is `createEditorStore(...)` and `player` is `createPlayer(...)` (Appendix A.2);
//   `__dev__/fakes.mjs` provides both for e2e specs that run before the integrator wires the
//   real modules.
// - The left panel's tabs come from `panels/index.mjs` and the timeline lanes from
//   `timeline/lanes.mjs`; phase-B tasks replace the placeholder files, never the registries.
// - `slots` take the parts T2.6 builds: `topBar`, `stage`, `stageControls`, `checks` and
//   `dialogs` (export, conflict, read-only banner). A missing slot renders nothing.
import { Suspense, lazy, useState, useSyncExternalStore } from "react";

import styles from "./editor.module.css";
import { PANELS } from "./panels/index.mjs";
import { LANES } from "./timeline/lanes.mjs";

const components = new Map();

function lazyComponent(entry) {
  if (!components.has(entry.file)) components.set(entry.file, lazy(entry.load));
  return components.get(entry.file);
}

const EMPTY_STATE = Object.freeze({ status: "loading", plan: null, pending: [], warnings: [] });

function useStoreState(store) {
  return useSyncExternalStore(
    (onChange) => (store ? store.subscribe(() => onChange()) : () => {}),
    () => (store ? store.getState() : EMPTY_STATE),
    () => EMPTY_STATE,
  );
}

export default function EditorApp({ store = null, player = null, slots = {}, initialPanel = PANELS[0].id }) {
  const state = useStoreState(store);
  const [panelId, setPanelId] = useState(initialPanel);
  const panel = PANELS.find((entry) => entry.id === panelId) ?? PANELS[0];
  const Panel = lazyComponent(panel);
  const dispatch = store ? store.dispatch : () => {};
  const pxPerFrame = 2;

  return (
    <div
      className={styles.tokens}
      data-editor-status={state.status}
      style={{
        display: "grid",
        gridTemplateRows: "var(--ed-topbar-height) 1fr var(--ed-timeline-height)",
        gridTemplateColumns: "var(--ed-panel-width) 1fr",
        minWidth: "var(--ed-min-width)",
        height: "100vh",
        background: "var(--ed-color-bg)",
        color: "var(--ed-color-text)",
        fontFamily: "var(--ed-font-ui)",
      }}
    >
      <header style={{ gridColumn: "1 / -1" }} data-slot="topBar">{slots.topBar ?? null}</header>

      <aside data-slot="panels" style={{ overflow: "auto", borderRight: "1px solid var(--ed-color-border)" }}>
        <div role="tablist" aria-label="Panel editor">
          {PANELS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              id={`editor-tab-${entry.id}`}
              aria-selected={entry.id === panel.id}
              aria-controls="editor-panel"
              onClick={() => setPanelId(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <div role="tabpanel" id="editor-panel" aria-labelledby={`editor-tab-${panel.id}`}>
          <Suspense fallback={<p>Membuka panel…</p>}>
            <Panel state={state} dispatch={dispatch} player={player} />
          </Suspense>
        </div>
      </aside>

      <main data-slot="stage" style={{ display: "flex", flexDirection: "column", background: "var(--ed-color-stage)" }}>
        {slots.stage ?? null}
        {slots.stageControls ?? null}
      </main>

      <section data-slot="timeline" aria-label="Timeline" style={{ gridColumn: "1 / -1", overflow: "auto" }}>
        <Suspense fallback={null}>
          {LANES.map((entry) => {
            const Lane = lazyComponent(entry);
            return (
              <div key={entry.id} data-lane-row={entry.id} style={{ height: "var(--ed-lane-height)" }}>
                <Lane plan={state.plan} state={state} dispatch={dispatch} player={player} pxPerFrame={pxPerFrame} />
              </div>
            );
          })}
        </Suspense>
      </section>

      {slots.checks ?? null}
      {slots.dialogs ?? null}
    </div>
  );
}
