// The paused picture of the editor player (fix/editor-first-frame): the frame at the playhead is
// painted as soon as its plate frame is decoded, with no Play and no user gesture.
//
// Seen on production (Brave on Linux, Chromium 146, no WebGL2): the stage stayed black with
// "Menyiapkan frame…" until Play. The plan's first piece starts at source-grid frame 2850, so frame
// 0 lives in plate cell 47 (k = ⌊2850 / 60⌋), index 30: the only cell the browser fetched. The
// paused present had one attempt at that frame; when it came back empty or failed, nothing asked
// again (playback asks on every tick, which is why Play "fixed" it).
//
// Later seen on production: the black stage came back only while the owner's PC was under extreme
// memory pressure (24 GB of swap in use), survived a reload, and every open on a calm PC painted
// frame 0 by itself. That is a decode that stalls, not one that fails: a need() that never settles.
// Each paused attempt therefore has a time budget, whatever holds it.
import assert from "node:assert/strict";
import test from "node:test";

import { badgeView, playerView } from "../components/editor/shell-model.mjs";
import { createPlateSource } from "../lib/editor/player/plate-source.mjs";
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

/** `building`: the server still builds a cell after the clip's three (the store polls meanwhile). */
function planDto({ mix = "m1", building = false } = {}) {
  const pieces = [{ i: 0, seg: "seg_b1", role: "body", inSf: 2850, outSf: 3000, outF0: 0, frames: 150 }];
  const cells = [47, 48, 49].map((k) => ({ k, state: "ready", url: `/media/plates/pk-c${String(k).padStart(7, "0")}.mp4` }));
  if (building) cells.push({ k: 50, state: "queued", url: null });
  return {
    planSha256: `plan-${mix}`, docSha256: "d1", compiler: "edit-v2/1", renderSemantics: 1,
    fps: FPS, totalFrames: 150, output: { w: 720, h: 1280 }, pieces, cues: [], hook: null,
    text: { assSha256: "a1", ass: "[Script Info]\n", url: "/ass/a1.ass", fonts: [] },
    plate: { plateKey: "pk", cellFrames: 60, w: 720, h: 1280, cells },
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
 * Layers as fakes on a fake clock. `need(k, j)` answers from `plateAnswers` in order ("frame",
 * null, an Error to reject with, "hang" for a decode that never settles, or a deferred whose
 * resolve() delivers the frame), then "frame"; like the plate source, a frame still decoding is one
 * promise for every caller, and only `fresh` starts another decode. The text layer answers from
 * `textAnswers` ("ok", an Error, or "hang"); `audioGate` holds the mix decode (a context before any
 * gesture).
 */
function makeDeps({ plateAnswers = [], textAnswers = [], audioGate = null } = {}) {
  let plateDto = null;
  const decoded = new Set();
  const inflight = new Map();
  const needs = [];
  const needCalls = [];
  const ensures = [];
  const textRenders = [];
  const clock = { now: 0 };
  const timers = [];
  const fired = [];
  let timerId = 0;
  const env = { wallPosition: null, raf: null };
  const plate = {
    setPlate(dto) { plateDto = dto; },
    cellState(k) {
      const cell = plateDto?.cells.find((item) => item.k === k);
      return cell ? (cell.state === "ready" && cell.url ? "ready" : "queued") : "missing";
    },
    readyCells() { return { ready: plateDto.cells.length, total: plateDto.cells.length }; },
    has(k, j) { return decoded.has(`${k}:${j}`); },
    frame(k, j) { return decoded.has(`${k}:${j}`) ? { layer: "plate", k, j } : null; },
    need(k, j, options = {}) {
      needs.push([k, j]);
      needCalls.push({ k, j, at: clock.now, fresh: options.fresh === true });
      const key = `${k}:${j}`;
      if (!options.fresh && inflight.has(key)) return inflight.get(key);
      const answer = plateAnswers.length ? plateAnswers.shift() : "frame";
      const promise = answer === "hang" ? new Promise(() => {}) : (async () => {
        if (answer?.promise) await answer.promise;
        else await tick();
        if (answer instanceof Error) throw answer;
        if (answer === null) return null;
        decoded.add(key);
        return plate.frame(k, j);
      })();
      inflight.set(key, promise);
      const done = () => { if (inflight.get(key) === promise) inflight.delete(key); };
      promise.then(done, done);
      return promise;
    },
    ensure(schedule, { keep = [] } = {}) {
      ensures.push({ at: clock.now, keep });
      return Promise.resolve();
    },
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
      async render(n) {
        textRenders.push(n);
        const answer = textAnswers.length ? textAnswers.shift() : "ok";
        if (answer === "hang") await new Promise(() => {});
        if (answer instanceof Error) throw answer;
        return { frame: n, changed: true, parts: [{ bitmap: { layer: "text", n, close() {} }, x: 0, y: 900 }] };
      },
      destroy() {},
    }),
    createPlateSource: () => plate,
    createAudioClock: () => audio,
    createWallClock: () => ({ start() {}, stop() {}, position: () => env.wallPosition }),
    createLogoLayer: () => ({ load: async () => {}, readyFor: () => true, draw() {}, destroy() {} }),
    requestAnimationFrame: (callback) => { env.raf = callback; return 1; },
    cancelAnimationFrame: () => { env.raf = null; },
    now: () => clock.now,
    supports: () => ({ live: true }),
    setTimeout: (callback, ms) => {
      timerId += 1;
      timers.push({ id: timerId, ms, due: clock.now + ms, callback });
      return timerId;
    },
    clearTimeout: (id) => {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
  };
  /** Runs the pending timers in time order, moving the clock to each (and to `until` at most). */
  async function runTimers(until = Infinity) {
    for (;;) {
      let next = null;
      for (const timer of timers) if (!next || timer.due < next.due) next = timer;
      if (!next || next.due > until) break;
      timers.splice(timers.indexOf(next), 1);
      clock.now = next.due;
      fired.push(next.ms);
      next.callback();
      await settle();
    }
    if (Number.isFinite(until)) clock.now = Math.max(clock.now, until);
  }
  return Object.assign(env, { deps, plate, audio, needs, needCalls, ensures, textRenders, clock, timers, fired, runTimers });
}

function mount(env) {
  const { canvas, draws, kinds } = fakeCanvas();
  const frames = []; // every frame drawn, as onFrame reports it
  const player = createPlayer({
    canvas, fetchImpl: async () => ({ ok: true, status: 200, text: async () => "" }), deps: env.deps,
    onFrame: (info) => frames.push({ frame: info.frame, playing: info.playing }),
  });
  const plates = () => draws.filter((draw) => draw.image.layer === "plate").map((draw) => [draw.image.k, draw.image.j]);
  return { player, draws, kinds, plates, frames };
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

test("a paused draw that throws is retried, not swallowed with the stage left black", async () => {
  // Every caller of the paused present drops its rejection; a drawImage that throws (a source
  // closed under it) used to leave no frame, no error and "Menyiapkan frame…".
  const env = makeDeps();
  const { player, draws } = mount(env);
  const canvas = { width: 720, height: 1280 };
  let failures = 1;
  const ctx = {
    globalCompositeOperation: "source-over",
    imageSmoothingEnabled: true,
    drawImage(image, x, y) {
      if (image.layer === "plate" && failures > 0) {
        failures -= 1;
        throw new DOMException("The image source is detached.", "InvalidStateError");
      }
      draws.push({ image, x, y });
    },
  };
  canvas.getContext = () => ctx;
  const drawing = createPlayer({ canvas, fetchImpl: async () => ({ ok: true, status: 200, text: async () => "" }), deps: env.deps });
  player.destroy();
  await drawing.load(planDto());
  await settle();
  assert.equal(drawing.state().presentedFrame, null);
  assert.equal(drawing.state().error, null, "still being prepared: one retry is due");
  assert.deepEqual(env.timers.map((timer) => timer.ms), [250]);
  await env.runTimers();
  assert.equal(drawing.state().presentedFrame, 0);
  assert.equal(drawing.state().exact, true);
  assert.deepEqual(draws.filter((draw) => draw.image.layer === "plate").map((draw) => [draw.image.k, draw.image.j]), [[47, 30]]);
  drawing.destroy();
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

// A decode that stalls: under heavy memory pressure a lone-frame decode (getSample, which flushes
// the decoder) can stop without settling. Nothing failed, so nothing retried, and a plain retry
// would join the same pass. Each paused attempt has a budget instead; past it the cell gets a fresh
// sequential pass (plate-source need({ fresh })), the route playback decodes with.

/** The shell's badge for the player's state, as EditorApp computes it. */
function badgeOf(player) {
  return badgeView({ status: "ready", plan: planDto(), storePending: [], player: playerView(null, player.state()) });
}

test("a plate decode that never settles: past 1.5 s the cell gets a fresh pass and the frame is painted", async () => {
  const env = makeDeps({ plateAnswers: ["hang"] });
  const { player, plates } = mount(env);
  await player.load(planDto());
  await settle();
  assert.deepEqual(plates(), []);
  assert.equal(player.state().error, null);
  assert.equal(badgeOf(player).text, "Menyiapkan frame…", "still being prepared: the budget runs");
  assert.deepEqual(env.timers.map((timer) => timer.ms), [1500], "the first attempt's budget");
  await env.runTimers();
  assert.deepEqual(env.needCalls.map(({ at, fresh }) => [at, fresh]), [[0, false], [1500, true]],
    "the retry does not join the stalled pass: it asks for a fresh one");
  assert.deepEqual(plates(), [[47, 30]]);
  const state = player.state();
  assert.equal(state.presentedFrame, 0);
  assert.equal(state.exact, true);
  assert.equal(state.error, null);
  assert.deepEqual(player.stats().paused?.map(({ n, attempt, layer, reason }) => [n, attempt, layer, reason]),
    [[0, 0, "plate", "timeout"]], "the stall is on record for the inspect hook");
  player.destroy();
});

test("a frame that stalls on every attempt is reported after the budgets, and painted if it still comes", async () => {
  const late = deferred();
  const env = makeDeps({ plateAnswers: ["hang", "hang", late] });
  const { player, plates } = mount(env);
  await player.load(planDto());
  await settle();
  await env.runTimers();
  assert.deepEqual(env.fired, [1500, 4000, 4000], "three attempts, each on its budget");
  assert.equal(env.clock.now, 9500);
  assert.deepEqual(env.needCalls.map(({ fresh }) => fresh), [false, true, true]);
  let state = player.state();
  assert.equal(state.presentedFrame, null);
  assert.deepEqual(state.error, { layer: "plate", message: "paused_frame_timeout:plate", frame: 0 });
  assert.equal(badgeOf(player).text, "Frame gagal dimuat", "not 'Menyiapkan frame…' forever");
  // The last attempt still waits: a frame that comes after the report is drawn and clears it.
  late.resolve();
  await settle();
  assert.deepEqual(plates(), [[47, 30]]);
  state = player.state();
  assert.equal(state.presentedFrame, 0);
  assert.equal(state.exact, true);
  assert.equal(state.error, null);
  assert.equal(badgeOf(player).tone, "exact");
  player.destroy();
});

test("a budget gives way to a newer seek, and a poll of the same plan does not restart it", async () => {
  const env = makeDeps({ plateAnswers: ["hang"] });
  const { player, plates } = mount(env);
  await player.load(planDto());
  await settle();
  await player.seek(20);
  await env.runTimers();
  assert.deepEqual(env.needCalls.map(({ j, fresh }) => [j, fresh]), [[30, false], [50, false]],
    "no fresh pass for frame 0 after the seek to 20");
  assert.deepEqual(plates(), [[47, 50]]);
  player.destroy();

  // The store reloads the plan on every poll while cells build (same plan, new object): the attempt
  // in flight keeps its budget instead of starting over at each poll.
  const polled = makeDeps({ plateAnswers: ["hang"] });
  const second = mount(polled);
  await second.player.load(planDto());
  await settle();
  await polled.runTimers(1000);
  await second.player.load(planDto());
  await settle();
  await polled.runTimers();
  assert.deepEqual(polled.needCalls.map(({ at, fresh }) => [at, fresh]), [[0, false], [1500, true]]);
  assert.equal(second.player.state().presentedFrame, 0);
  second.player.destroy();
});

test("a paused text render that fails is retried with the whole frame, then reported", async () => {
  const boom = () => new Error("worker: render failed");
  const env = makeDeps({ textAnswers: [boom(), boom()] });
  const { player, plates } = mount(env);
  await player.load(planDto());
  await settle();
  assert.deepEqual(plates(), [], "no text, no frame: nothing partial is drawn");
  assert.equal(player.state().error, null, "one failed attempt is not reported yet");
  assert.deepEqual(env.timers.map((timer) => timer.ms), [250]);
  await env.runTimers();
  assert.deepEqual(plates(), [[47, 30]]);
  assert.deepEqual(env.needs, [[47, 30]], "the plate frame was kept: only the text is asked for again");
  assert.equal(player.state().presentedFrame, 0);
  assert.equal(player.state().exact, true);
  player.destroy();

  // Every attempt renders twice (the second for a track swap); six failures spend all three.
  const failing = makeDeps({ textAnswers: Array.from({ length: 6 }, boom) });
  const second = mount(failing);
  await second.player.load(planDto());
  await settle();
  await failing.runTimers();
  assert.equal(failing.textRenders.length, 6);
  assert.deepEqual(second.player.state().error, { layer: "text", message: "worker: render failed", frame: 0 });
  assert.equal(badgeOf(second.player).text, "Frame gagal dimuat");
  // A new request starts clean.
  assert.deepEqual(await second.player.seek(3), { frame: 3, presented: true });
  assert.equal(second.player.state().error, null);
  second.player.destroy();
});

test("a text render that never settles is bounded too: reported as the text after the budgets", async () => {
  const env = makeDeps({ textAnswers: ["hang"] });
  const { player, plates } = mount(env);
  await player.load(planDto());
  await settle();
  await env.runTimers();
  assert.deepEqual(env.fired, [1500, 4000, 4000]);
  assert.deepEqual(plates(), []);
  assert.deepEqual(player.state().error, { layer: "text", message: "paused_frame_timeout:text", frame: 0 });
  assert.equal(badgeOf(player).text, "Frame gagal dimuat");
  player.destroy();
});

test("a logo that never finishes loading is reported as the logo after the budgets", async () => {
  const env = makeDeps();
  env.deps.createLogoLayer = () => ({ load: () => new Promise(() => {}), readyFor: () => false, draw() {}, destroy() {} });
  const { player, plates } = mount(env);
  player.load(planDto()).catch(() => {}); // waits for the logo, so the seek asks for the frame
  await settle();
  player.seek(3);
  await settle();
  await env.runTimers();
  assert.deepEqual(env.fired, [1500, 4000, 4000]);
  assert.deepEqual(plates(), []);
  assert.deepEqual(player.state().error, { layer: "logo", message: "paused_frame_timeout:logo", frame: 3 });
  player.destroy();
});

test("pausing on a frame playback was holding paints it once its plate frame comes", async () => {
  const landing = deferred();
  // Frame 0 at load, then frame 5 (cell 47, index 35): asked by the held tick and by the pause.
  const env = makeDeps({ plateAnswers: ["frame", landing] });
  const { player, plates } = mount(env);
  await player.load(planDto());
  await settle();
  assert.equal(player.state().presentedFrame, 0);
  await player.play({ silent: true });
  env.wallPosition = 5.2 / 30; // the clock reaches frame 5, whose plate frame is not decoded
  env.raf();
  await settle();
  assert.equal(player.state().frame, 5);
  assert.equal(player.state().presentedFrame, 0, "held on frame 0");
  player.pause();
  landing.resolve(); // the decode lands after the pause
  await settle(20);
  assert.deepEqual(plates(), [[47, 30], [47, 35]]);
  const state = player.state();
  assert.equal(state.frame, 5);
  assert.equal(state.presentedFrame, 5, "the playhead frame is on the canvas");
  assert.equal(state.exact, true);

  // A pause on the frame already on screen asks for nothing.
  await player.play({ silent: true });
  env.wallPosition = 5.5 / 30;
  env.raf();
  await settle();
  const asked = env.needs.length;
  player.pause();
  await settle();
  assert.equal(env.needs.length, asked);
  assert.equal(player.state().presentedFrame, 5);
  player.destroy();
});

// Play supersedes every paused attempt. One still waiting when Play starts (a seek still decoding,
// a retry after a budget, a pause's repaint) must not draw its frame over playback.

/** Plays from the playhead until frame 31 (cell 48, index 1) is on the canvas. */
async function playTo31(player, env) {
  await player.play({ silent: true });
  env.wallPosition = 31.2 / 30;
  env.raf();
  await settle();
  env.raf?.();
  await settle();
  assert.equal(player.state().presentedFrame, 31, "playback presents frame 31");
}

/** The paused frame's draw, had it happened: the frame on the canvas while playing, or its decode-ahead. */
function staleDraws({ frames, env, from, n, k, j }) {
  return {
    frames: frames.filter((f) => f.playing && f.frame === n),
    prefetches: env.ensures.slice(from).filter(({ keep }) => keep.some(([kk, jj]) => kk === k && jj === j)),
  };
}

test("a paused attempt still waiting when Play starts never draws over playback", async () => {
  // A seek to frame 5 (cell 47, index 35) whose decode lands while playing.
  const landing = deferred();
  const env = makeDeps({ plateAnswers: ["frame", landing] });
  const { player, frames } = mount(env);
  await player.load(planDto());
  await settle();
  player.seek(5);
  await settle();
  await playTo31(player, env);
  const from = env.ensures.length;
  landing.resolve();
  await settle(20);
  assert.deepEqual(staleDraws({ frames, env, from, n: 5, k: 47, j: 35 }), { frames: [], prefetches: [] },
    "the seek's frame 5 was drawn over playback at frame 31");
  assert.equal(player.state().presentedFrame, 31);
  assert.equal(player.state().playing, true);
  player.destroy();

  // A retry after the first budget: its fresh pass delivers frame 0 while playing.
  const late = deferred();
  const retried = makeDeps({ plateAnswers: ["hang", late] });
  const second = mount(retried);
  await second.player.load(planDto());
  await settle();
  await retried.runTimers(1500);
  assert.deepEqual(retried.needCalls.map(({ fresh }) => fresh), [false, true], "the retry waits on a fresh pass");
  await playTo31(second.player, retried);
  const after = retried.ensures.length;
  late.resolve();
  await settle(20);
  assert.deepEqual(staleDraws({ frames: second.frames, env: retried, from: after, n: 0, k: 47, j: 30 }),
    { frames: [], prefetches: [] }, "the retry's frame 0 was drawn over playback at frame 31");
  assert.equal(second.player.state().presentedFrame, 31);
  assert.equal(second.player.state().error, null);
  await retried.runTimers(20_000);
  assert.equal(second.player.state().error, null, "nothing is reported for a frame playback left behind");
  assert.deepEqual(second.player.stats().paused.map(({ attempt, reason }) => [attempt, reason]), [[0, "timeout"]]);
  second.player.destroy();
});

test("a pause repaint still waiting when Play starts again never draws over playback", async () => {
  const landing = deferred();
  // Frame 0 at load, then frame 5 (cell 47, index 35), asked by the held tick and by the pause.
  const env = makeDeps({ plateAnswers: ["frame", landing] });
  const { player, frames } = mount(env);
  await player.load(planDto());
  await settle();
  await player.play({ silent: true });
  env.wallPosition = 5.2 / 30;
  env.raf();
  await settle();
  assert.equal(player.state().presentedFrame, 0, "held on frame 0");
  player.pause(); // the repaint of frame 5 waits for its decode
  await settle();
  await playTo31(player, env);
  const from = env.ensures.length;
  landing.resolve();
  await settle(20);
  assert.deepEqual(staleDraws({ frames, env, from, n: 5, k: 47, j: 35 }), { frames: [], prefetches: [] },
    "the pause's repaint of frame 5 was drawn over playback at frame 31");
  assert.equal(player.state().presentedFrame, 31);
  player.destroy();
});

// While cells build, the store reloads the same plan every 750 ms. A poll must not start the paused
// frame over once its attempts are under way: not while one waits, not in a retry delay, and not
// after the failure is reported. Only something new (a seek, Play, another plan) asks again.

/** The store's polls: `dto()` loaded every `ms` from `from` until `until`; `onPoll` runs first. */
function pollPlans(env, player, { ms = 750, from = ms, until = 60_000, dto = () => planDto({ building: true }), onPoll = () => {} } = {}) {
  const poll = () => {
    onPoll();
    player.load(dto()).catch(() => {});
    if (env.clock.now + ms <= until) env.deps.setTimeout(poll, ms);
  };
  env.deps.setTimeout(poll, from);
}

/** The shell's badge for the player's state with the store's pending layers. */
function badgeWhile(player, plan, storePending) {
  return badgeView({ status: "ready", plan, storePending, player: playerView(null, player.state()) });
}

test("polls of the same plan while cells build leave a frame that ran out of time reported: one round of attempts", async () => {
  const env = makeDeps({ plateAnswers: Array.from({ length: 40 }, () => "hang") });
  const { player } = mount(env);
  await player.load(planDto({ building: true }));
  await settle();
  const seen = [];
  pollPlans(env, player, { onPoll: () => seen.push({ at: env.clock.now, error: player.state().error }) });
  await env.runTimers(60_000);
  assert.deepEqual(env.needCalls.map(({ at, fresh }) => [at, fresh]), [[0, false], [1500, true], [5500, true]],
    "one attempt and two retries, none started over by a poll");
  const reported = { layer: "plate", message: "paused_frame_timeout:plate", frame: 0 };
  assert.deepEqual(player.state().error, reported);
  const later = seen.filter(({ at }) => at > 9500);
  assert.ok(later.length > 60);
  assert.deepEqual(later.filter(({ error }) => error?.message !== reported.message), [], "the report stays at every poll");
  assert.equal(playerView(null, player.state()).frameError, true);
  assert.equal(badgeWhile(player, planDto({ building: true }), ["plate"]).text, "Menyiapkan video (3/4)…",
    "while cells build the badge names them first");
  assert.deepEqual(player.stats().paused.map(({ attempt, reason }) => [attempt, reason]),
    [[0, "timeout"], [1, "timeout"], [2, "timeout"]]);

  // The last cell is built: the badge names the failure at once, with no new round of attempts.
  await player.load(planDto());
  await settle();
  assert.equal(badgeWhile(player, planDto(), []).text, "Frame gagal dimuat");
  assert.equal(env.needCalls.length, 3);
  // An edit (another plan) asks again, from the first attempt.
  await player.load(planDto({ mix: "m2" }));
  await settle();
  assert.deepEqual(env.needCalls.slice(3).map(({ fresh }) => fresh), [false]);
  assert.equal(player.state().error, null, "a new request starts clean");
  player.destroy();
});

test("polls in the retry delays do not start the attempts over: a frame that keeps failing is reported while cells build", async () => {
  const failure = () => new Error("plate_cell_failed:47:EncodingError: Decoder failure");
  const env = makeDeps({ plateAnswers: Array.from({ length: 40 }, failure) });
  const { player } = mount(env);
  await player.load(planDto({ building: true }));
  await settle();
  // The first poll lands in the 250 ms delay, the second in the 1 s one.
  pollPlans(env, player, { from: 100 });
  await env.runTimers(60_000);
  assert.deepEqual(env.needCalls.map(({ at, fresh }) => [at, fresh]), [[0, false], [250, true], [1250, true]],
    "one attempt and two retries, each after its delay");
  assert.deepEqual(player.state().error,
    { layer: "plate", message: "plate_cell_failed:47:EncodingError: Decoder failure", frame: 0 });
  assert.equal(playerView(null, player.state()).frameError, true);
  await player.load(planDto());
  await settle();
  assert.equal(badgeWhile(player, planDto(), []).text, "Frame gagal dimuat");
  player.destroy();
});

/** Mediabunny whose every decoder stalls: getSample and the sample stream never answer. */
function stalledMediabunny() {
  const counts = { decoders: 0 };
  class BufferSource { constructor(buffer) { this.buffer = buffer; } }
  class Input {
    async getPrimaryVideoTrack() { return {}; }
    dispose() {}
  }
  class VideoSampleSink {
    constructor() { counts.decoders += 1; }
    getSample() { return new Promise(() => {}); }
    async* samples() { yield await new Promise(() => {}); }
  }
  return { counts, module: { Input, BufferSource, VideoSampleSink, ALL_FORMATS: [] } };
}

test("every decoder stalls while cells build: one round of attempts, and a cell abandons at most two decoders", async () => {
  // The real plate source: an abandoned decoder cannot be closed, so each one stays for good.
  const mb = stalledMediabunny();
  const env = makeDeps();
  let source = null;
  env.deps.createPlateSource = ({ fps, capacity }) => {
    source = createPlateSource({
      fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) }),
      loadMediabunny: async () => mb.module,
      retainFrame: async () => ({ close() {} }),
      yieldTask: () => Promise.resolve(),
      now: () => env.clock.now,
      fps, capacity,
    });
    return source;
  };
  const { player } = mount(env);
  await player.load(planDto({ building: true }));
  await settle();
  pollPlans(env, player);
  await env.runTimers(60_000);
  assert.deepEqual(player.state().error, { layer: "plate", message: "paused_frame_timeout:plate", frame: 0 });
  assert.deepEqual([source.stats().passes, source.stats().abandoned, mb.counts.decoders], [3, 2, 3],
    "one lone pass and two fresh ones; the first two abandoned");

  // A new request on the same cell gets its round of attempts, but no more decoders are abandoned.
  player.seek(20); // cell 47, index 50; it never resolves: its frame never comes
  await settle();
  await env.runTimers(80_000);
  assert.deepEqual(player.state().error, { layer: "plate", message: "paused_frame_timeout:plate", frame: 20 });
  assert.deepEqual([source.stats().passes, source.stats().abandoned, source.stats().stalled, mb.counts.decoders], [3, 2, 2, 3],
    "the cell's two abandoned decoders cap its fresh passes: the retries wait on its pass");
  player.destroy();
});
