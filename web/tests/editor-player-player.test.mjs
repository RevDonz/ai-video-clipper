// createPlayer (Appendix A.2; plan §6.2) with every layer injected: the presenter barrier across
// plate, text and logo; superseded seeks; playback on the audio clock with text pre-rendered one
// frame ahead; the swap rules; truth frames; the revision-0 <video> fallback; unsupported
// browsers; the device check; the cold-open transition fill (spec 2026-10-02 §5.2).
import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_JASSUB_URL, createPlayer } from "../lib/editor/player/player.mjs";

const FPS = [30, 1];

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function planDto({
  doc = "d1", ass = "a1", mix = "m1", plateKey = "p1", ready = [0, 1, 2, 3, 4], logo = null, rev0 = null,
  pieces = [{ i: 0, seg: "seg_b1", role: "body", inSf: 30, outSf: 180, outF0: 0, frames: 150 }], audioState = "ready",
  fonts = [{ family: "DejaVu Sans", url: "/fonts/DejaVuSans.ttf", sha256: "f".repeat(64) }], joins,
} = {}) {
  const total = pieces.reduce((sum, piece) => sum + piece.frames, 0);
  const joinKey = joins ? `-${joins.map((join) => join.style).join("+")}` : "";
  return {
    planSha256: `plan-${doc}-${ass}-${plateKey}-${mix}${joinKey}`, docSha256: doc, compiler: "edit-v2/1", renderSemantics: 1,
    fps: FPS, totalFrames: total, output: { w: 720, h: 1280 }, pieces, cues: [], hook: null,
    text: { assSha256: ass, ass: `[Script Info]\n; ${ass}\n`, url: `/ass/${ass}.ass`, fonts },
    plate: { plateKey, cellFrames: 60, w: 720, h: 1280,
      cells: ready.map((k) => ({ k, state: "ready", url: `/cells/${plateKey}-${k}.mp4` })) },
    logo,
    audio: { mixSha256: mix, state: audioState, url: audioState === "ready" ? `/mix/${mix}.flac` : null,
      samples: Math.floor((total * 48000 * FPS[1]) / FPS[0]), musicGainPoints: [], speechSpans: [] },
    rev0: rev0 ?? { planSha256: "rev0", autoRenderUrl: null, exact: false },
    warnings: [], errors: [],
    ...(joins ? { joins } : {}),
  };
}

// The canvas pixels the transition reads back: one plate pixel of level 100 (opaque) stands for
// the frame; a "fill" draw records the region and the blended pixel written back.
const PLATE_LEVEL = 100;

function fakeCanvas() {
  const draws = [];
  const ctx = {
    globalCompositeOperation: "source-over",
    globalAlpha: 1,
    imageSmoothingEnabled: true,
    drawImage(image, x, y) { draws.push({ image, x, y, op: this.globalCompositeOperation, alpha: this.globalAlpha }); },
    getImageData(x, y, w, h) {
      return { data: Uint8ClampedArray.from([PLATE_LEVEL, PLATE_LEVEL, PLATE_LEVEL, 255]), region: [x, y, w, h] };
    },
    putImageData(image, x, y) {
      draws.push({ image: { layer: "fill" }, x, y, region: image.region, pixel: [...image.data],
        op: this.globalCompositeOperation, alpha: this.globalAlpha });
    },
  };
  const canvas = { width: 300, height: 150, contextOptions: null, getContext(kind, options) { canvas.contextOptions = options; return ctx; } };
  return { canvas, ctx, draws };
}

