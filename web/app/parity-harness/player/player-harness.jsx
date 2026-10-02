"use client";

// The browser half of the player gates. It exposes window.__player to
// web/e2e/editor-player.spec.mjs; every call goes through createPlayer exactly as the editor
// uses it (plate cells → WebCodecs/Mediabunny, ASS → JASSUB, derived logo, the mix on an
// AudioContext at 48 kHz), and reads the result back from the canvas:
//   open(caseId, variant?, { rev0Fallback }?)  a fresh player with the case's plan DTO
//   readFrames(frames, { crop })     seek each frame; barcode index and crop x from the canvas (P-FRAME)
//   laneStates(frames, lanes)        seek each frame; per-lane text state from the canvas (P-TIME)
//   composite(frames)                seek each frame; the canvas as PNG (P-TXT, P-LOGO, P-JOIN-B)
//   joinCheck(frames)                seek each frame; the transition alpha the player drew
//                                    (onFrame.joinAlphaPm) and debug.joinAt (P-JOIN-B)
//   audioCheck()                     the decoded AudioBuffer vs the reference PCM (P-AUD)
//   playProbe({ fromFrame, pixels }) real-time playback; per presented frame: the barcode on the
//                                    canvas and the audio heard (getOutputTimestamp) (P-SYNC,
//                                    PF-PLAY, PF-LIBASS)
//   seekBench({ count, total, seed }) paused seek → frame on screen (PF-SEEK)
//   memoryWorkout(...)               load, play and seek across a 300 s clip (PF-MEM)
//   truthCheck(frames), fallbackCheck(frames)   truth frames; the revision-0 <video> fallback
// Fixtures come from /api/parity-fixtures/player/ (scripts/parity/player_fixtures.py).
import { useEffect, useRef, useState } from "react";

import { createPlayer } from "../../../lib/editor/player/player.mjs";
import { JASSUB_VERSION } from "../../../lib/editor/player/text-layer.mjs";
import { decodeCropX, decodeIndex, pattern, planeFromRgba } from "./barcode.mjs";

const BASE = "/api/parity-fixtures/";
const JASSUB_URL = `${BASE}jassub/`;
const WIDTH = 720;
const HEIGHT = 1280;

async function fetchOk(path) {
  const url = path.startsWith("/") ? path : `${BASE}${path}`;
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition, timeoutMs, what = "condition", describe = () => "") {
  const until = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > until) throw new Error(`timed out waiting for ${what} ${describe()}`);
    await sleep(5);
  }
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function base64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((sorted.length * p) / 100) - 1)];
}

