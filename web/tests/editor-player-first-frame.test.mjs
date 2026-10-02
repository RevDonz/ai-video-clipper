// The paused picture of the editor player (fix/editor-first-frame): the frame at the playhead is
// painted as soon as its plate frame is decoded, with no Play and no user gesture.
//
// Seen on production (Brave on Linux, Chromium 146, no WebGL2): the stage stayed black with
// "Menyiapkan frame…" until Play. The plan's first piece starts at source-grid frame 2850, so frame
// 0 lives in plate cell 47 (k = ⌊2850 / 60⌋), index 30: the only cell the browser fetched. The
// paused present had one attempt at that frame; when it came back empty or failed, nothing asked
// again (playback asks on every tick, which is why Play "fixed" it).
import assert from "node:assert/strict";
import test from "node:test";

import { createPlayer } from "../lib/editor/player/player.mjs";

const FPS = [30, 1];
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) await tick();
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function planDto({ mix = "m1" } = {}) {
  const pieces = [{ i: 0, seg: "seg_b1", role: "body", inSf: 2850, outSf: 3000, outF0: 0, frames: 150 }];
  return {
    planSha256: `plan-${mix}`, docSha256: "d1", compiler: "edit-v2/1", renderSemantics: 1,
    fps: FPS, totalFrames: 150, output: { w: 720, h: 1280 }, pieces, cues: [], hook: null,
    text: { assSha256: "a1", ass: "[Script Info]\n", url: "/ass/a1.ass", fonts: [] },
    plate: { plateKey: "pk", cellFrames: 60, w: 720, h: 1280,
      cells: [47, 48, 49].map((k) => ({ k, state: "ready", url: `/media/plates/pk-c${String(k).padStart(7, "0")}.mp4` })) },
    logo: null,
    audio: { mixSha256: mix, state: "ready", url: `/media/audio/${mix}.flac`, samples: 240_000 },
    rev0: { planSha256: "rev0", autoRenderUrl: null, exact: false },
    warnings: [], errors: [],
  };
}

function fakeCanvas() {
  const draws = [];
  const kinds = [];
  const ctx = {
    globalCompositeOperation: "source-over",
    imageSmoothingEnabled: true,
    drawImage(image, x, y) { draws.push({ image, x, y }); },
  };
  const canvas = { width: 720, height: 1280, getContext(kind) { kinds.push(kind); return kind === "2d" ? ctx : null; } };
  return { canvas, draws, kinds };
}

/**
 * Layers as fakes. `need(k, j)` answers from `plateAnswers` in order ("frame", or an Error to
 * reject with), then "frame"; `audioGate` holds the mix decode (a context before any gesture).
 */
function makeDeps({ plateAnswers = [], audioGate = null } = {}) {
  let plateDto = null;
  const decoded = new Set();
  const needs = [];
  const timers = [];
  const plate = {
    setPlate(dto) { plateDto = dto; },
    cellState(k) {
      const cell = plateDto?.cells.find((item) => item.k === k);
      return cell ? (cell.state === "ready" && cell.url ? "ready" : "queued") : "missing";
    },
    readyCells() { return { ready: plateDto.cells.length, total: plateDto.cells.length }; },
    has(k, j) { return decoded.has(`${k}:${j}`); },
    frame(k, j) { return decoded.has(`${k}:${j}`) ? { layer: "plate", k, j } : null; },
    async need(k, j) {
      needs.push([k, j]);
      await tick();
      const answer = plateAnswers.length ? plateAnswers.shift() : "frame";
      if (answer instanceof Error) throw answer;
      if (answer === null) return null;
      decoded.add(`${k}:${j}`);
      return plate.frame(k, j);
    },
    ensure() { return Promise.resolve(); },
    stats() { return {}; },
    destroy() {},
  };
  const audio = {
    ready: false, mixSha256: null, buffer: null, context: null,
    async load(dto) {
      if (audioGate) await audioGate.promise;
      audio.ready = true;
      audio.mixSha256 = dto.mixSha256;
    },
    async start() {},
    stop() {},
    position() { return null; },
    destroy() {},
  };
  const deps = {
    createTextLayer: () => ({
      ready: Promise.resolve({ fonts: 0 }),
      async setTrack() {},
      async render(n) { return { frame: n, changed: true, parts: [{ bitmap: { layer: "text", n, close() {} }, x: 0, y: 900 }] }; },
      destroy() {},
    }),
    createPlateSource: () => plate,
    createAudioClock: () => audio,
    createWallClock: () => ({ start() {}, stop() {}, position: () => null }),
    createLogoLayer: () => ({ load: async () => {}, readyFor: () => true, draw() {}, destroy() {} }),
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    now: () => 0,
    supports: () => ({ live: true }),
    setTimeout: (callback, ms) => { timers.push({ callback, ms }); return timers.length; },
    clearTimeout: () => {},
  };
  /** Runs the timers the player set so far (the retries), in order. */
  async function runTimers() {
    while (timers.length) {
      timers.shift().callback();
      await settle();
    }
  }
  return { deps, plate, audio, needs, timers, runTimers };
}