function makeDeps({ plateBlocked = false, textDelayMs = 0, textTotalMs = 2 } = {}) {
  const log = [];
  const textLayers = [];
  const gates = new Map(); // "k:j" → deferred, when plateBlocked
  const decoded = new Set();
  let plateDto = null;
  const createTextLayer = (options) => {
    const layer = {
      options, destroyed: false, tracks: [], renders: [], bitmaps: [], ready: Promise.resolve({ fonts: options.fonts.length }),
      async setTrack(ass) { layer.tracks.push(ass); log.push(["setTrack", ass]); },
      async render(n) {
        layer.renders.push(n);
        if (textDelayMs) await new Promise((resolve) => setTimeout(resolve, textDelayMs));
        const bitmap = { layer: "text", n, closed: false, close() { bitmap.closed = true; } };
        layer.bitmaps.push(bitmap);
        return { frame: n, changed: true, bitmap, x: 10, y: 20, w: 5, h: 5, libassMs: 1, totalMs: textTotalMs };
      },
      destroy() { layer.destroyed = true; },
    };
    textLayers.push(layer);
    return layer;
  };
  const plate = {
    setPlate(dto) { plateDto = dto; log.push(["setPlate", dto.plateKey]); },
    cellState(k) {
      const cell = plateDto?.cells.find((item) => item.k === k);
      return cell ? (cell.state === "ready" && cell.url ? "ready" : "queued") : "missing";
    },
    readyCells() { return { ready: plateDto.cells.filter((cell) => cell.state === "ready").length, total: plateDto.cells.length }; },
    frame(k, j) { return decoded.has(`${plateDto.plateKey}:${k}:${j}`) ? { layer: "plate", key: plateDto.plateKey, k, j } : null; },
    async need(k, j) {
      if (plate.cellState(k) !== "ready") return null;
      const key = `${plateDto.plateKey}:${k}:${j}`;
      if (plateBlocked && !decoded.has(key)) {
        if (!gates.has(key)) gates.set(key, deferred());
        await gates.get(key).promise;
      }
      decoded.add(key);
      return plate.frame(k, j);
    },
    ensure(schedule) {
      log.push(["ensure", schedule.map((entry) => entry.k)]);
      if (!plateBlocked) for (const entry of schedule) for (const j of entry.js) decoded.add(`${plateDto.plateKey}:${entry.k}:${j}`);
      return Promise.resolve();
    },
    stats() { return { cached: decoded.size }; },
    destroy() { log.push(["plateDestroy"]); },
  };
  const release = (k, j, key = plateDto.plateKey) => {
    const full = `${key}:${k}:${j}`;
    if (!gates.has(full)) gates.set(full, deferred());
    gates.get(full).resolve();
  };
  const audio = {
    ready: false, mixSha256: null, started: null, pos: null, loads: [],
    async load(dto) {
      audio.loads.push(dto.mixSha256);
      if (dto.state !== "ready" || !dto.url) { audio.ready = false; audio.mixSha256 = null; return; }
      audio.ready = true;
      audio.mixSha256 = dto.mixSha256;
    },
    async start(frame, fps) { if (!audio.ready) throw new Error("audio_not_ready"); audio.started = { frame, fps }; audio.pos = (frame * fps[1]) / fps[0]; },
    stop() { audio.started = null; audio.pos = null; },
    position() { return audio.pos; },
    destroy() { log.push(["audioDestroy"]); },
    buffer: null, context: null,
  };
  const wall = {
    started: null, pos: null,
    start(frame, fps) { wall.started = { frame, fps }; wall.pos = (frame * fps[1]) / fps[0]; },
    stop() { wall.started = null; wall.pos = null; },
    position() { return wall.pos; },
  };
  const logos = [];
  const logo = {
    dto: null, gate: null,
    async load(dto) {
      logo.dto = dto;
      logos.push(dto?.url ?? null);
      if (logo.gate) await logo.gate.promise;
    },
    readyFor(dto) { return !dto || (logo.dto?.url === dto.url && !logo.gate); },
    draw(ctx) { if (logo.dto) ctx.drawImage({ layer: "logo", url: logo.dto.url }, logo.dto.box.x, logo.dto.box.y); },
    destroy() {},
  };
  const frames = [];
  const raf = { queue: [], next: 1 };
  const deps = {
    createTextLayer,
    createPlateSource: () => plate,
    createAudioClock: () => audio,
    createWallClock: () => wall,
    createLogoLayer: () => logo,
    requestAnimationFrame: (callback) => { raf.queue.push(callback); return raf.next++; },
    cancelAnimationFrame: () => { raf.queue = []; },
    now: () => 0,
    supports: () => ({ live: true }),
    createImageBitmap: async (blob) => ({ layer: "truth", blob }),
  };
  async function frameTick(position) {
    if (position !== undefined) { audio.pos = position; wall.pos = position; }
    const callbacks = raf.queue;
    raf.queue = [];
    for (const callback of callbacks) callback(0);
    await tick();
    await tick();
  }
  return { deps, log, textLayers, plate, release, audio, wall, logo, logos, frames, raf, frameTick };
}

