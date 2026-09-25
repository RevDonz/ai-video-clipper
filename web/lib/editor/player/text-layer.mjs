// Text layer of the editor player (plan §6.2): libass in WASM (JASSUB 2.5.16, exact pin) draws
// the server's ASS bytes with the server's font files, one output frame at a time.
//
// * Time: frame n is rendered at libass time now_ms(n), the same integer millisecond FFmpeg's
//   `ass` filter uses (plan §3.4 "ASS time"). The adapter passes now_ms(n)/1000 seconds and
//   JASSUB converts back with (long long)(tm * 1e3 + 0.5) (JASSUB.cpp rawRender), which returns
//   now_ms(n) exactly; the naive n·den/num does not on hazard frames.
// * Fonts: every font of the plan is loaded before the first frame (no lazy lookup, no FOUT),
//   queryFonts is off, and the libass default family (JASSUB's fallback) is DejaVu Sans: the
//   same fallback as the server's fontconfig (R6).
// * Output: one straight-alpha RGBA layer per changed frame, clipped to the bounding box of the
//   libass images and handed over as an ImageBitmap for the Canvas2D compositor
//   (drawImage(bitmap, x, y)). When libass reports no change for frame n, the previous bitmap is
//   reused (render() returns changed: false and the same bitmap).
// * Worker: the libass work runs in a dedicated worker built from WORKER_SOURCE (a Blob URL), so
//   no bundler ever sees JASSUB. JASSUB's WASM glue creates its pthread workers with
//   `new Worker(new URL("jassub-worker.js", import.meta.url))`, a self-reference that hangs
//   Next 16's Turbopack build; the glue and its .wasm are therefore loaded unbundled from
//   `jassubUrl` (a directory serving node_modules/jassub/dist/wasm/{jassub-worker.js,
//   jassub-worker.wasm}, byte for byte). The baseline (non-SIMD) wasm is used: relaxed-SIMD
//   results may differ between machines. libass runs single-threaded: the worker hides
//   crossOriginIsolated from the glue, so no pthread pool (which would re-load this worker) is
//   created even under COOP/COEP; rendering is deterministic either way.

export const JASSUB_VERSION = "2.5.16";
export const JASSUB_GLUE = "jassub-worker.js";
export const JASSUB_WASM = "jassub-worker.wasm";
export const DEFAULT_FALLBACK_FAMILY = "DejaVu Sans";
export const TEXT_LAYER_WORKER_NAME = "potongin-text-layer";

function fpsParts(fps) {
  const [num, den] = Array.isArray(fps) ? fps : [fps?.num, fps?.den];
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || num <= 0 || den <= 0) {
    throw new TypeError("fps must be [num, den] with positive integers");
  }
  return [num, den];
}

// FFmpeg vf_subtitles: trunc(pts · tb · 1000) with tb = den/num, IEEE double, this exact order
// (mirrors ai_clipper.edit_v2.timemap.now_ms).
export function nowMs(n, fps) {
  const [num, den] = fpsParts(fps);
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError("frame must be a non-negative integer");
  return Math.trunc(n * (den / num) * 1000);
}

// The media time handed to JASSUB for output frame n.
export function libassSeconds(n, fps) {
  return nowMs(n, fps) / 1000;
}

// JASSUB.cpp: ass_render_frame(…, (long long)(tm * 1e+3 + 0.5), …).
export function jassubRenderMs(seconds) {
  return Math.trunc(seconds * 1e3 + 0.5);
}

