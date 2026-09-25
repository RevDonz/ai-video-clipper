// The seam between the Editor V3 shell and the Appendix A.2 modules (T2.6).
//
// `createEditorRuntime({ kind })` returns { api, previewClient, store, createPlayer, setPlayhead,
// pollMs, newKey, destroy }:
//   - "fake": the T1.Z fakes (web/components/editor/__dev__/fakes.mjs), loaded only when the page
//     runs with POTONGIN_EDITOR_FAKES=1 (dev and CI). An e2e spec may wrap each object through
//     `scenario` hooks (window.__potonginEditorScenario, installed before the page loads).
//   - "real" (wired by T2.Z, plan §11.2 "Wiring: replace the fakes"): createApiClient and
//     createPreviewClient (web/lib/editor/), createEditorStore with the IndexedDB draft, the
//     BroadcastChannel and the page lifecycle, and createPlayer (web/lib/editor/player/) with
//     truth frames from the preview client for the current document. `setPlayhead(frame)` is the
//     output frame the preview lane builds first (sent with every plan request; T2.3).
//     `deps` replaces the browser pieces in unit tests.
//
// Also here: the frame bus (the playhead, the time readout and the transcript's active word are
// moved outside React, plan §6.2 "Seek and scrub") and a stable player facade that exists before
// the stage canvas does.

export class RuntimeUnavailable extends Error {
  constructor(message = "Editor V3 belum tersambung ke server") {
    super(message);
    this.name = "RuntimeUnavailable";
    this.code = "runtime_unavailable";
  }
}

function uuid() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function createFakeRuntime({ jobId, clipId, scenario }) {
  const fakes = await import("./__dev__/fakes.mjs");
  const hook = (name, value, ...rest) => (typeof scenario?.[name] === "function" ? scenario[name](value, fakes, ...rest) : value);
  const api = hook("api", fakes.createFakeApiClient());
  const previewClient = hook("previewClient", fakes.createFakePreviewClient());
  const store = hook("store", fakes.createFakeEditorStore({ jobId, clipId, api, previewClient }), { api, previewClient });
  return {
    kind: "fake",
    api,
    previewClient,
    store,
    createPlayer(options) {
      return hook("player", fakes.createFakePlayer(options), options);
    },
    setPlayhead() {},
    pollMs: Number.isInteger(scenario?.pollMs) && scenario.pollMs > 0 ? scenario.pollMs : 1000,
    newKey: uuid,
    destroy() {
      store.destroy();
    },
  };
}

const STORE_DEPS = Object.freeze(["draftStore", "channel", "lifecycle", "tabStorage", "now", "timers", "planPollMs"]);

async function createRealRuntime({ jobId, clipId, deps = {} }) {
  const [{ createApiClient, randomUuid }, { createPreviewClient }, { createEditorStore }] = await Promise.all([
    import("../../lib/editor/api-client.mjs"),
    import("../../lib/editor/preview-client.mjs"),
    import("../../lib/editor/store.mjs"),
  ]);
  const makePlayer = typeof deps.createPlayer === "function"
    ? deps.createPlayer
    : (await import("../../lib/editor/player/player.mjs")).createPlayer;
  const fetchImpl = typeof deps.fetchImpl === "function" ? deps.fetchImpl : (...args) => globalThis.fetch(...args);
  let playhead = 0;
  const api = createApiClient({ jobId, clipId, fetchImpl });
  const previewClient = createPreviewClient({ jobId, clipId, fetchImpl, playhead: () => playhead });
  const options = { jobId, clipId, api, previewClient };
  for (const name of STORE_DEPS) if (Object.hasOwn(deps, name)) options[name] = deps[name];
  const store = createEditorStore(options);
  return {
    kind: "real",
    api,
    previewClient,
    store,
    createPlayer(playerOptions = {}) {
      return makePlayer({
        ...playerOptions,
        fetchImpl: playerOptions.fetchImpl ?? fetchImpl,
        requestTruthFrame: (frame) => previewClient.frame(store.getState().doc, frame),
      });
    },
    setPlayhead(frame) {
      if (Number.isSafeInteger(frame) && frame >= 0) playhead = frame;
    },
    pollMs: 1000,
    newKey: () => randomUuid(),
    destroy() {
      store.destroy();
    },
  };
}

export async function createEditorRuntime({ kind, jobId, clipId, scenario = null, deps = {} }) {
  if (kind === "fake") return createFakeRuntime({ jobId, clipId, scenario });
  if (kind === "real") return createRealRuntime({ jobId, clipId, deps });
  throw new RuntimeUnavailable();
}

/** The current output frame, for DOM that follows playback without React renders. */
export function createFrameBus() {
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

/**
 * The player as panels and lanes see it (the `player` prop of panels/index.mjs and
 * timeline/lanes.mjs): the createPlayer methods, safe to call before the player exists, plus
 * `subscribeFrame(fn)` and `frame()` from the frame bus. A failing call goes to `onError` (the
 * shell shows it) instead of becoming an unhandled rejection in a click handler.
 */
export function createPlayerFacade(bus, { onError = () => {} } = {}) {
  let player = null;
  const guard = async (action, run) => {
    if (!player) return;
    try {
      await run(player);
    } catch (error) {
      onError(error, action);
    }
  };
  return {
    attach(next) { player = next; },
    detach() { player = null; },
    get attached() { return Boolean(player); },
    load(plan) {
      try {
        player?.load(plan);
      } catch (error) {
        onError(error, "load");
      }
    },
    play: () => guard("play", (target) => target.play()),
    pause() { player?.pause(); },
    seek: (frame) => guard("seek", (target) => target.seek(frame)),
    step: (delta) => guard("step", (target) => target.step(delta)),
    showTruthFrame: (frame) => guard("showTruthFrame", (target) => target.showTruthFrame(frame)),
    state() { return player ? player.state() : null; },
    stats() { return typeof player?.stats === "function" ? player.stats() : null; },
    frame: () => bus.get(),
    subscribeFrame: (listener) => bus.subscribe(listener),
  };
}
