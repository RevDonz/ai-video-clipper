// The text layer's compositing (PF-LIBASS, plan §10.3): the libass images of a frame are
// composited per band of overlapping rows instead of over the whole union box (the hook at the
// top and the captions at the bottom leave most rows empty). The result must stay byte-identical
// to the W1 adapter's algorithm, which P-TXT and P-TIME were measured with.
import assert from "node:assert/strict";
import test from "node:test";

import { createTextLayer, workerHelpers } from "../lib/editor/player/text-layer.mjs";

function fakeWorker(replies) {
  const sent = [];
  const worker = {
    sent,
    postMessage(message) {
      sent.push(message);
      const reply = replies[message.op](message.args, sent.length);
      queueMicrotask(() => worker.onmessage({ data: { id: message.id, ok: true, result: reply } }));
    },
    terminate() {},
  };
  queueMicrotask(() => worker.onmessage({ data: { ready: true } }));
  return worker;
}

async function renderTwoChanges(options) {
  const closed = [];
  let id = 0;
  const worker = fakeWorker({
    init: () => ({ fonts: 0 }),
    setTrack: () => ({}),
    render: () => {
      const bitmap = { id: ++id, close() { closed.push(this.id); } };
      return { changed: true, bitmap, x: 0, y: 0, w: 1, h: 1, libassMs: 1 };
    },
  });
  const layer = createTextLayer({ width: 720, height: 1280, fps: [30, 1], jassubUrl: "/j/",
    workerFactory: () => worker, ...options });
  await layer.ready;
  await layer.setTrack("[Script Info]");
  const first = await layer.render(1);
  const second = await layer.render(2);
  return { layer, closed, first, second };
}

test("the bands of a frame are the union layer's non-empty rows, byte for byte", () => {
  const { compositeBands, compositeImages } = workerHelpers();
  let split = 0;
  for (let seed = 1; seed <= 1500; seed += 1) {
    const { images, heap, width, height } = scene(seed);
    const whole = compositeImages(images, heap, width, height);
    const layer = compositeBands(images, heap, width, height);
    if (whole === null) {
      assert.equal(layer, null);
      continue;
    }
    assert.deepEqual([layer.x, layer.y, layer.w, layer.h], [whole.x, whole.y, whole.w, whole.h]);
    const rebuilt = new Uint8ClampedArray(whole.rgba.length);
    let previousBottom = -Infinity;
    for (const band of layer.bands) {
      assert.ok(band.top >= previousBottom, `seed ${seed}: bands are disjoint and in row order`);
      previousBottom = band.bottom;
      assert.equal(band.rgba.length, (band.bottom - band.top) * layer.w * 4);
      rebuilt.set(band.rgba, (band.top - layer.y) * layer.w * 4);
    }
    assert.ok(Buffer.from(rebuilt.buffer).equals(Buffer.from(whole.rgba.buffer, whole.rgba.byteOffset, whole.rgba.byteLength)),
      `seed ${seed}`);
    if (layer.bands.length > 1) split += 1;
  }
  assert.ok(split > 300, `only ${split} frames had several bands`);
});

test("split mode renders one bitmap per band and the caller draws them all", async () => {
  const worker = fakeWorker({
    init: () => ({ fonts: 0 }),
    setTrack: () => ({}),
    render: (args) => ({ changed: true, libassMs: 1, split: args.split,
      parts: [{ bitmap: { id: 1 }, x: 40, y: 160, w: 640, h: 80 }, { bitmap: { id: 2 }, x: 40, y: 980, w: 640, h: 110 }] }),
  });
  const layer = createTextLayer({ width: 720, height: 1280, fps: [30, 1], jassubUrl: "/j/",
    workerFactory: () => worker, split: true, keepBitmaps: true });
  await layer.ready;
  await layer.setTrack("[Script Info]");
  const reply = await layer.render(3);
  assert.equal(worker.sent.at(-1).args.split, true);
  assert.deepEqual(reply.parts.map((part) => [part.bitmap.id, part.x, part.y]), [[1, 40, 160], [2, 40, 980]]);
});

test("by default the layer closes a bitmap once a newer one replaces it (W1 behaviour)", async () => {
  const { closed, first, second } = await renderTwoChanges({});
  assert.deepEqual(closed, [first.bitmap.id]);
  assert.notEqual(second.bitmap, first.bitmap);
});

test("keepBitmaps hands every bitmap to the caller, who renders ahead and closes them", async () => {
  const { layer, closed } = await renderTwoChanges({ keepBitmaps: true });
  assert.deepEqual(closed, []);
  layer.destroy();
  assert.deepEqual(closed, [], "the caller owns them, also on destroy");
});