function mount(env) {
  const { canvas, draws, kinds } = fakeCanvas();
  const player = createPlayer({
    canvas, fetchImpl: async () => ({ ok: true, status: 200, text: async () => "" }), deps: env.deps,
  });
  const plates = () => draws.filter((draw) => draw.image.layer === "plate").map((draw) => [draw.image.k, draw.image.j]);
  return { player, draws, kinds, plates };
}

test("the first frame is painted while the mix still decodes: no Play, no gesture", async () => {
  // Before a user gesture the AudioContext is suspended; nothing the picture needs comes from it.
  const audioGate = deferred();
  const env = makeDeps({ audioGate });
  const { player, plates } = mount(env);
  const loaded = player.load(planDto());
  await settle();
  assert.deepEqual(env.needs, [[47, 30]], "frame 0 is source frame 2850: cell 47, index 30");
  assert.deepEqual(plates(), [[47, 30]], "frame 0 is on the canvas before the mix is decoded");
  const state = player.state();
  assert.equal(state.presentedFrame, 0);
  assert.equal(state.playing, false);
  assert.deepEqual(state.pending, ["audio"], "the badge still names the mix, truthfully");
  assert.equal(state.exact, false);
  audioGate.resolve();
  await loaded;
  assert.equal(player.state().exact, true);
  player.destroy();
});

test("a paused frame whose plate decode failed is asked for again and painted without Play", async () => {
  const env = makeDeps({ plateAnswers: [new Error("plate_cell_failed:47:EncodingError: Decoder failure")] });
  const { player, plates } = mount(env);
  await player.load(planDto());
  await settle();
  assert.deepEqual(plates(), [], "the first attempt has no frame");
  assert.equal(player.state().error, null, "one failed attempt is not reported yet: the frame is still being prepared");
  assert.deepEqual(env.timers.map((timer) => timer.ms), [250]);
  await env.runTimers();
  assert.deepEqual(env.needs, [[47, 30], [47, 30]]);
  assert.deepEqual(plates(), [[47, 30]]);
  assert.equal(player.state().presentedFrame, 0);
  assert.equal(player.state().exact, true);
  assert.equal(player.state().error, null);
  player.destroy();
});

test("a frame that never comes is reported after the retries, not 'being prepared' forever", async () => {
  const failure = () => new Error("plate_cell_failed:47:EncodingError: Decoder failure");
  const env = makeDeps({ plateAnswers: [failure(), null, failure()] });
  const { player, plates } = mount(env);
  await player.load(planDto());
  await settle();
  await env.runTimers();
  assert.deepEqual(env.needs, [[47, 30], [47, 30], [47, 30]], "one attempt and two retries");
  assert.deepEqual(plates(), []);
  const state = player.state();
  assert.equal(state.presentedFrame, null);
  assert.equal(state.error?.layer, "plate");
  assert.match(state.error.message, /plate_cell_failed:47/);
  // A new request starts clean and, once its frame is drawn, the stage is exact again.
  const result = await player.seek(5);
  assert.deepEqual(result, { frame: 5, presented: true });
  assert.equal(player.state().error, null);
  assert.equal(player.state().exact, true);
  player.destroy();
});

test("a retry gives way to a newer seek and to playback", async () => {
  const env = makeDeps({ plateAnswers: [new Error("plate_cell_failed:47:x")] });
  const { player, plates } = mount(env);
  await player.load(planDto());
  await settle();
  assert.equal(env.timers.length, 1);
  await player.seek(20);
  await env.runTimers();
  assert.deepEqual(env.needs, [[47, 30], [47, 50]], "no retry of frame 0 after the seek to 20");
  assert.deepEqual(plates(), [[47, 50]]);

  const again = makeDeps({ plateAnswers: [new Error("plate_cell_failed:47:x")] });
  const second = mount(again);
  await second.player.load(planDto());
  await settle();
  await second.player.play();
  await again.runTimers();
  assert.deepEqual(again.needs, [[47, 30]], "no paused retry once playback runs");
  second.player.destroy();
  player.destroy();
});

test("without WebGL2 the live player still runs and paints through Canvas2D only", async () => {
  // The production browser had WebCodecs and OffscreenCanvas 2D but no WebGL2.
  const names = ["VideoDecoder", "OffscreenCanvas", "Worker", "AudioContext", "createImageBitmap", "WebGL2RenderingContext"];
  const saved = Object.fromEntries(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  try {
    for (const name of names.slice(0, 5)) {
      Object.defineProperty(globalThis, name, { value: function Stub() {}, configurable: true, writable: true });
    }
    delete globalThis.WebGL2RenderingContext;
    const env = makeDeps();
    delete env.deps.supports; // the real feature check
    const { player, plates, kinds } = mount(env);
    assert.equal(player.state().mode, "live");
    await player.load(planDto());
    await settle();
    assert.deepEqual(plates(), [[47, 30]]);
    assert.deepEqual([...new Set(kinds)], ["2d"], "no WebGL context is ever asked for");
    player.destroy();
  } finally {
    for (const name of names) {
      if (saved[name]) Object.defineProperty(globalThis, name, saved[name]);
      else delete globalThis[name];
    }
  }
});
