import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  JASSUB_VERSION,
  createTextLayer,
  jassubRenderMs,
  libassSeconds,
  nowMs,
  workerHelpers,
} from "../lib/editor/player/text-layer.mjs";

const vectors = JSON.parse(readFileSync(
  new URL("../../tests/fixtures/edit_v2/timemap-vectors.json", import.meta.url), "utf8",
));

test("the adapter pins the JASSUB version that package.json pins", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.dependencies.jassub, JASSUB_VERSION);
  assert.equal(JASSUB_VERSION, "2.5.16");
  assert.equal(pkg.dependencies.mediabunny, "1.59.1");
});

test("nowMs reproduces FFmpeg's double expression on every time-map vector", () => {
  assert.ok(vectors.now_ms.length >= 300);
  for (const { in: [num, den, n], expect } of vectors.now_ms) {
    assert.equal(nowMs(n, [num, den]), expect, `${num}/${den} frame ${n}`);
  }
});

test("libass inside JASSUB sees exactly now_ms(n) on the hazard list", () => {
  const hazards = vectors.now_ms.filter((vector) => vector.hazard);
  assert.ok(hazards.length >= 100);
  for (const { in: [num, den, n], expect } of vectors.now_ms) {
    assert.equal(jassubRenderMs(libassSeconds(n, [num, den])), expect, `${num}/${den} frame ${n}`);
  }
  // The naive media time n·den/num is off by one on hazard frames: this is what the rule fixes.
  const naive = hazards.filter(({ in: [num, den, n], expect }) => jassubRenderMs((n * den) / num) !== expect);
  assert.ok(naive.length > 0);
});

test("JASSUB's conversion is the one in JASSUB.cpp: (long long)(tm * 1e3 + 0.5)", () => {
  assert.equal(jassubRenderMs(32.119), 32119);
  assert.equal(jassubRenderMs(32.1195), 32120);
  assert.equal(jassubRenderMs(0), 0);
});

const { compositeImages, summarizeImages } = workerHelpers();

function heapWith(...bitmaps) {
  const heap = new Uint8Array(1024);
  const images = [];
  let offset = 16;
  for (const { w, h, stride = w, dst_x, dst_y, color, mask } of bitmaps) {
    heap.set(mask, offset);
    images.push({ w, h, stride, dst_x, dst_y, color, bitmap: offset });
    offset += mask.length + 16;
  }
  return { heap, images };
}

function pixel(result, x, y) {
  const i = ((y - result.y) * result.w + (x - result.x)) * 4;
  return Array.from(result.rgba.slice(i, i + 4));
}

test("compositeImages turns libass alpha masks into a straight-alpha RGBA layer", () => {
  const { heap, images } = heapWith({
    w: 2, h: 2, dst_x: 1, dst_y: 1, color: 0xff000000, mask: [255, 128, 0, 255],
  });
  const result = compositeImages(images, heap, 8, 8);
  assert.deepEqual([result.x, result.y, result.w, result.h], [1, 1, 2, 2]);
  assert.deepEqual(pixel(result, 1, 1), [255, 0, 0, 255]);
  assert.deepEqual(pixel(result, 2, 1), [255, 0, 0, 128]);
  assert.equal(pixel(result, 1, 2)[3], 0);
  assert.deepEqual(pixel(result, 2, 2), [255, 0, 0, 255]);
});

test("compositeImages applies the libass colour alpha and blends later images over earlier ones", () => {
  const { heap, images } = heapWith(
    { w: 1, h: 1, dst_x: 0, dst_y: 0, color: 0x00000000, mask: [255] },
    { w: 1, h: 1, dst_x: 0, dst_y: 0, color: 0xffffff00, mask: [128] },
    { w: 1, h: 1, dst_x: 2, dst_y: 0, color: 0x00ff0080, mask: [255] },
  );
  const result = compositeImages(images, heap, 4, 4);
  assert.deepEqual(pixel(result, 0, 0), [128, 128, 128, 255]);
  assert.deepEqual(pixel(result, 2, 0), [0, 255, 0, 127]);
  assert.equal(pixel(result, 1, 0)[3], 0);
});