// The W1 algorithm (web/lib/editor/player/text-layer.mjs at 44b4437), verbatim.
function referenceComposite(images, heap, width, height) {
  let x0 = width, y0 = height, x1 = 0, y1 = 0;
  const parts = [];
  for (const img of images) {
    const opacity = 255 - (img.color & 255);
    const ix0 = Math.max(0, img.dst_x), iy0 = Math.max(0, img.dst_y);
    const ix1 = Math.min(width, img.dst_x + img.w), iy1 = Math.min(height, img.dst_y + img.h);
    if (opacity === 0 || ix1 <= ix0 || iy1 <= iy0) continue;
    let covered = false;
    for (let y = iy0; y < iy1; y++) {
      const row = img.bitmap + (y - img.dst_y) * img.stride - img.dst_x;
      for (let x = ix0; x < ix1; x++) {
        if (heap[row + x] !== 0) {
          covered = true;
          if (x < x0) x0 = x;
          if (x >= x1) x1 = x + 1;
          if (y < y0) y0 = y;
          if (y >= y1) y1 = y + 1;
        }
      }
    }
    if (covered) parts.push({ img, opacity, ix0, iy0, ix1, iy1 });
  }
  if (!parts.length) return null;
  const w = x1 - x0, h = y1 - y0;
  const acc = new Float32Array(w * h * 4);
  for (const { img, opacity, ix0, iy0, ix1, iy1 } of parts) {
    const r = (img.color >>> 24) & 255, g = (img.color >>> 16) & 255, b = (img.color >>> 8) & 255;
    const scale = opacity / 65025;
    for (let y = iy0; y < iy1; y++) {
      const row = img.bitmap + (y - img.dst_y) * img.stride - img.dst_x;
      let o = ((y - y0) * w + (ix0 - x0)) * 4;
      for (let x = ix0; x < ix1; x++, o += 4) {
        const m = heap[row + x];
        if (m === 0) continue;
        const a = m * scale, keep = 1 - a;
        acc[o] = r * a + acc[o] * keep;
        acc[o + 1] = g * a + acc[o + 1] * keep;
        acc[o + 2] = b * a + acc[o + 2] * keep;
        acc[o + 3] = a + acc[o + 3] * keep;
      }
    }
  }
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let o = 0; o < rgba.length; o += 4) {
    const alpha = acc[o + 3];
    if (alpha <= 0) continue;
    rgba[o] = Math.round(acc[o] / alpha);
    rgba[o + 1] = Math.round(acc[o + 1] / alpha);
    rgba[o + 2] = Math.round(acc[o + 2] / alpha);
    rgba[o + 3] = Math.round(alpha * 255);
  }
  return { x: x0, y: y0, w, h, rgba };
}

function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function scene(seed, width = 160, height = 240) {
  const rnd = random(seed);
  const heap = new Uint8Array(1 << 20);
  let offset = 8;
  const images = [];
  const count = 1 + Math.floor(rnd() * 7);
  for (let i = 0; i < count; i += 1) {
    const w = 1 + Math.floor(rnd() * 60);
    const h = 1 + Math.floor(rnd() * 40);
    const stride = w + Math.floor(rnd() * 5);
    // Clusters at the top and bottom (hook and captions), sometimes overlapping, sometimes off-frame.
    const dst_y = (rnd() < 0.5 ? 10 : 170) + Math.floor(rnd() * 50) - 15;
    const dst_x = Math.floor(rnd() * width) - 20;
    for (let k = 0; k < stride * h; k += 1) heap[offset + k] = rnd() < 0.5 ? 0 : Math.floor(rnd() * 256);
    const alpha = [0, 0, 0x40, 0x80, 0xff][Math.floor(rnd() * 5)];
    const color = ((Math.floor(rnd() * 256) << 24) | (Math.floor(rnd() * 256) << 16) | (Math.floor(rnd() * 256) << 8) | alpha) >>> 0;
    images.push({ w, h, stride, dst_x, dst_y, color, bitmap: offset });
    offset += stride * h + 8;
  }
  return { images, heap, width, height };
}

test("banded compositing is byte-identical to the W1 algorithm on 3,000 random frames", () => {
  const { compositeImages } = workerHelpers();
  let layers = 0;
  for (let seed = 1; seed <= 3000; seed += 1) {
    const { images, heap, width, height } = scene(seed);
    const want = referenceComposite(images, heap, width, height);
    const got = compositeImages(images, heap, width, height);
    if (want === null) {
      assert.equal(got, null, `seed ${seed}`);
      continue;
    }
    layers += 1;
    assert.deepEqual([got.x, got.y, got.w, got.h], [want.x, want.y, want.w, want.h], `seed ${seed}`);
    assert.ok(Buffer.from(got.rgba.buffer, got.rgba.byteOffset, got.rgba.byteLength)
      .equals(Buffer.from(want.rgba.buffer, want.rgba.byteOffset, want.rgba.byteLength)), `seed ${seed}`);
  }
  assert.ok(layers > 2000);
});