function player(env, extra = {}) {
  const { canvas, ctx, draws } = fakeCanvas();
  const states = [];
  const frames = [];
  const instance = createPlayer({
    canvas, fetchImpl: async (url) => ({ ok: true, status: 200, text: async () => `fetched ${url}`, blob: async () => ({ url }) }),
    onState: (state) => states.push(state), onFrame: (info) => frames.push(info), deps: env.deps, ...extra,
  });
  return { instance, canvas, ctx, draws, states, frames };
}

test("the default JASSUB directory is served by the resources route", () => {
  assert.equal(DEFAULT_JASSUB_URL, "/api/resources/jassub/");
});

test("load sizes the canvas and loads text, plate, logo and audio of the plan", async () => {
  const env = makeDeps();
  const { instance, canvas } = player(env);
  assert.equal(instance.state().mode, "live");
  await instance.load(planDto());
  assert.equal(canvas.width, 720);
  assert.equal(canvas.height, 1280);
  assert.deepEqual(canvas.contextOptions, { alpha: false, colorSpace: "srgb" });
  assert.equal(env.textLayers.length, 1);
  const layer = env.textLayers[0];
  assert.equal(layer.options.width, 720);
  assert.equal(layer.options.height, 1280);
  assert.deepEqual(layer.options.fps, FPS);
  assert.equal(layer.options.jassubUrl, DEFAULT_JASSUB_URL);
  assert.deepEqual(layer.options.fonts, ["/fonts/DejaVuSans.ttf"]);
  assert.equal(layer.options.fallbackFamily, "DejaVu Sans");
  assert.equal(layer.options.split, true, "one bitmap per band of text rows");
  assert.deepEqual(layer.tracks, ["[Script Info]\n; a1\n"]);
  assert.deepEqual(env.log.find(([kind]) => kind === "setPlate"), ["setPlate", "p1"]);
  assert.deepEqual(env.audio.loads, ["m1"]);
  const state = instance.state();
  assert.deepEqual(state.current, { text: true, plate: true, audio: true, logo: true });
  assert.equal(state.frame, 0);
});

test("the current frame is presented after load: plate, then text, then logo, never in part", async () => {
  const env = makeDeps();
  const logo = { box: { x: 560, y: 26, w: 115, h: 115 }, opacityPm: 850, url: "/derived/logo@115x115.png" };
  const { instance, draws, frames } = player(env);
  await instance.load(planDto({ logo }));
  await tick();
  // Frame 0 → piece 0, sf 30 → cell 0, j 30.
  assert.deepEqual(draws.map((draw) => [draw.image.layer, draw.op, draw.x, draw.y]), [
    ["plate", "copy", 0, 0], ["text", "source-over", 10, 20], ["logo", "source-over", 560, 26],
  ]);
  assert.deepEqual([draws[0].image.k, draws[0].image.j], [0, 30]);
  assert.equal(draws[1].image.n, 0);
  assert.equal(frames.at(-1).frame, 0);
  assert.equal(frames.at(-1).sf, 30);
  assert.equal(instance.state().exact, true);
});

test("a seek holds the last frame until the plate frame is decoded, then draws it whole", async () => {
  const env = makeDeps({ plateBlocked: true });
  const { instance, draws } = player(env);
  const loaded = instance.load(planDto());
  env.release(0, 30);
  await loaded;
  await tick();
  const before = draws.length;
  const seek = instance.seek(100); // sf 130 → cell 2, j 10
  await tick();
  assert.equal(draws.length, before, "nothing is drawn while the plate frame is missing");
  assert.equal(instance.state().exact, false);
  env.release(2, 10);
  const result = await seek;
  assert.deepEqual(result, { frame: 100, presented: true });
  assert.deepEqual(draws.slice(before).map((draw) => draw.image.layer), ["plate", "text"]);
  assert.deepEqual([draws[before].image.k, draws[before].image.j], [2, 10]);
  assert.equal(env.textLayers[0].renders.at(-1), 100);
});

test("a newer seek supersedes an older one; only the newest frame is drawn", async () => {
  const env = makeDeps({ plateBlocked: true });
  const { instance, draws } = player(env);
  const loaded = instance.load(planDto());
  env.release(0, 30);
  await loaded;
  await tick();
  const before = draws.length;
  const first = instance.seek(40);
  const second = instance.seek(41);
  env.release(1, 11);
  assert.deepEqual(await second, { frame: 41, presented: true });
  env.release(1, 10);
  assert.deepEqual(await first, { frame: 40, presented: false, superseded: true });
  assert.deepEqual(draws.slice(before).map((draw) => [draw.image.layer, draw.image.j ?? draw.image.n]),
    [["plate", 11], ["text", 41]]);
});