function hexRgb(hex) {
  const value = Number.parseInt(hex, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function createHarness(manifest, stage) {
  const cases = new Map(manifest.cases.map((item) => [item.id, item]));
  let player = null;
  let canvas = null;
  let item = null;
  let dto = null;
  let frameListener = null;
  const drawnAlpha = new Map(); // frame → onFrame.joinAlphaPm of its last live drawing
  const strip = new Uint8Array(WIDTH * HEIGHT);

  async function planFor(caseId, variant) {
    const entry = cases.get(caseId);
    const path = entry.plans[variant ?? entry.default_variant];
    if (!path) throw new Error(`${caseId}: no plan ${variant}`);
    return (await fetchOk(path)).json();
  }

  function readCanvas(x = 0, y = 0, w = WIDTH, h = HEIGHT) {
    return canvas.getContext("2d").getImageData(x, y, w, h).data;
  }

  function describe() {
    const { mode, frame, presentedFrame, pending, error, plate } = player.state();
    return JSON.stringify({ case: item?.id, mode, frame, presentedFrame, pending, error, plate });
  }

  async function presented(n, timeoutMs = 15_000) {
    await waitFor(() => player.state().presentedFrame === n && player.state().frame === n, timeoutMs, `frame ${n}`, describe);
  }

  async function seekShown(n) {
    const started = performance.now();
    const result = await player.seek(n);
    if (!result.presented) await presented(n);
    return performance.now() - started;
  }

  function sourcePattern() {
    return pattern(item.decode.source[0], item.decode.source[1]);
  }

  function indexOf(rgba) {
    const plane = planeFromRgba(rgba, WIDTH, HEIGHT);
    return decodeIndex(plane, WIDTH, HEIGHT, sourcePattern(), { scale: item.decode.scale, top: item.decode.top });
  }

  // Only the rows of the index bands, into a persistent plane: cheap enough for every frame of a
  // playback run.
  function indexFast() {
    const p = sourcePattern();
    const y0 = Math.max(0, Math.floor(item.decode.top));
    const y1 = Math.min(HEIGHT, Math.ceil(item.decode.top + 27 * p.bandH * item.decode.scale) + 1);
    const rgba = readCanvas(0, y0, WIDTH, y1 - y0);
    for (let i = 0, o = 1; i < (y1 - y0) * WIDTH; i += 1, o += 4) strip[y0 * WIDTH + i] = rgba[o];
    return decodeIndex(strip, WIDTH, HEIGHT, p, { scale: item.decode.scale, top: item.decode.top });
  }

  const api = {
    async open(caseId, variant = null, { rev0Fallback = false } = {}) {
      player?.destroy();
      canvas?.remove();
      item = cases.get(caseId);
      if (!item) throw new Error(`unknown case ${caseId}`);
      canvas = document.createElement("canvas");
      canvas.width = WIDTH;
      canvas.height = HEIGHT;
      canvas.style.width = "270px";
      canvas.style.height = "480px";
      stage.host.appendChild(canvas);
      stage.video.removeAttribute("src");
      stage.video.load();
      drawnAlpha.clear();
      const truthFiles = item.truth?.files ?? {};
      player = createPlayer({
        canvas,
        jassubUrl: JASSUB_URL,
        video: rev0Fallback ? stage.video : null,
        onFrame: (info) => {
          if (typeof info.joinAlphaPm === "number") drawnAlpha.set(info.frame, info.joinAlphaPm);
          frameListener?.(info);
        },
        requestTruthFrame: async (n) => {
          const file = truthFiles[String(n)];
          if (!file) throw new Error(`no truth frame ${n}`);
          return (await fetchOk(file)).blob();
        },
      });
      dto = await planFor(caseId, rev0Fallback ? "rev0" : variant);
      await player.load(dto);
      await waitFor(() => player.state().mode === "auto_render"
        || player.state().presentedFrame === player.state().frame, 30_000, "the first frame", describe);
      return { totalFrames: dto.totalFrames, mode: player.state().mode };
    },

    async readFrames(frames, { crop = false } = {}) {
      const out = [];
      const ms = [];
      const p = sourcePattern();
      for (const n of frames) {
        ms.push(await seekShown(n));
        const plane = planeFromRgba(readCanvas(), WIDTH, HEIGHT);
        out.push({
          presented: player.state().presentedFrame === n,
          index: decodeIndex(plane, WIDTH, HEIGHT, p, { scale: item.decode.scale, top: item.decode.top }),
          cropX: crop ? decodeCropX(plane, WIDTH, HEIGHT, p, { scale: item.decode.crop_scale, top: 0 }) : null,
        });
      }
      return { frames: out, seekMs: { p50: percentile(ms, 50), p95: percentile(ms, 95), max: Math.max(...ms) } };
    },

    async laneStates(frames, lanes) {
      const states = {};
      for (const n of frames) {
        await seekShown(n);
        const rgba = readCanvas();
        const at = (x, y) => (y * WIDTH + x) * 4;
        const entry = {};
        for (const [name, lane] of Object.entries(lanes)) {
          const y0 = Math.max(0, lane.y - 45);
          const y1 = Math.min(HEIGHT, lane.y + 95);
          const plate = rgba.slice(at(2, lane.y), at(2, lane.y) + 3);
          if (lane.fade) {
            // Presence: any pixel off the (exactly uniform) flat plate. On the first frame of a
            // \fad(150,250) event the opacity is only 2–11 ms / 150 ms, a change of 2–13 levels.
            let on = false;
            for (let y = y0; y < y1 && !on; y += 1) {
              for (let x = 0; x < WIDTH; x += 1) {
                const i = at(x, y);
                if (rgba[i] !== plate[0] || rgba[i + 1] !== plate[1] || rgba[i + 2] !== plate[2]) {
                  on = true;
                  break;
                }
              }
            }
            entry[name] = on ? "on" : "off";
            continue;
          }
          const parts = [];
          for (const hex of lane.colors) {
            const [r, g, b] = hexRgb(hex);
            let px = 0;
            let box = null;
            for (let y = y0; y < y1; y += 1) {
              for (let x = 0; x < WIDTH; x += 1) {
                const i = at(x, y);
                if (Math.abs(rgba[i] - r) <= 2 && Math.abs(rgba[i + 1] - g) <= 2 && Math.abs(rgba[i + 2] - b) <= 2) {
                  px += 1;
                  box = box ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x + 1), Math.max(box[3], y + 1)]
                    : [x, y, x + 1, y + 1];
                }
              }
            }
            if (px) parts.push(`${hex}:${px}:${box.join(",")}`);
          }
          entry[name] = parts.join("|");
        }
        states[String(n)] = entry;
      }
      return states;
    },

    async composite(frames) {
      const shots = [];
      for (const n of frames) {
        await seekShown(n);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
        shots.push({ frame: n, presented: player.state().presentedFrame === n,
          png: base64(new Uint8Array(await blob.arrayBuffer())) });
      }
      return shots;
    },

    async joinCheck(frames) {
      const out = [];
      for (const n of frames) {
        drawnAlpha.delete(n);
        const seekMs = await seekShown(n);
        const overlay = player.debug.joinAt(n);
        out.push({ frame: n, presented: player.state().presentedFrame === n,
          joinAlphaPm: drawnAlpha.get(n) ?? null, joinAt: overlay ? overlay.alphaPm : 0,
          rgb: overlay ? [...overlay.rgb] : null, seekMs });
      }
      return out;
    },

    async audioCheck() {
      await waitFor(() => player.state().current.audio, 60_000, "the mix");
      const buffer = player.debug.audioBuffer();
      const context = player.debug.audioContext();
      const reference = new Int16Array(await (await fetchOk(item.pcm)).arrayBuffer());
      const channels = [buffer.getChannelData(0), buffer.getChannelData(buffer.numberOfChannels > 1 ? 1 : 0)];
      const length = Math.min(buffer.length, reference.length / 2);
      let maxDiff = 0;
      let differing = 0;
      let notExact = 0; // under Chromium's int16 → float scaling (x/32768 below 0, x/32767 above)
      for (let i = 0; i < length; i += 1) {
        for (let c = 0; c < 2; c += 1) {
          const value = channels[c][i];
          const want = reference[2 * i + c];
          const delta = Math.abs(value * 32768 - want);
          if (delta > maxDiff) maxDiff = delta;
          if (delta > 0) differing += 1;
          if (Math.round(value < 0 ? value * 32768 : value * 32767) !== want) notExact += 1;
        }
      }
      return { contextRate: context.sampleRate, bufferRate: buffer.sampleRate, length: buffer.length,
        referenceLength: reference.length / 2, planSamples: dto.audio.samples, channels: buffer.numberOfChannels,
        maxDiffLsb: maxDiff, differingSamples: differing, notExactUnderInt16Scaling: notExact };
    },

    async playProbe({ fromFrame = 0, pixels = true } = {}) {
      await waitFor(() => player.state().current.audio, 60_000, "the mix");
      await seekShown(fromFrame);
      player.resetStats();
      const [num, den] = dto.fps;
      const samples = [];
      let start = null;
      frameListener = (info) => {
        if (!info.playing) return;
        const context = player.debug.audioContext();
        start ??= player.debug.audioStart();
        const stamp = context.getOutputTimestamp();
        const now = performance.now();
        const heard = stamp.contextTime + (now - stamp.performanceTime) / 1000;
        const position = start.offset + Math.max(0, heard - start.when);
        samples.push({ frame: info.frame, index: pixels ? indexFast() : null,
          audioFrames: (position * num) / den, clockFrames: (info.position * num) / den, at: now });
      };
      const seconds = ((dto.totalFrames - fromFrame) * den) / num;
      await player.play();
      await waitFor(() => !player.state().playing, (seconds + 20) * 1000, "the end of playback");
      frameListener = null;
      const stats = player.stats();
      const context = player.debug.audioContext();
      return {
        samples, stats: stats.presenter,
        text: { changedTotalMs: stats.text.changedTotalMs, changedLibassMs: stats.text.changedLibassMs,
          unchanged: stats.text.unchanged, renders: stats.text.renders },
        clock: { sampleRate: context.sampleRate, baseLatency: context.baseLatency ?? null,
          outputLatency: context.outputLatency ?? null },
        firstFrame: samples.length ? samples[0].frame : null,
        lastFrame: samples.length ? samples[samples.length - 1].frame : null,
        slow: player.state().slow,
      };
    },

    async seekBench({ count = 60, total, seed = 7 } = {}) {
      const random = mulberry32(seed);
      const ms = [];
      let cold = 0;
      for (let i = 0; i < count; i += 1) {
        const n = Math.floor(random() * total);
        const before = player.stats().plate.framesKept;
        ms.push(await seekShown(n));
        if (player.stats().plate.framesKept > before) cold += 1;
      }
      const stats = player.stats();
      return { ms, cold, seeks: stats.seeks.slice(-count), passes: stats.plate.passTimes };
    },

    async memoryWorkout({ total, seeks = 40, playSeconds = 20, seed = 11 } = {}) {
      await waitFor(() => player.state().current.audio, 120_000, "the mix");
      await player.play();
      await sleep(playSeconds * 1000);
      player.pause();
      const random = mulberry32(seed);
      for (let i = 0; i < seeks; i += 1) await seekShown(Math.floor(random() * total));
      const stats = player.stats();
      return { audioSeconds: player.debug.audioBuffer().duration, cachedFrames: stats.plate.cached,
        framesDecoded: stats.plate.framesDecoded, cellFetches: stats.plate.cellFetches, seeks,
        playSeconds, presented: stats.presenter.presented };
    },

    async truthCheck(frames) {
      const out = [];
      for (const n of frames) {
        const result = await player.showTruthFrame(n);
        const blob = await (await fetchOk(item.truth.files[String(n)])).blob();
        const bitmap = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
        const scratch = new OffscreenCanvas(WIDTH, HEIGHT);
        const ctx = scratch.getContext("2d", { alpha: false, colorSpace: "srgb", willReadFrequently: true });
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        const want = ctx.getImageData(0, 0, WIDTH, HEIGHT).data;
        const got = readCanvas();
        let maxDiff = 0;
        for (let i = 0; i < want.length; i += 4) {
          for (let c = 0; c < 3; c += 1) maxDiff = Math.max(maxDiff, Math.abs(want[i + c] - got[i + c]));
        }
        out.push({ frame: n, presented: result.presented, mode: player.state().mode, maxDiff });
      }
      return out;
    },

    async fallbackCheck(frames) {
      const mode = player.state().mode;
      const scratch = new OffscreenCanvas(WIDTH, HEIGHT);
      const ctx = scratch.getContext("2d", { alpha: false, colorSpace: "srgb", willReadFrequently: true });
      const out = [];
      for (const n of frames) {
        const result = await player.seek(n);
        ctx.drawImage(stage.video, 0, 0, WIDTH, HEIGHT);
        out.push({ frame: n, presented: result.presented, index: indexOf(ctx.getImageData(0, 0, WIDTH, HEIGHT).data) });
      }
      await player.load(await planFor(item.id, "default"));
      await player.seek(frames[0]);
      return { mode, frames: out, liveAfterCells: player.state().mode };
    },

    // Diagnostics (not gates).
    debugState() {
      const { mode, frame, presentedFrame, pending, error, current } = player.state();
      const stats = player.stats();
      const plate = stats.plate
        ? { passes: stats.plate.passes, errors: stats.plate.errors, abandoned: stats.plate.abandoned ?? null }
        : null;
      return { case: item?.id, mode, frame, presentedFrame, pending, error, current, audio: stats.audio, plate,
        paused: stats.paused ?? null };
    },
    debugVideo() {
      const v = stage.video;
      return { readyState: v.readyState, currentTime: v.currentTime, videoWidth: v.videoWidth, paused: v.paused,
        seeking: v.seeking, error: v.error ? v.error.code : null, src: v.currentSrc, mode: player.state().mode };
    },
    async seekOnly(n) {
      return player.seek(n);
    },

    destroy() {
      player?.destroy();
      canvas?.remove();
    },
  };
  return api;
}

