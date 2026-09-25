// The seam between the Editor V3 shell and the Appendix A.2 modules (T2.6).
//
// `createEditorRuntime({ kind })` returns { api, previewClient, store, createPlayer, pollMs,
// newKey, destroy }:
//   - "fake": the T1.Z fakes (web/components/editor/__dev__/fakes.mjs), loaded only when the page
//     runs with POTONGIN_EDITOR_FAKES=1 (dev and CI). An e2e spec may wrap each object through
//     `scenario` hooks (window.__potonginEditorScenario, installed before the page loads).
//   - "real": the W2 integrator (T2.Z) wires createApiClient, createPreviewClient,
//     createEditorStore and createPlayer here (plan §11.2 "Wiring: replace the fakes"); in phase
//     B those modules are not on this branch, so it reports `runtime_unavailable`.
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
    pollMs: Number.isInteger(scenario?.pollMs) && scenario.pollMs > 0 ? scenario.pollMs : 1000,
    newKey: uuid,
    destroy() {
      store.destroy();
    },
  };
}

export async function createEditorRuntime({ kind, jobId, clipId, scenario = null }) {
  if (kind === "fake") return createFakeRuntime({ jobId, clipId, scenario });
  // T2.Z: build the real runtime here from web/lib/editor/{api-client,preview-client,store}.mjs,
  // the draft store and web/lib/editor/player/player.mjs, with the same return shape.
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
 * `subscribeFrame(fn)` and `frame()` from the frame bus.
 */
export function createPlayerFacade(bus) {
  let player = null;
  return {
    attach(next) { player = next; },
    detach() { player = null; },
    get attached() { return Boolean(player); },
    load(plan) { player?.load(plan); },
    async play() { if (player) await player.play(); },
    pause() { player?.pause(); },
    async seek(frame) { if (player) await player.seek(frame); },
    async step(delta) { if (player) await player.step(delta); },
    async showTruthFrame(frame) { if (player) await player.showTruthFrame(frame); },
    state() { return player ? player.state() : null; },
    frame: () => bus.get(),
    subscribeFrame: (listener) => bus.subscribe(listener),
  };
}