test("a frame in a cell that is not ready is held and reported as pending plate", async () => {
  const env = makeDeps();
  const { instance, draws } = player(env);
  await instance.load(planDto({ ready: [0] }));
  await tick();
  const before = draws.length;
  const result = await instance.seek(120); // cell 2
  assert.deepEqual(result, { frame: 120, presented: false, pending: "plate" });
  assert.equal(draws.length, before);
  const state = instance.state();
  assert.equal(state.current.plate, false);
  assert.ok(state.pending.includes("plate"));
  assert.deepEqual(state.plate, { ready: 1, total: 1 });
  // The cell arrives in a later plan DTO: the held frame is presented.
  await instance.load(planDto({ ready: [0, 1, 2] }));
  await tick();
  await tick();
  assert.equal(draws.at(-2).image.layer, "plate");
  assert.equal(draws.at(-2).image.k, 2);
});

test("a new ASS is swapped in between frames; the text is not current until it is set", async () => {
  const env = makeDeps();
  const { instance } = player(env);
  await instance.load(planDto());
  await tick();
  await instance.load(planDto({ doc: "d2", ass: "a2" }));
  assert.deepEqual(env.textLayers[0].tracks, ["[Script Info]\n; a1\n", "[Script Info]\n; a2\n"]);
  assert.equal(env.textLayers.length, 1, "the same fonts keep the text layer");
  // text.ass omitted (known sha): nothing is swapped.
  const known = planDto({ doc: "d3", ass: "a2" });
  delete known.text.ass;
  await instance.load(known);
  assert.equal(env.textLayers[0].tracks.length, 2);
  // An unknown sha without inline ASS is fetched from text.url.
  const fetched = planDto({ doc: "d4", ass: "a3" });
  delete fetched.text.ass;
  await instance.load(fetched);
  assert.equal(env.textLayers[0].tracks.at(-1), "fetched /ass/a3.ass");
});

test("a font the text layer lacks recreates it with the union of fonts", async () => {
  const env = makeDeps();
  const { instance } = player(env);
  await instance.load(planDto());
  const bold = { family: "Montserrat ExtraBold", url: "/fonts/Montserrat-ExtraBold.ttf", sha256: "e".repeat(64) };
  await instance.load(planDto({ doc: "d2", ass: "a2", fonts: [bold] }));
  assert.equal(env.textLayers.length, 2);
  assert.equal(env.textLayers[0].destroyed, true);
  assert.deepEqual(env.textLayers[1].options.fonts, ["/fonts/DejaVuSans.ttf", "/fonts/Montserrat-ExtraBold.ttf"]);
  assert.deepEqual(env.textLayers[1].tracks, ["[Script Info]\n; a2\n"]);
});

test("the logo layer holds presentation until its bitmap is loaded", async () => {
  const env = makeDeps();
  const { instance, draws } = player(env);
  await instance.load(planDto());
  await tick();
  const before = draws.length;
  env.logo.gate = deferred();
  const logo = { box: { x: 1, y: 2, w: 3, h: 4 }, opacityPm: 850, url: "/derived/x@3x4.png" };
  const loading = instance.load(planDto({ doc: "d2", logo }));
  await tick();
  assert.equal(draws.length, before);
  assert.equal(instance.state().current.logo, false);
  const gate = env.logo.gate;
  env.logo.gate = null;
  gate.resolve();
  await loading;
  await tick();
  assert.deepEqual(draws.slice(before).map((draw) => draw.image.layer), ["plate", "text", "logo"]);
});

test("playback follows the audio clock, pre-renders text one frame ahead and counts drops", async () => {
  const env = makeDeps();
  const { instance, frames } = player(env);
  await instance.load(planDto());
  await tick();
  await instance.play();
  assert.deepEqual(env.audio.started, { frame: 0, fps: FPS });
  assert.equal(instance.state().playing, true);
  for (const n of [0, 1, 2, 3, 5, 6]) await env.frameTick((n + 0.5) / 30);
  const shown = frames.filter((info) => info.playing).map((info) => info.frame);
  assert.deepEqual(shown, [1, 2, 3, 5, 6]);
  const renders = env.textLayers[0].renders;
  assert.ok(renders.includes(4), "the text for 4 was pre-rendered after 3 was shown");
  const stats = instance.stats();
  assert.equal(stats.presenter.drops, 1);
  assert.deepEqual(stats.presenter.dropped, [4]);
  assert.ok(env.log.some(([kind]) => kind === "ensure"), "the decode-ahead schedule is requested");
  instance.pause();
  assert.equal(instance.state().playing, false);
  assert.equal(env.audio.started, null);
});

