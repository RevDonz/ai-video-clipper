// Entry of the scrubber's e2e harness page (bundled by transcript/__dev__/bundle.mjs; never
// imported by the app). It mounts the real Scrubber in a bottom bar as wide as Mode Cepat's at
// 1366 px, over a document and a words artifact from the config (the marker fixtures), a frame
// bus like the runtime's and a player that records what the scrubber asks of it.
// Config: `window.__HARNESS_CONFIG__` = { doc, words, width? }. `window.__harness.setDoc(doc)`
// swaps the document (a new transition style, say) as a command would.
import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import tokens from "../../editor.module.css";
import { pieces, totalFrames } from "../../../../lib/editor/timemap.mjs";
import Scrubber from "../Scrubber.jsx";

// runtime.mjs's frame bus, without the runtime's player and clients.
function createFrameBus() {
  let frame = 0;
  const listeners = new Set();
  return {
    get: () => frame,
    set(next) {
      if (!Number.isFinite(next) || next === frame) return;
      frame = next;
      for (const listener of [...listeners]) listener(frame);
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(frame);
      return () => listeners.delete(listener);
    },
  };
}

function createStore(initial) {
  let state = initial;
  const listeners = new Set();
  return {
    get: () => state,
    set(next) {
      state = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function planOf(doc) {
  return { totalFrames: totalFrames(pieces(doc)), fps: doc.output.fps };
}

// The player as the scrubber sees it (the shell's facade): seek moves the frame bus, play and
// pause flip `playing`, and every call is recorded.
function createPlayer(frameBus) {
  let playing = false;
  const calls = [];
  return {
    calls,
    seek(frame) {
      calls.push(["seek", frame]);
      frameBus.set(frame);
      return Promise.resolve();
    },
    play() {
      calls.push(["play"]);
      playing = true;
      return Promise.resolve();
    },
    pause() {
      calls.push(["pause"]);
      playing = false;
    },
    state: () => ({ playing, frame: frameBus.get() }),
    frame: () => frameBus.get(),
    subscribeFrame: (listener) => frameBus.subscribe(listener),
  };
}

function Harness({ store, player, frameBus, width }) {
  const state = useSyncExternalStore(store.subscribe, store.get);
  return (
    <div className={tokens.tokens} style={{ padding: "80px 32px 24px", background: "var(--bg)", color: "var(--text)",
      fontFamily: "var(--ed-font-ui)" }}>
      <button type="button" data-harness-before="">Sebelum</button>
      <div data-harness-bar="" style={{ display: "flex", alignItems: "center", gap: 16, width, height: 96, padding: "0 16px",
        boxSizing: "border-box", borderTop: "1px solid var(--border)", background: "var(--surface)" }}>
        <Scrubber plan={state.plan} state={state} player={player} frameBus={frameBus} disabled={false} />
      </div>
      <button type="button" data-harness-after="">Sesudah</button>
    </div>
  );
}

const config = window.__HARNESS_CONFIG__ ?? {};
const frameBus = createFrameBus();
const player = createPlayer(frameBus);
const store = createStore({ doc: config.doc, words: config.words, plan: planOf(config.doc) });

window.__harness = {
  player,
  frameBus,
  config,
  plan: () => store.get().plan,
  setDoc(doc) {
    store.set({ ...store.get(), doc, plan: planOf(doc) });
  },
  ready: false,
};
createRoot(document.getElementById("root")).render(
  <Harness store={store} player={player} frameBus={frameBus} width={config.width ?? 900} />,
);
window.__harness.ready = true;