// Runs inside the worker. Plain functions only: this text is never transformed by a bundler.
export const WORKER_SOURCE = String.raw`
"use strict";

// libass images → one straight-alpha RGBA layer over the bounding box of the covered pixels.
// Images are composited in libass order (shadow, border, fill) with the "over" operator in
// premultiplied floating point; alpha = (255 − colour alpha) · mask / 255².
function compositeImages(images, heap, width, height) {
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

// Coverage per RGB colour: covered pixel count, the libass alpha range and the pixel box.
// The parity harness uses it to find the frame on which each lane of the timing fixture
// changes (P-TIME), independent of pixels.
function summarizeImages(images, heap) {
  const colors = {};
  for (const img of images) {
    const key = ((img.color >>> 8) & 0xffffff).toString(16).toUpperCase().padStart(6, "0");
    const alpha = img.color & 255;
    let px = 0, bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (let y = 0; y < img.h; y++) {
      const row = img.bitmap + y * img.stride;
      for (let x = 0; x < img.w; x++) {
        if (heap[row + x] === 0) continue;
        px++;
        if (x < bx0) bx0 = x;
        if (x + 1 > bx1) bx1 = x + 1;
        if (y < by0) by0 = y;
        if (y + 1 > by1) by1 = y + 1;
      }
    }
    if (px === 0) continue;
    const box = [img.dst_x + bx0, img.dst_y + by0, img.dst_x + bx1, img.dst_y + by1];
    const entry = colors[key];
    if (!entry) {
      colors[key] = { px, alpha: [alpha, alpha], box };
    } else {
      entry.px += px;
      entry.alpha = [Math.min(entry.alpha[0], alpha), Math.max(entry.alpha[1], alpha)];
      entry.box = [Math.min(entry.box[0], box[0]), Math.min(entry.box[1], box[1]),
        Math.max(entry.box[2], box[2]), Math.max(entry.box[3], box[3])];
    }
  }
  return { images: images.length, colors };
}

async function textLayerWorker(scope) {
  try {
    // No pthread pool: JASSUB's glue sizes it from crossOriginIsolated.
    Object.defineProperty(scope, "crossOriginIsolated", { value: false, configurable: true });
  } catch (error) {
    // Only a non-isolated page is left, which has no pool anyway.
  }
  let module = null, lib = null, width = 0, height = 0;
  const logs = [];
  const log = (line) => { if (logs.length < 200) logs.push(String(line)); };
  const handlers = {
    async init(args) {
      const glue = await import(new URL(args.glueUrl, args.baseUrl).href);
      module = await glue.default({ __url: new URL(args.glueUrl, args.baseUrl).href, __out: log, __err: log });
      width = args.width;
      height = args.height;
      lib = new module.JASSUB(width, height, args.fallbackFamily);
      lib.setThreads(1);
      const sizes = [];
      for (const font of args.fonts) {
        const response = await fetch(new URL(font, args.baseUrl).href);
        if (!response.ok) throw new Error("font " + font + ": HTTP " + response.status);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const pointer = module._malloc(bytes.byteLength);
        scope.HEAPU8RAW.set(bytes, pointer);
        lib.addFont("font-" + sizes.length, pointer, bytes.byteLength);
        sizes.push(bytes.byteLength);
      }
      lib.reloadFonts();
      lib.resizeCanvas(width, height, width, height);
      return { fonts: sizes.length, fontBytes: sizes, logs: logs.slice() };
    },
    setTrack(args) {
      lib.createTrackMem(args.ass);
      return {};
    },
    async render(args) {
      const started = performance.now();
      const images = lib.rawRender(args.seconds, args.force ? 1 : 0);
      const libassMs = performance.now() - started;
      if (images === null) return { changed: false, libassMs };
      const heap = scope.HEAPU8RAW;
      const summary = args.summary ? summarizeImages(images, heap) : null;
      if (args.bitmap === false) return { changed: true, libassMs, summary };
      const layer = compositeImages(images, heap, width, height);
      if (!layer) return { changed: true, libassMs, summary, bitmap: null, x: 0, y: 0, w: 0, h: 0 };
      const bitmap = await createImageBitmap(new ImageData(layer.rgba, layer.w, layer.h), {
        premultiplyAlpha: "premultiply", colorSpaceConversion: "none",
      });
      return { changed: true, libassMs, summary, bitmap, x: layer.x, y: layer.y, w: layer.w, h: layer.h,
        totalMs: performance.now() - started, transfer: [bitmap] };
    },
    logs() {
      return { logs: logs.slice() };
    },
  };
  scope.onmessage = async (event) => {
    const { id, op, args } = event.data;
    try {
      if (!handlers[op]) throw new Error("unknown op " + op);
      if (op !== "init" && !lib) throw new Error("text layer not initialised");
      const result = await handlers[op](args || {});
      const transfer = result.transfer || [];
      delete result.transfer;
      scope.postMessage({ id, ok: true, result }, transfer);
    } catch (error) {
      scope.postMessage({ id, ok: false, error: String((error && error.message) || error) });
    }
  };
  scope.postMessage({ ready: true });
}

if (typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) textLayerWorker(self);
`;

// The worker's pure helpers, evaluated from the exact worker text (for tests and tools).
export function workerHelpers() {
  // eslint-disable-next-line no-new-func
  return new Function(`${WORKER_SOURCE}\nreturn { compositeImages, summarizeImages };`)();
}