test("playback renders the text of the next frames ahead and releases each bitmap once shown", async () => {
  const env = makeDeps();
  const { instance, draws } = player(env);
  await instance.load(planDto());
  await tick();
  assert.equal(env.textLayers[0].options.keepBitmaps, true, "the player owns the bitmaps it renders ahead");
  await instance.play();
  await env.frameTick(0.5 / 30);
  await tick();
  const layer = env.textLayers[0];
  for (const n of [1, 2, 3, 4]) assert.ok(layer.renders.includes(n), `text ${n} rendered ahead`);
  await env.frameTick(1.5 / 30);
  await env.frameTick(2.5 / 30);
  const drawnText = draws.filter((draw) => draw.image.layer === "text").map((draw) => draw.image);
  assert.deepEqual(drawnText.slice(-2).map((image) => image.n), [1, 2]);
  // Frames already shown are released; the ones ahead are kept.
  assert.equal(layer.bitmaps.find((bitmap) => bitmap.n === 1).closed, true);
  assert.equal(layer.bitmaps.find((bitmap) => bitmap.n === 4).closed, false);
  instance.destroy();
  assert.ok(layer.bitmaps.every((bitmap) => bitmap.closed), "destroy releases every bitmap");
});

test("play waits for the mix; play without sound runs on the wall clock", async () => {
  const env = makeDeps();
  const { instance } = player(env);
  await instance.load(planDto({ audioState: "queued" }));
  await tick();
  assert.equal(instance.state().current.audio, false);
  assert.ok(instance.state().pending.includes("audio"));
  let started = false;
  const waiting = instance.play().then(() => { started = true; });
  await tick();
  assert.equal(started, false);
  assert.equal(instance.state().playing, false);
  assert.equal(instance.state().waitingFor, "audio");
  await instance.load(planDto({ audioState: "ready" }));
  await waiting;
  assert.equal(started, true);
  assert.deepEqual(env.audio.started, { frame: 0, fps: FPS });
  instance.pause();
  await instance.load(planDto({ mix: "m9", audioState: "queued" }));
  await instance.play({ silent: true });
  assert.deepEqual(env.wall.started, { frame: 0, fps: FPS });
  assert.equal(instance.state().playing, true);
  instance.pause();
});

test("an edit during playback pauses; the new mix is loaded after the pause", async () => {
  const env = makeDeps();
  const { instance } = player(env);
  await instance.load(planDto());
  await instance.play();
  await env.frameTick(0.5 / 30);
  await instance.load(planDto({ doc: "d2", mix: "m2" }));
  assert.equal(instance.state().playing, false);
  assert.equal(env.audio.started, null);
  assert.deepEqual(env.audio.loads, ["m1", "m2"]);
  // A new DTO of the same document (more cells ready) keeps playing.
  await instance.play();
  await instance.load(planDto({ doc: "d2", mix: "m2", ready: [0, 1, 2, 3, 4, 5] }));
  assert.equal(instance.state().playing, true);
  instance.pause();
});

test("playback stops on the last frame", async () => {
  const env = makeDeps();
  const { instance, frames } = player(env);
  await instance.load(planDto());
  await instance.play();
  await env.frameTick(148.5 / 30);
  await env.frameTick(151 / 30);
  await tick();
  const state = instance.state();
  assert.equal(state.playing, false);
  assert.equal(state.frame, 149);
  assert.equal(state.ended, true);
  assert.equal(frames.at(-1).frame, 149);
});

test("step pauses and clamps; seek clamps to the clip", async () => {
  const env = makeDeps();
  const { instance } = player(env);
  await instance.load(planDto());
  await instance.play();
  await instance.step(2);
  assert.equal(instance.state().playing, false);
  assert.equal(instance.state().frame, 2);
  await instance.step(-100);
  assert.equal(instance.state().frame, 0);
  const result = await instance.seek(10_000);
  assert.equal(result.frame, 149);
});

