"use client";

// The browser half of the text parity harness. It exposes window.__parity to the Playwright spec:
//   state            "loading" | "ready" | "error"
//   info()           browser, JASSUB version, wasm file, fonts, error
//   probe(id, list)  libass coverage summaries (per RGB colour) of clip `id` at frames `list` (P-TIME)
//   composite(id, n) frame n of clip `id` drawn by the text layer over the plate PNG of every
//                    S-COLOR candidate on a Canvas2D, exactly as the player composites it;
//                    returns the text-region crops as base64 PNG plus the count of pixels changed
//                    outside the region (must be 0) (P-TXT, P-COLOR)
// Fixtures come from /api/parity-fixtures/ (scripts/parity/reference_text.py output).
import { useEffect, useState } from "react";

import { JASSUB_VERSION, JASSUB_WASM, createTextLayer } from "../../lib/editor/player/text-layer.mjs";

const BASE = "/api/parity-fixtures/";

async function fetchOk(path) {
  const response = await fetch(`${BASE}${path}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response;
}

function base64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function createHarness(manifest) {
  const [width, height] = manifest.size;
  const clips = new Map(manifest.clips.map((clip) => [clip.id, clip]));
  const fonts = manifest.fonts.map((font) => `${BASE}fonts/${font.file}`);
  const layers = new Map();
  const tracks = new Map();
  const assCache = new Map();
  const bgCache = new Map();
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { alpha: false, colorSpace: "srgb", willReadFrequently: true });

  function layerFor(fps) {
    const key = fps.join("/");
    if (!layers.has(key)) {
      const layer = createTextLayer({
        width, height, fps, jassubUrl: `${BASE}jassub/`, fonts,
        fallbackFamily: manifest.fallback_family || "DejaVu Sans",
      });
      layers.set(key, layer);
    }
    return layers.get(key);
  }

  async function prepare(id) {
    const clip = clips.get(id);
    if (!clip) throw new Error(`unknown clip ${id}`);
    const layer = layerFor(clip.fps);
    await layer.ready;
    if (tracks.get(layer) !== id) {
      if (!assCache.has(id)) assCache.set(id, await (await fetchOk(clip.files.ass)).text());
      await layer.setTrack(assCache.get(id));
      tracks.set(layer, id);
    }
    return { clip, layer };
  }

  async function background(path) {
    if (!bgCache.has(path)) {
      const blob = await (await fetchOk(path)).blob();
      bgCache.set(path, await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" }));
    }
    return bgCache.get(path);
  }

  async function probe(id, frames) {
    const { layer } = await prepare(id);
    const summaries = {};
    for (const frame of frames) summaries[frame] = await layer.probe(frame);
    return summaries;
  }

  async function composite(id, frame) {
    const { clip, layer } = await prepare(id);
    const started = performance.now();
    const text = await layer.render(frame);
    const renderMs = performance.now() - started;
    const [x0, y0, x1, y1] = clip.text_region;
    const pngs = {};
    const outside = {};
    for (const format of manifest.formats) {
      const bg = await background(clip.files.bg[format][String(frame)]);
      ctx.globalCompositeOperation = "copy";
      ctx.drawImage(bg, 0, 0);
      const plate = ctx.getImageData(0, 0, width, height).data;
      ctx.globalCompositeOperation = "source-over";
      if (text.bitmap) ctx.drawImage(text.bitmap, text.x, text.y);
      const drawn = ctx.getImageData(0, 0, width, height).data;
      let leaks = 0;
      for (let y = 0; y < height; y++) {
        const inside = y >= y0 && y < y1;
        for (let x = 0; x < width; x++) {
          if (inside && x >= x0 && x < x1) continue;
          const i = (y * width + x) * 4;
          if (drawn[i] !== plate[i] || drawn[i + 1] !== plate[i + 1] || drawn[i + 2] !== plate[i + 2]) leaks++;
        }
      }
      outside[format] = leaks;
      const crop = new OffscreenCanvas(x1 - x0, y1 - y0);
      crop.getContext("2d", { alpha: false, colorSpace: "srgb" })
        .putImageData(ctx.getImageData(x0, y0, x1 - x0, y1 - y0), 0, 0);
      const blob = await crop.convertToBlob({ type: "image/png" });
      pngs[format] = base64(new Uint8Array(await blob.arrayBuffer()));
    }
    return { frame, changed: text.changed, libassMs: text.libassMs, renderMs, pngs, outside };
  }

  return {
    probe,
    composite,
    destroy() {
      for (const layer of layers.values()) layer.destroy();
      for (const bitmap of bgCache.values()) bitmap.close();
    },
  };
}

export default function ParityHarness() {
  const [status, setStatus] = useState("loading");
  useEffect(() => {
    let harness = null;
    let cancelled = false;
    const api = {
      state: "loading",
      error: null,
      manifest: null,
      info: () => ({
        browser: navigator.userAgent,
        jassub: JASSUB_VERSION,
        wasm: JASSUB_WASM,
        crossOriginIsolated: globalThis.crossOriginIsolated === true,
        fonts: api.manifest?.fonts ?? [],
        clips: api.manifest?.clips.length ?? 0,
        error: api.error,
      }),
      probe: (id, frames) => harness.probe(id, frames),
      composite: (id, frame) => harness.composite(id, frame),
    };
    window.__parity = api;
    (async () => {
      try {
        const manifest = await (await fetchOk("manifest.json")).json();
        if (manifest.schema !== "potongin.parity-text/1") throw new Error(`unexpected manifest ${manifest.schema}`);
        if (cancelled) return;
        api.manifest = manifest;
        harness = createHarness(manifest);
        api.state = "ready";
        setStatus(`ready: ${manifest.clips.length} clips`);
      } catch (error) {
        api.error = String(error?.message || error);
        api.state = "error";
        setStatus(`error: ${api.error}`);
      }
    })();
    return () => {
      cancelled = true;
      harness?.destroy();
      if (window.__parity === api) delete window.__parity;
    };
  }, []);
  return (
    <main style={{ padding: 16, fontFamily: "monospace" }}>
      <h1 style={{ fontSize: 16 }}>Parity harness (dev/CI)</h1>
      <p id="parity-status">{status}</p>
    </main>
  );
}