function defaultWorkerFactory(source) {
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  const worker = new Worker(url, { type: "module", name: TEXT_LAYER_WORKER_NAME });
  worker.__blobUrl = url;
  return worker;
}

/**
 * createTextLayer({ width, height, fps, jassubUrl, fonts, fallbackFamily, workerFactory })
 * → { ready, setTrack(ass), render(n), probe(n), logs(), destroy() }
 *
 * render(n) resolves to { frame, changed, bitmap, x, y, w, h, libassMs, totalMs }: draw with
 * ctx.drawImage(bitmap, x, y) (bitmap is null when nothing is visible). The layer owns the
 * bitmaps: the previous one is closed when libass produces a new one.
 * probe(n) returns libass's coverage summary for frame n without building a bitmap.
 * Calls are serialised; setTrack swaps the ASS between frames and forces the next render.
 */
export function createTextLayer({
  width, height, fps, jassubUrl, fonts = [], fallbackFamily = DEFAULT_FALLBACK_FAMILY,
  workerFactory = defaultWorkerFactory,
}) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new TypeError("width and height must be positive integers");
  }
  fpsParts(fps);
  if (typeof jassubUrl !== "string" || !jassubUrl.endsWith("/")) {
    throw new TypeError("jassubUrl must be a directory URL ending in '/'");
  }
  const baseUrl = globalThis.location?.href ?? "http://localhost/";
  const worker = workerFactory(WORKER_SOURCE);
  const pending = new Map();
  let nextId = 1;
  let destroyed = false;
  let forceNext = true;
  let last = { bitmap: null, x: 0, y: 0, w: 0, h: 0 };
  let bootResolve;
  const booted = new Promise((resolve) => { bootResolve = resolve; });
  worker.onmessage = (event) => {
    const data = event.data;
    if (data?.ready) {
      bootResolve();
      return;
    }
    const entry = pending.get(data?.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.ok) entry.resolve(data.result);
    else entry.reject(new Error(data.error));
  };
  worker.onerror = (event) => {
    const error = new Error(`text layer worker failed: ${event?.message ?? "unknown error"}`);
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };

  let queue = booted;
  function call(op, args) {
    if (destroyed) return Promise.reject(new Error("text layer destroyed"));
    const run = queue.then(() => {
      if (destroyed) throw new Error("text layer destroyed");
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, op, args });
      });
    });
    queue = run.catch(() => {});
    return run;
  }

  const glueUrl = new URL(JASSUB_GLUE, new URL(jassubUrl, baseUrl)).href;
  const ready = call("init", {
    width, height, baseUrl, glueUrl, fallbackFamily,
    fonts: fonts.map((font) => (typeof font === "string" ? font : font.url)),
  }).then((result) => {
    if (worker.__blobUrl) URL.revokeObjectURL(worker.__blobUrl);
    return result;
  });

  return {
    ready,
    async setTrack(ass) {
      if (typeof ass !== "string") throw new TypeError("ass must be a string");
      await call("setTrack", { ass });
      forceNext = true;
    },
    async render(n) {
      const force = forceNext;
      const reply = await call("render", { seconds: libassSeconds(n, fps), force, summary: false });
      forceNext = false;
      if (reply.changed) {
        const previous = last.bitmap;
        last = { bitmap: reply.bitmap ?? null, x: reply.x ?? 0, y: reply.y ?? 0, w: reply.w ?? 0, h: reply.h ?? 0 };
        if (previous && previous !== last.bitmap && typeof previous.close === "function") previous.close();
      }
      return { frame: n, changed: reply.changed, ...last, libassMs: reply.libassMs, totalMs: reply.totalMs ?? reply.libassMs };
    },
    async probe(n) {
      const reply = await call("render", { seconds: libassSeconds(n, fps), force: true, summary: true, bitmap: false });
      // libass now compares against the probed frame: the next render must not reuse.
      forceNext = true;
      return reply.summary;
    },
    logs() {
      return call("logs", {}).then((result) => result.logs);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (last.bitmap && typeof last.bitmap.close === "function") last.bitmap.close();
      last = { bitmap: null, x: 0, y: 0, w: 0, h: 0 };
      for (const entry of pending.values()) entry.reject(new Error("text layer destroyed"));
      pending.clear();
      worker.terminate();
      if (worker.__blobUrl) URL.revokeObjectURL(worker.__blobUrl);
    },
  };
}