test("a truth frame is drawn as-is and leaves truth mode on the next seek", async () => {
  const env = makeDeps();
  const calls = [];
  const { instance, draws } = player(env, { requestTruthFrame: async (frame) => { calls.push(frame); return { png: frame }; } });
  await instance.load(planDto());
  await tick();
  await instance.showTruthFrame(42);
  assert.deepEqual(calls, [42]);
  assert.equal(instance.state().mode, "truth");
  assert.equal(instance.state().frame, 42);
  assert.deepEqual([draws.at(-1).image.layer, draws.at(-1).op, draws.at(-1).x, draws.at(-1).y], ["truth", "copy", 0, 0]);
  await instance.seek(43);
  assert.equal(instance.state().mode, "live");
});

test("an unsupported browser shows truth frames at the playhead and never plays", async () => {
  const env = makeDeps();
  env.deps.supports = () => ({ live: false });
  const calls = [];
  const { instance, draws } = player(env, { requestTruthFrame: async (frame) => { calls.push(frame); return { png: frame }; } });
  assert.equal(instance.state().mode, "unsupported");
  await instance.load(planDto());
  await instance.seek(7);
  assert.deepEqual(calls, [0, 7]);
  assert.equal(draws.at(-1).image.layer, "truth");
  await instance.play();
  assert.equal(instance.state().playing, false);
  assert.equal(instance.state().mode, "unsupported");
  assert.equal(env.textLayers.length, 0);
});

function fakeVideo() {
  const listeners = new Map();
  const video = {
    src: "", currentTime: 0, paused: true, preload: "", playsInline: false, crossOrigin: null,
    addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); },
    removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) || []).filter((item) => item !== fn)); },
    dispatch(type) { for (const fn of listeners.get(type) || []) fn({ type }); },
    async play() { video.paused = false; },
    pause() { video.paused = true; },
    removeAttribute(name) { if (name === "src") video.src = ""; },
    load() {},
  };
  return video;
}

test("revision 0 plays the auto render in <video> until the cells at the playhead are ready", async () => {
  const env = makeDeps();
  const video = fakeVideo();
  const { instance } = player(env, { video });
  const rev0 = { planSha256: "rev0", autoRenderUrl: "/files/output/clip-01.mp4", exact: true };
  await instance.load(planDto({ ready: [], rev0 }));
  assert.equal(instance.state().mode, "auto_render");
  assert.equal(video.src, "/files/output/clip-01.mp4");
  assert.deepEqual(instance.state().current, { text: true, plate: true, audio: true, logo: true });
  const seek = instance.seek(90);
  await tick();
  assert.ok(Math.abs(video.currentTime - 90.5 / 30) < 1e-9);
  video.dispatch("seeked");
  assert.deepEqual(await seek, { frame: 90, presented: true });
  // Not exact (a different plan): no fallback.
  await instance.load(planDto({ doc: "d2", ready: [], rev0: { ...rev0, exact: false } }));
  assert.equal(instance.state().mode, "live");
  // Cells ready: back to the canvas.
  await instance.load(planDto({ ready: [0, 1, 2], rev0 }));
  assert.equal(instance.state().mode, "live");
});

test("a <video> that cannot seek (no byte ranges) is not reported as showing the frame", async () => {
  const env = makeDeps();
  const video = fakeVideo();
  let time = 0;
  Object.defineProperty(video, "currentTime", { get: () => time, set: () => { time = 0; } });
  const { instance } = player(env, { video });
  const rev0 = { planSha256: "rev0", autoRenderUrl: "/files/output/clip-01.mp4", exact: true };
  await instance.load(planDto({ ready: [], rev0 }));
  const seek = instance.seek(90);
  await tick();
  video.dispatch("seeked");
  assert.deepEqual(await seek, { frame: 90, presented: false, pending: "video" });
});

test("the device check flags a slow device from the text render times", async () => {
  const env = makeDeps({ textTotalMs: 35 });
  const { instance } = player(env);
  await instance.load(planDto());
  await instance.play();
  for (let n = 0; n < 70; n += 1) await env.frameTick((n + 0.5) / 30);
  assert.equal(instance.state().slow, true);
  instance.pause();
});