test("compositeImages clips to the canvas and returns null when nothing is drawn", () => {
  const { heap, images } = heapWith({
    w: 3, h: 2, stride: 4, dst_x: -1, dst_y: 3, color: 0xffffff00, mask: [9, 255, 255, 0, 255, 255, 255, 0],
  });
  const result = compositeImages(images, heap, 2, 4);
  assert.deepEqual([result.x, result.y, result.w, result.h], [0, 3, 2, 1]);
  assert.deepEqual(pixel(result, 0, 3), [255, 255, 255, 255]);
  assert.equal(compositeImages([], heap, 2, 4), null);
  const empty = heapWith({ w: 2, h: 1, dst_x: 0, dst_y: 0, color: 0xffffff00, mask: [0, 0] });
  assert.equal(compositeImages(empty.images, empty.heap, 4, 4), null);
});

test("summarizeImages keys coverage by RGB so lanes and timing can be told apart", () => {
  const { heap, images } = heapWith(
    { w: 2, h: 1, dst_x: 4, dst_y: 5, color: 0xffe14d00, mask: [0, 200] },
    { w: 1, h: 2, dst_x: 1, dst_y: 1, color: 0xffe14d40, mask: [7, 7] },
    { w: 1, h: 1, dst_x: 9, dst_y: 9, color: 0x52c7ff00, mask: [0] },
  );
  const summary = summarizeImages(images, heap);
  assert.equal(summary.images, 3);
  assert.deepEqual(summary.colors.FFE14D, { px: 3, alpha: [0x00, 0x40], box: [1, 1, 6, 6] });
  assert.equal(summary.colors["52C7FF"], undefined);
});

function fakeWorker(replies) {
  const sent = [];
  const worker = {
    sent,
    terminated: false,
    postMessage(message) {
      sent.push(message);
      const reply = replies[message.op](message.args, sent.length);
      queueMicrotask(() => worker.onmessage({ data: { id: message.id, ok: true, result: reply } }));
    },
    terminate() { worker.terminated = true; },
  };
  queueMicrotask(() => worker.onmessage({ data: { ready: true } }));
  return worker;
}

test("createTextLayer renders at now_ms(n)/1000, reuses the bitmap when libass reports no change", async () => {
  let bitmapId = 0;
  const worker = fakeWorker({
    init: () => ({ fonts: 2 }),
    setTrack: () => ({}),
    render: (args) => (args.force || args.seconds === 1.001
      ? { changed: true, bitmap: { id: ++bitmapId }, x: 3, y: 4, w: 5, h: 6, libassMs: 1 }
      : { changed: false, libassMs: 1 }),
  });
  const layer = createTextLayer({
    width: 720, height: 1280, fps: [30000, 1001], jassubUrl: "/j/",
    fonts: [{ url: "/f/a.ttf" }, { url: "/f/b.ttf" }], fallbackFamily: "DejaVu Sans",
    workerFactory: () => worker,
  });
  await layer.ready;
  const init = worker.sent.find((message) => message.op === "init");
  assert.deepEqual(init.args.fonts, ["/f/a.ttf", "/f/b.ttf"]);
  assert.equal(init.args.fallbackFamily, "DejaVu Sans");
  assert.equal(new URL(init.args.glueUrl, "http://x").pathname, "/j/jassub-worker.js");
  await layer.setTrack("[Script Info]");
  const first = await layer.render(30);
  assert.equal(worker.sent.at(-1).args.seconds, nowMs(30, [30000, 1001]) / 1000);
  assert.equal(worker.sent.at(-1).args.force, true); // first frame after setTrack
  assert.equal(first.changed, true);
  assert.equal(first.bitmap.id, 1);
  const second = await layer.render(31);
  assert.equal(worker.sent.at(-1).args.force, false);
  assert.equal(second.changed, false);
  assert.equal(second.bitmap, first.bitmap);
  assert.deepEqual([second.x, second.y, second.w, second.h], [3, 4, 5, 6]);
  await layer.setTrack("[Script Info]\n");
  const third = await layer.render(31);
  assert.equal(third.changed, true);
  assert.equal(third.bitmap.id, 2);
  layer.destroy();
  assert.equal(worker.terminated, true);
  await assert.rejects(layer.render(1), /destroyed/);
});

test("the worker source is self-contained and names no bundler-resolved module", async () => {
  const layer = await import("../lib/editor/player/text-layer.mjs");
  assert.doesNotMatch(layer.WORKER_SOURCE, /\bimport\s+[\w{]/);
  assert.match(layer.WORKER_SOURCE, /crossOriginIsolated/);
  assert.match(layer.WORKER_SOURCE, /setThreads\(1\)/);
});
