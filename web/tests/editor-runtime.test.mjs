// T2.6: the seam between the editor shell and the Appendix A.2 modules
// (web/components/editor/runtime.mjs). "fake" builds the T1.Z fakes (dev and CI only, for the
// e2e specs); "real" is wired by the W2 integrator (plan §11.2 T2.Z "replace the fakes").
import assert from "node:assert/strict";
import test from "node:test";

import { FAKE_CLIP_ID, FAKE_JOB_ID } from "../components/editor/__dev__/fakes.mjs";
import { RuntimeUnavailable, createEditorRuntime, createFrameBus, createPlayerFacade } from "../components/editor/runtime.mjs";

test("the fake runtime builds the A.2 objects and loads the fixture clip", async () => {
  const runtime = await createEditorRuntime({ kind: "fake", jobId: FAKE_JOB_ID, clipId: FAKE_CLIP_ID });
  assert.equal(runtime.kind, "fake");
  for (const name of ["getEdit", "putEdit", "createRender", "getRender", "cancelRender", "clips"]) {
    assert.equal(typeof runtime.api[name], "function", name);
  }
  assert.equal(typeof runtime.previewClient.plan, "function");
  for (const name of ["getState", "dispatch", "undo", "redo", "flush", "subscribe", "destroy"]) {
    assert.equal(typeof runtime.store[name], "function", name);
  }
  await new Promise((resolve) => {
    if (runtime.store.getState().status === "ready") resolve();
    const off = runtime.store.subscribe((state) => { if (state.status === "ready") { off(); resolve(); } });
  });
  assert.equal(runtime.store.getState().doc.clip_id, FAKE_CLIP_ID);
  const states = [];
  const player = runtime.createPlayer({ canvas: null, video: null, onState: (state) => states.push(state), onFrame: () => {} });
  for (const name of ["load", "play", "pause", "seek", "step", "showTruthFrame", "state", "destroy"]) {
    assert.equal(typeof player[name], "function", name);
  }
  assert.equal(runtime.pollMs, 1000);
  assert.match(runtime.newKey(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  runtime.destroy();
});

test("scenario hooks wrap each object in order and may change the poll interval", async () => {
  const order = [];
  const scenario = {
    api(api, fakes) { order.push(["api", typeof fakes.fakePlan]); return { ...api, marker: "api" }; },
    previewClient(client) { order.push(["previewClient"]); return client; },
    store(store, fakes, parts) { order.push(["store", parts.api.marker]); return store; },
    player(player) { order.push(["player"]); return { ...player, marker: "player" }; },
    pollMs: 50,
  };
  const runtime = await createEditorRuntime({ kind: "fake", jobId: FAKE_JOB_ID, clipId: FAKE_CLIP_ID, scenario });
  const player = runtime.createPlayer({ canvas: null, video: null, onState: () => {}, onFrame: () => {} });
  assert.deepEqual(order, [["api", "function"], ["previewClient"], ["store", "api"], ["player"]]);
  assert.equal(player.marker, "player");
  assert.equal(runtime.pollMs, 50);
  runtime.destroy();
});

// T2.Z wired the "real" runtime (web/tests/editor-w2-seams.test.mjs covers it); any other kind
// still says the editor is not available.
test("an unknown runtime kind reports runtime_unavailable", async () => {
  await assert.rejects(createEditorRuntime({ kind: "other", jobId: FAKE_JOB_ID, clipId: FAKE_CLIP_ID }),
    (error) => error instanceof RuntimeUnavailable && error.code === "runtime_unavailable");
});

test("the frame bus notifies on change and replays the current frame to new subscribers", () => {
  const bus = createFrameBus();
  const seen = [];
  const off = bus.subscribe((frame) => seen.push(frame));
  bus.set(3);
  bus.set(3);
  bus.set(4);
  off();
  bus.set(9);
  assert.deepEqual(seen, [0, 3, 4]);
  assert.equal(bus.get(), 9);
});

test("a failing player call is reported, never an unhandled rejection", async () => {
  const errors = [];
  const facade = createPlayerFacade(createFrameBus(), { onError: (error, action) => errors.push([action, error.message]) });
  facade.attach({
    load() { throw new Error("bad plan"); }, play: async () => { throw new Error("autoplay"); }, pause() {},
    seek: async () => { throw new Error("decode"); }, step: async () => {}, showTruthFrame: async () => { throw new Error("503"); },
    state: () => null, destroy() {},
  });
  facade.load({});
  await facade.play();
  await facade.seek(3);
  await facade.showTruthFrame(3);
  assert.deepEqual(errors, [["load", "bad plan"], ["play", "autoplay"], ["seek", "decode"], ["showTruthFrame", "503"]]);
});

test("the player facade is stable before and after the player exists", async () => {
  const bus = createFrameBus();
  const facade = createPlayerFacade(bus);
  await facade.seek(10);
  await facade.play();
  facade.pause();
  assert.equal(facade.state(), null);
  const calls = [];
  const player = {
    load: (plan) => calls.push(["load", plan]), play: async () => calls.push(["play"]), pause: () => calls.push(["pause"]),
    seek: async (frame) => { calls.push(["seek", frame]); bus.set(frame); }, step: async (delta) => calls.push(["step", delta]),
    showTruthFrame: async (frame) => calls.push(["truth", frame]), state: () => ({ mode: "live", current: {}, frame: bus.get() }),
    destroy: () => calls.push(["destroy"]),
  };
  facade.attach(player);
  await facade.seek(12);
  await facade.step(-1);
  await facade.showTruthFrame(5);
  const frames = [];
  const off = facade.subscribeFrame((frame) => frames.push(frame));
  assert.equal(facade.frame(), 12);
  bus.set(13);
  off();
  assert.deepEqual(frames, [12, 13]);
  assert.equal(facade.state().mode, "live");
  facade.detach();
  assert.equal(facade.state(), null);
  assert.deepEqual(calls.map((call) => call[0]), ["seek", "step", "truth"]);
});