test("destroy stops everything and releases the layers", async () => {
  const env = makeDeps();
  const { instance } = player(env);
  await instance.load(planDto());
  await instance.play();
  instance.destroy();
  assert.equal(env.textLayers[0].destroyed, true);
  assert.ok(env.log.some(([kind]) => kind === "plateDestroy"));
  assert.ok(env.log.some(([kind]) => kind === "audioDestroy"));
  assert.equal(env.raf.queue.length, 0);
  await assert.rejects(instance.seek(1), /destroyed/);
});

// The cold-open transition (spec 2026-10-02 §5.2): a 60-frame cold open, then the body; at 30/1
// a flash covers frames 58–62 around J = 60 (§2.2).
const CO_PIECES = [
  { i: 0, seg: "seg_co", role: "cold_open", inSf: 330, outSf: 390, outF0: 0, frames: 60 },
  { i: 1, seg: "seg_b1", role: "body", inSf: 30, outSf: 120, outF0: 60, frames: 90 },
];
const CO_CELLS = [0, 1, 2, 3, 4, 5, 6];
const FLASH = {
  after: "seg_co", style: "flash_white", atF: 60, rgb: [255, 255, 255],
  alphaPm: [[58, 333], [59, 667], [60, 1000], [61, 667], [62, 333]],
  sfx: { id: "whoosh", v: 1, startSmp: 84480, hitSmp: 96000, samples: 20160 },
};
const DIP = {
  after: "seg_co", style: "dip_black", atF: 60, rgb: [0, 0, 0],
  alphaPm: [[56, 111], [57, 333], [58, 556], [59, 778], [60, 1000], [61, 778], [62, 556], [63, 333], [64, 111]],
  sfx: null,
};
const CUT = { after: "seg_co", style: "cut", atF: 60, rgb: null, alphaPm: [], sfx: null };

const coldOpenPlan = (options = {}) => planDto({ pieces: CO_PIECES, ready: CO_CELLS, ...options });

function layersOf(draws) {
  return draws.map((draw) => [draw.image.layer, draw.op, draw.alpha]);
}

test("the transition fill is drawn over the plate and under the text and logo", async () => {
  const env = makeDeps();
  const logo = { box: { x: 560, y: 26, w: 115, h: 115 }, opacityPm: 850, url: "/derived/logo@115x115.png" };
  const { instance, draws, frames } = player(env);
  await instance.load(coldOpenPlan({ joins: [FLASH], logo }));
  await tick();
  const before = draws.length;
  assert.deepEqual(await instance.seek(58), { frame: 58, presented: true });
  assert.deepEqual(layersOf(draws.slice(before)), [
    ["plate", "copy", 1], ["fill", "source-over", 1], ["text", "source-over", 1], ["logo", "source-over", 1],
  ]);
  const fill = draws[before + 1];
  // The whole canvas, blended as the export's lutrgb: ⌊(100·667 + 255·333 + 500) / 1000⌋ = 152.
  assert.deepEqual([fill.region, fill.x, fill.y, fill.pixel], [[0, 0, 720, 1280], 0, 0, [152, 152, 152, 255]]);
  assert.equal(frames.at(-1).frame, 58);
  assert.equal(frames.at(-1).joinAlphaPm, 333);
  const peak = draws.length;
  await instance.seek(60);
  assert.deepEqual(layersOf(draws.slice(peak)), [
    ["plate", "copy", 1], ["fill", "source-over", 1], ["text", "source-over", 1], ["logo", "source-over", 1],
  ]);
  assert.deepEqual([draws[peak].image.k, draws[peak].image.j], [0, 30], "the body's first source frame");
  assert.deepEqual(draws[peak + 1].pixel, [255, 255, 255, 255]);
  assert.equal(frames.at(-1).joinAlphaPm, 1000);
  assert.deepEqual(instance.debug.joinAt(60), { rgb: [255, 255, 255], alphaPm: 1000 });
  assert.equal(instance.debug.joinAt(57), null);
});