export default function PlayerHarness() {
  const [status, setStatus] = useState("loading");
  const hostRef = useRef(null);
  const videoRef = useRef(null);
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
        crossOriginIsolated: globalThis.crossOriginIsolated === true,
        webcodecs: typeof globalThis.VideoDecoder === "function",
        hardwareConcurrency: navigator.hardwareConcurrency ?? null,
        cases: api.manifest?.cases.length ?? 0,
        error: api.error,
      }),
    };
    for (const name of ["open", "readFrames", "laneStates", "composite", "joinCheck", "audioCheck", "playProbe",
      "seekBench", "memoryWorkout", "truthCheck", "fallbackCheck", "debugState", "debugVideo", "seekOnly"]) {
      api[name] = (...args) => harness[name](...args);
    }
    window.__player = api;
    (async () => {
      try {
        const manifest = await (await fetchOk("player/manifest.json")).json();
        if (manifest.schema !== "potongin.parity-player/1") throw new Error(`unexpected manifest ${manifest.schema}`);
        if (cancelled) return;
        api.manifest = manifest;
        harness = createHarness(manifest, { host: hostRef.current, video: videoRef.current });
        api.state = "ready";
        setStatus(`ready: ${manifest.cases.length} cases`);
      } catch (error) {
        api.error = String(error?.message || error);
        api.state = "error";
        setStatus(`error: ${api.error}`);
      }
    })();
    return () => {
      cancelled = true;
      harness?.destroy();
      if (window.__player === api) delete window.__player;
    };
  }, []);
  return (
    <main style={{ padding: 16, fontFamily: "monospace" }}>
      <h1 style={{ fontSize: 16 }}>Player parity harness (dev/CI)</h1>
      <p id="player-status">{status}</p>
      <div style={{ display: "flex", gap: 16 }}>
        <div ref={hostRef} data-testid="player-host" />
        <video ref={videoRef} muted playsInline style={{ width: 270, height: 480 }} />
      </div>
    </main>
  );
}
