// Entry of the T3.5 Rapikan e2e harness (bundled by ./bundle.mjs; never imported by the app).
// It mounts the real transcript panel over the **real** editor store (web/lib/editor/store.mjs,
// with the real Appendix B commands) and an in-memory API serving one clip: a words artifact, its
// seed document and its Rapikan list, all from `window.__HARNESS_CONFIG__`:
//   { words, doc, cleanup, readOnly?, cleanupFailures? (the first n cleanup() calls reject),
//     apiProp? (false: the panel gets no `api` prop and asks the route itself) }
// Autosave, the draft channel and the page lifecycle are held off so a spec sees the pending log
// of its own commands. The harness player (./harness-player.mjs) advances frames in real time.
import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import { createEditorStore } from "../../../../lib/editor/store.mjs";
import { pieces, totalFrames } from "../../../../lib/editor/timemap.mjs";
import { fakePlan } from "../../__dev__/fakes.mjs";
import editorStyles from "../../editor.module.css";
import TranscriptPanel from "../TranscriptPanel.jsx";
import { createHarnessPlayer } from "./harness-player.mjs";

const clone = (value) => JSON.parse(JSON.stringify(value));
const etagOf = (n) => n.toString(16).padStart(64, "0");

function createMemoryApi({ doc, words, cleanup, readOnly = false, cleanupFailures = 0 }) {
  const seed = clone(doc);
  let current = clone(doc);
  let version = 1;
  let failures = cleanupFailures;
  const calls = [];
  const edit = (target, isSeed) => ({
    doc: clone(target), etag: etagOf(version), seed: isSeed, readOnly, readOnlyReason: readOnly ? "transcript_changed" : null,
    words: { sha256: seed.base.words.sha256, url: `/api/jobs/${seed.base.job_id}/clips/${seed.clip_id}/words` },
    notices: [], engine: seed.base.engine.compiler,
  });
  return {
    calls,
    async getEdit({ seed: wantSeed = false } = {}) {
      calls.push("getEdit");
      return wantSeed ? { ...edit(seed, true), etag: etagOf(1) } : edit(current, current.revision === 0);
    },
    async words() {
      calls.push("words");
      return clone(words);
    },
    async putEdit(next) {
      calls.push("putEdit");
      version += 1;
      current = clone(next);
      return { doc: clone(current), etag: etagOf(version), warnings: [] };
    },
    async prepare() {
      calls.push("prepare");
      return { words: "ready", camera: "not_needed", plate: { state: "ready", ready: 1, total: 1 } };
    },
    async cleanup() {
      calls.push("cleanup");
      if (failures > 0) {
        failures -= 1;
        const error = new Error("cleanup unavailable");
        error.status = 503;
        error.code = "backend_unavailable";
        throw error;
      }
      return clone(cleanup);
    },
  };
}

function planOf(doc) {
  const plan = fakePlan(doc);
  plan.pieces = pieces(doc);
  plan.totalFrames = totalFrames(plan.pieces);
  plan.cues = [];
  plan.hook = null;
  return plan;
}

function Harness({ store, player, api }) {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  return (
    <div className={editorStyles.tokens} style={{ display: "grid", gridTemplateColumns: "var(--ed-panel-width) 1fr",
      height: "100vh", background: "var(--ed-color-bg)", color: "var(--ed-color-text)", fontFamily: "var(--ed-font-ui)" }}>
      <aside style={{ overflow: "auto", borderRight: "1px solid var(--ed-color-border)", background: "var(--ed-color-surface)" }}>
        <TranscriptPanel state={state} dispatch={store.dispatch} player={player} {...(api ? { api } : {})} />
      </aside>
      <main aria-label="Panggung" data-harness-stage style={{ background: "var(--ed-color-stage)" }} />
    </div>
  );
}

const config = window.__HARNESS_CONFIG__ ?? {};
const api = createMemoryApi(config);
const store = createEditorStore({
  jobId: config.doc.base.job_id, clipId: config.doc.clip_id, api,
  previewClient: { plan: async (doc) => planOf(doc) },
  autosave: { debounceMs: 3_600_000, maxIntervalMs: 3_600_000 }, channel: null, lifecycle: null, tabStorage: null,
  planPollMs: 0,
});
const player = createHarnessPlayer({ fps: config.doc.output.fps });
store.subscribe((state) => { if (state.plan) player.load(state.plan); });

window.__harness = { store, player, api, config, ready: false };
store.ready.then(() => {
  createRoot(document.getElementById("root")).render(
    <Harness store={store} player={player} api={config.apiProp === false ? null : api} />,
  );
  window.__harness.ready = true;
});