test("no fill outside the alpha frames, for a cut join or without joins; onFrame reports 0", async () => {
  const env = makeDeps();
  const { instance, draws, frames } = player(env);
  await instance.load(coldOpenPlan({ joins: [FLASH] }));
  await tick();
  for (const n of [57, 63, 0, 149]) {
    const before = draws.length;
    await instance.seek(n);
    assert.deepEqual(draws.slice(before).map((draw) => draw.image.layer), ["plate", "text"], `frame ${n}`);
    assert.equal(frames.at(-1).joinAlphaPm, 0, `frame ${n}`);
  }
  for (const joins of [[CUT], [], undefined]) {
    await instance.load(coldOpenPlan({ doc: `d-${joins?.length ?? "none"}`, joins }));
    await tick();
    const before = draws.length;
    await instance.seek(60);
    await instance.seek(59);
    assert.ok(!draws.slice(before).some((draw) => draw.image.layer === "fill"), JSON.stringify(joins));
    assert.equal(frames.at(-1).joinAlphaPm, 0);
    assert.equal(instance.debug.joinAt(60), null);
  }
});

test("playback draws the fill on every frame the clock presents", async () => {
  const env = makeDeps();
  const { instance, frames, draws } = player(env);
  await instance.load(coldOpenPlan({ joins: [DIP] }));
  await instance.seek(54);
  const before = draws.length;
  await instance.play();
  for (let n = 55; n <= 66; n += 1) await env.frameTick((n + 0.5) / 30);
  const shown = frames.filter((info) => info.playing).map((info) => [info.frame, info.joinAlphaPm]);
  assert.deepEqual(shown, [
    [55, 0], [56, 111], [57, 333], [58, 556], [59, 778], [60, 1000], [61, 778], [62, 556], [63, 333], [64, 111],
    [65, 0], [66, 0],
  ]);
  // ⌊(100·(1000 − a) + 500) / 1000⌋ toward black, frame by frame.
  const blended = draws.slice(before).filter((draw) => draw.image.layer === "fill").map((draw) => draw.pixel[0]);
  assert.deepEqual(blended, [89, 67, 44, 22, 0, 22, 44, 67, 89]);
  instance.pause();
});

test("a malformed joins list in the plan DTO is refused", async () => {
  const env = makeDeps();
  const { instance } = player(env);
  const bad = {
    "unsorted frames": [{ ...FLASH, alphaPm: [[59, 667], [58, 333], [60, 1000]] }],
    "alpha 0": [{ ...FLASH, alphaPm: [[58, 0], [60, 1000]] }],
    "alpha 1001": [{ ...FLASH, alphaPm: [[58, 333], [60, 1001]] }],
    "rgb with alphas missing": [{ ...FLASH, alphaPm: [] }],
    "a frame at totalFrames": [{ ...FLASH, alphaPm: [[149, 1000], [150, 500]] }],
    "atF past the end": [{ ...FLASH, atF: 151 }],
    "an unknown style": [{ ...FLASH, style: "xfade" }],
    "joins not a list": { 0: FLASH },
    "joins null": null,
  };
  for (const [name, joins] of Object.entries(bad)) {
    const dto = coldOpenPlan({ joins: [FLASH] });
    dto.joins = joins;
    await assert.rejects(instance.load(dto), /invalid plan DTO: joins/, name);
  }
  assert.equal(instance.state().presentedFrame, null, "nothing was loaded");
});

test("a style-only change redraws the paused frame and keeps the mix", async () => {
  const env = makeDeps();
  const { instance, draws, frames } = player(env);
  await instance.load(coldOpenPlan({ joins: [CUT] }));
  await tick();
  await instance.seek(60);
  assert.equal(frames.at(-1).joinAlphaPm, 0);
  const before = draws.length;
  await instance.load(coldOpenPlan({ doc: "d2", joins: [FLASH] }));
  await tick();
  await tick();
  assert.deepEqual(draws.slice(before).map((draw) => [draw.image.layer, draw.alpha]),
    [["plate", 1], ["fill", 1], ["text", 1]]);
  assert.deepEqual(draws[before + 1].pixel, [255, 255, 255, 255]);
  assert.deepEqual([frames.at(-1).frame, frames.at(-1).joinAlphaPm], [60, 1000]);
  const dip = draws.length;
  await instance.load(coldOpenPlan({ doc: "d3", joins: [DIP] }));
  await tick();
  await tick();
  assert.deepEqual(draws.slice(dip).find((draw) => draw.image.layer === "fill").pixel, [0, 0, 0, 255]);
  assert.deepEqual(env.audio.loads, ["m1"], "the same mix is not reloaded");
  assert.equal(env.textLayers[0].tracks.length, 1, "the same ASS is not set again");
  assert.equal(instance.state().exact, true);
});
