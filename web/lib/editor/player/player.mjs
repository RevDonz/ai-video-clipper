// The Editor V3 browser player (plan §6.2; Appendix A.2 createPlayer).
//
// One Canvas2D at the output size, three layers drawn bottom to top for every frame n:
//   1. the plate frame: source-grid frame sf of piece(n), from plate cell k = ⌊sf/C⌋ decoded by
//      WebCodecs through Mediabunny (plate-source.mjs);
//   2. the text bitmap: libass (JASSUB) drawing the server's ASS bytes at now_ms(n)
//      (text-layer.mjs, W1, unchanged);
//   3. the logo: the server's derived PNG drawn 1:1 at its box (logo-layer.mjs).
// Frame n is presented only when all three layers for n are ready (presenter.mjs): the previous
// exact frame stays up otherwise, and nothing approximate or partial is ever drawn (E7).
//
// The clock is an AudioContext({sampleRate: 48000}) playing the server's mix (audio-clock.mjs);
// frame n is presented when the clock reaches n·den/num. During playback the text is rendered
// one frame ahead and the plate cells are decoded ahead in output order, across jumps
// (frame-map.decodeSchedule), so a cut is reached with its frames decoded.
//
// Modes: "live" (the canvas), "auto_render" (revision 0 while its cells are not ready: the auto
// render's own MP4 in the given <video>, frame-stepped, exact by R10), "truth" (a server truth
// frame) and "unsupported" (no WebCodecs/OffscreenCanvas: truth frames at the playhead, no
// playback). Swap rules: an edit (a new document) during playback pauses; a new mix is loaded
// while paused.

import {
  createAudioClock as defaultCreateAudioClock,
  createWallClock as defaultCreateWallClock,
  planChangeDecision,
} from "./audio-clock.mjs";
import { createDeviceCheck } from "./device-check.mjs";
import {
  cellFramesFor,
  cellOf,
  cutFrames,
  decodeSchedule,
  fpsParts,
  frameAt,
  outToSrc,
  preRollFrames,
  totalFrames,
} from "./frame-map.mjs";
import { createLogoLayer as defaultCreateLogoLayer } from "./logo-layer.mjs";
import { createPlateSource as defaultCreatePlateSource } from "./plate-source.mjs";
import { createPresenter } from "./presenter.mjs";
import { createTextLayer as defaultCreateTextLayer } from "./text-layer.mjs";

/** Where the JASSUB worker glue and wasm are served (byte for byte from node_modules/jassub). */
export const DEFAULT_JASSUB_URL = "/api/resources/jassub/";
export const FALLBACK_FAMILY = "DejaVu Sans";
const MAX_TIMING_SAMPLES = 20_000;
const VIDEO_FRAME_WAIT_MS = 250;
const VIDEO_SEEK_TIMEOUT_MS = 5000;
// Playback renders the text of this many frames ahead of the clock (≈ 130 ms at 30 fps), so a
// busy moment of the JASSUB worker does not cost a frame.
const TEXT_AHEAD = 4;
// While paused only the next frames are decoded ahead (frame steps and the start of playback);
// a seek elsewhere stops that work at once (plate-source need({ exclusive })).
const PAUSED_LOOKAHEAD_MS = 300;

function defaultCloneBitmap(bitmap) {
  return typeof globalThis.createImageBitmap === "function" ? globalThis.createImageBitmap(bitmap) : bitmap;
}

function defaultSupports() {
  const g = globalThis;
  return {
    live: typeof g.VideoDecoder === "function" && typeof g.OffscreenCanvas === "function"
      && typeof g.Worker === "function" && typeof g.AudioContext === "function"
      && typeof g.createImageBitmap === "function",
  };
}

function defaultNow() {
  return globalThis.performance ? globalThis.performance.now() : Date.now();
}

function validatePlan(dto) {
  const fail = (what) => { throw new TypeError(`invalid plan DTO: ${what}`); };
  if (!dto || typeof dto !== "object") fail("not an object");
  const fps = fpsParts(dto.fps);
  if (!Array.isArray(dto.pieces) || !dto.pieces.length) fail("pieces");
  if (!Number.isSafeInteger(dto.totalFrames) || dto.totalFrames !== totalFrames(dto.pieces)) fail("totalFrames");
  if (!Number.isSafeInteger(dto.output?.w) || !Number.isSafeInteger(dto.output?.h)) fail("output");
  if (!dto.plate || typeof dto.plate.plateKey !== "string" || !Array.isArray(dto.plate.cells)) fail("plate");
  if (dto.plate.cellFrames !== cellFramesFor(fps)) fail("plate.cellFrames");
  if (dto.plate.w !== dto.output.w || dto.plate.h !== dto.output.h) fail("plate size");
  if (!dto.text || typeof dto.text.assSha256 !== "string" || !Array.isArray(dto.text.fonts)) fail("text");
  if (!dto.audio || typeof dto.audio.mixSha256 !== "string") fail("audio");
  return fps;
}

function pushBounded(list, value) {
  if (list.length < MAX_TIMING_SAMPLES) list.push(value);
}

/**
 * createPlayer({ canvas, fetchImpl, onState, onFrame, video?, requestTruthFrame?, jassubUrl?,
 *   lookaheadMs?, capacity?, deps? })
 * → { load(planDTO) → Promise, play({ silent }?) → Promise, pause(), seek(frame) → Promise,
 *     step(delta) → Promise, showTruthFrame(frame) → Promise, state(), stats(), debug, destroy() }
 *
 * `video`: a <video> element the stage shows in "auto_render" mode (revision-0 fallback).
 * `requestTruthFrame(frame) → Promise<Blob>`: the preview client's truth frame for the current
 * document (Ctrl+Shift+R; the only picture in "unsupported" mode).
 * seek/step resolve to { frame, presented } (plus superseded: true, or pending: "plate"|"text"|
 * "logo" when the frame could not be presented yet; it is presented as soon as it can be).
 */
export function createPlayer({
  canvas,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  onState = () => {},
  onFrame = () => {},
  video = null,
  requestTruthFrame = null,
  jassubUrl = DEFAULT_JASSUB_URL,
  lookaheadMs = 1000,
  capacity = 90,
  deps = {},
} = {}) {
  const d = {
    createTextLayer: defaultCreateTextLayer,
    createPlateSource: defaultCreatePlateSource,
    createAudioClock: defaultCreateAudioClock,
    createWallClock: defaultCreateWallClock,
    createLogoLayer: defaultCreateLogoLayer,
    requestAnimationFrame: (callback) => globalThis.requestAnimationFrame(callback),
    cancelAnimationFrame: (id) => globalThis.cancelAnimationFrame(id),
    now: defaultNow,
    supports: defaultSupports,
    createImageBitmap: (blob, options) => globalThis.createImageBitmap(blob, options),
    cloneBitmap: defaultCloneBitmap,
    ...deps,
  };
  const live = Boolean(d.supports().live);
  let ctx = null;
  let plan = null;
  let fps = null;
  let pieces = [];
  let total = 0;
  let cellFrames = 0;
  let aheadFrames = 30;
  let pausedAheadFrames = 9;
  let mode = live ? "live" : "unsupported";
  let frame = 0;
  let playing = false;
  let ended = false;
  let destroyed = false;
  let waitingFor = null;
  let playWaiter = null;
  let error = null;
  let shown = null; // { planSha, frame } of the live frame on the canvas
  let truthShown = null; // { planSha, frame } of the truth frame on the canvas
  let seekToken = 0;
  let clock = null;
  let rafId = null;
  let videoFrameHandle = null;
  let presenter = createPresenter({ cuts: [] });
  const deviceCheck = createDeviceCheck();
  const textStats = { renders: 0, changed: 0, unchanged: 0, changedTotalMs: [], changedLibassMs: [], totalMs: [] };
  const holdReasons = { plate: 0, text: 0, logo: 0 }; // playing holds, by missing layer
  const holdLog = []; // the last 64 playing holds (diagnostics)
  const seekLog = []; // the last 256 paused presentations: plate and text times (diagnostics)

  // Text layer state. Every render goes through one chain (the layer compares each frame with
  // the one rendered before it); rendered frames are kept as entries { sha, bitmap, x, y } with
  // the player's own copy of the bitmap, so playback can render TEXT_AHEAD frames ahead (the
  // adapter keeps only its last bitmap). An unchanged frame shares the previous frame's entry.
  let textLayer = null;
  let textKey = null;
  let loadedFonts = [];
  let trackSha = null; // the ASS set in the layer
  let wantedTrackSha = null; // the ASS asked for (set once the chain reaches it)
  let textChain = Promise.resolve();
  const textEntries = new Map(); // output frame → entry
  let lastText = null; // the entry of the frame rendered last
  let seekTextWant = null;
  let aheadFrom = 0;
  let aheadBusy = false;

  let plateSource = null;
  let plateFps = null;
  const audio = live ? d.createAudioClock({ fetchImpl, now: d.now }) : null;
  const wall = d.createWallClock({ now: d.now });
  const logo = d.createLogoLayer({ fetchImpl });
  let logoPromise = Promise.resolve();
  let audioPromise = Promise.resolve();

  function assertAlive() {
    if (destroyed) throw new Error("player destroyed");
  }

  function clamp(n) {
    if (!plan) return 0;
    const value = Number.isFinite(n) ? Math.trunc(n) : 0;
    return Math.max(0, Math.min(total - 1, value));
  }

  function cellAt(n) {
    const target = outToSrc(pieces, n);
    if (!target) return null;
    return { ...target, ...cellOf(target.sf, cellFrames) };
  }

  function cellReadyAt(n) {
    const at = cellAt(n);
    return Boolean(at && plateSource && plateSource.cellState(at.k) === "ready");
  }

  function audioCurrent() {
    return Boolean(plan && audio && audio.ready && audio.mixSha256 === plan.audio.mixSha256);
  }

  function current() {
    if (!plan) return { text: false, plate: false, audio: false, logo: false };
    if (mode === "auto_render") return { text: true, plate: true, audio: true, logo: true };
    if (mode === "unsupported") {
      const exact = Boolean(truthShown && truthShown.planSha === plan.planSha256 && truthShown.frame === frame);
      return { text: exact, plate: exact, audio: false, logo: exact };
    }
    return {
      text: trackSha === plan.text.assSha256 && wantedTrackSha === plan.text.assSha256,
      plate: cellReadyAt(frame),
      audio: audioCurrent(),
      logo: logo.readyFor(plan.logo),
    };
  }

  function state() {
    const layers = current();
    const pending = Object.entries(layers).filter(([, ok]) => !ok).map(([name]) => name);
    let exact = false;
    if (plan && !pending.length) {
      if (mode === "auto_render") exact = true;
      else if (mode === "live") exact = Boolean(shown && shown.planSha === plan.planSha256 && shown.frame === frame);
    }
    return {
      mode, frame, playing, ended, waitingFor, exact, error,
      current: layers, pending,
      slow: deviceCheck.slow === true,
      presentedFrame: shown && plan && shown.planSha === plan.planSha256 ? shown.frame : null,
      plate: plateSource ? plateSource.readyCells() : { ready: 0, total: 0 },
    };
  }

  function emit() {
    if (!destroyed) onState(state());
  }

  function recordText(reply) {
    textStats.renders += 1;
    const totalMs = reply.totalMs ?? reply.libassMs ?? 0;
    pushBounded(textStats.totalMs, totalMs);
    if (reply.changed) {
      textStats.changed += 1;
      pushBounded(textStats.changedTotalMs, totalMs);
      pushBounded(textStats.changedLibassMs, reply.libassMs ?? 0);
    } else {
      textStats.unchanged += 1;
    }
    if (deviceCheck.add(totalMs)) emit();
  }

  // --- text ---------------------------------------------------------------------------------

  /** The rendered text of frame n for the current ASS, or null. */
  function textEntry(n) {
    const entry = textEntries.get(n);
    return entry && plan && entry.sha === plan.text.assSha256 && entry.sha === trackSha ? entry : null;
  }

  function releaseText(entries) {
    const alive = new Set(textEntries.values());
    if (lastText) alive.add(lastText);
    for (const entry of entries) {
      if (!alive.has(entry)) entry.bitmap?.close?.();
    }
  }

  function clearText() {
    const old = [...textEntries.values()];
    if (lastText) old.push(lastText);
    textEntries.clear();
    lastText = null;
    releaseText(new Set(old));
  }

  /** Forgets the text of frames before `n` (they are shown or skipped). */
  function pruneText(n) {
    const removed = new Set();
    for (const [frameNumber, entry] of textEntries) {
      if (frameNumber < n) {
        textEntries.delete(frameNumber);
        removed.add(entry);
      }
    }
    if (removed.size) releaseText(removed);
  }

  /**
   * Renders frame n on the text chain and returns its entry (null when the ASS changed meanwhile,
   * or, for a seek, when a newer seek wants another frame).
   */
  function renderText(n, { seek = false } = {}) {
    if (seek) seekTextWant = n;
    const run = textChain.then(async () => {
      const sha = trackSha;
      if (!plan || !textLayer || sha !== plan.text.assSha256) return null;
      const existing = textEntries.get(n);
      if (existing && existing.sha === sha) return existing;
      if (seek && seekTextWant !== n) return null;
      const layer = textLayer;
      const reply = await layer.render(n);
      if (layer !== textLayer || trackSha !== sha) return null;
      recordText(reply);
      let entry = lastText;
      if (reply.changed || !entry || entry.sha !== sha) {
        const bitmap = reply.bitmap ? await d.cloneBitmap(reply.bitmap) : null;
        entry = { sha, bitmap, x: reply.x ?? 0, y: reply.y ?? 0 };
      }
      const previous = lastText;
      lastText = entry;
      textEntries.set(n, entry);
      if (previous && previous !== entry) releaseText(new Set([previous]));
      return entry;
    });
    textChain = run.catch(() => null);
    return run;
  }

  /** Playback: keep the text of frames from…from+TEXT_AHEAD−1 rendered, in frame order. */
  function pumpText(from) {
    aheadFrom = from;
    if (aheadBusy) return;
    aheadBusy = true;
    (async () => {
      try {
        while (playing && plan && !destroyed) {
          let next = null;
          for (let f = aheadFrom; f < Math.min(total, aheadFrom + TEXT_AHEAD); f += 1) {
            if (!textEntry(f)) {
              next = f;
              break;
            }
          }
          if (next === null) break;
          const entry = await renderText(next);
          if (!entry) break;
          layerArrived();
        }
      } catch {
        // a failed render leaves the frame held; the next tick asks again
      } finally {
        aheadBusy = false;
      }
    })();
  }

  async function fetchText(url) {
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`text_fetch_failed:${response.status}`);
    return response.text();
  }

  async function updateText(dto) {
    const fonts = dto.text.fonts.map((font) => font.url);
    const key = `${dto.output.w}x${dto.output.h}@${dto.fps.join("/")}`;
    if (!textLayer || textKey !== key || fonts.some((url) => !loadedFonts.includes(url))) {
      const list = textKey === key ? [...loadedFonts, ...fonts.filter((url) => !loadedFonts.includes(url))] : fonts;
      const old = textLayer;
      const layer = d.createTextLayer({
        width: dto.output.w, height: dto.output.h, fps: dto.fps, jassubUrl, fonts: list,
        fallbackFamily: FALLBACK_FAMILY,
      });
      textLayer = layer;
      textKey = key;
      loadedFonts = list;
      trackSha = null;
      wantedTrackSha = null;
      clearText();
      old?.destroy();
      textChain = textChain.then(() => layer.ready).catch(() => null);
    }
    if (dto.text.assSha256 !== wantedTrackSha) {
      const sha = dto.text.assSha256;
      wantedTrackSha = sha;
      const ass = typeof dto.text.ass === "string" ? dto.text.ass : await fetchText(dto.text.url);
      const layer = textLayer;
      textChain = textChain.then(async () => {
        if (layer !== textLayer || wantedTrackSha !== sha) return;
        await layer.setTrack(ass);
        trackSha = sha;
        clearText();
      });
    }
    await textChain;
  }

  // --- drawing ------------------------------------------------------------------------------

  function context() {
    if (!ctx) {
      ctx = canvas.getContext("2d", { alpha: false, colorSpace: "srgb" });
      ctx.imageSmoothingEnabled = false;
    }
    return ctx;
  }

  function draw(n, bitmap, textAt) {
    const c = context();
    c.globalCompositeOperation = "copy";
    c.drawImage(bitmap, 0, 0);
    c.globalCompositeOperation = "source-over";
    if (textAt?.bitmap) c.drawImage(textAt.bitmap, textAt.x, textAt.y);
    logo.draw(c);
    shown = { planSha: plan.planSha256, frame: n };
    truthShown = null;
    presenter.presented(n);
    const at = cellAt(n);
    onFrame({
      frame: n, sf: at.sf, piece: at.i, cell: at.k, index: at.j, playing, planSha256: plan.planSha256,
      at: d.now(), position: playing && clock ? clock.position() : null,
    });
  }

  function shownIs(n) {
    return Boolean(shown && plan && shown.planSha === plan.planSha256 && shown.frame === n);
  }

  /** Decode ahead of n: the playback window, or a short one while paused (stepping, play). */
  function prefetch(n) {
    if (!plateSource || !plan) return;
    const at = cellAt(n);
    const schedule = decodeSchedule(pieces, n, { cellFrames, aheadFrames: playing ? aheadFrames : pausedAheadFrames });
    plateSource.ensure(schedule, { keep: at ? [[at.k, at.j]] : [] }).catch(() => {});
  }

  function superseded(n) {
    return { frame: n, presented: false, superseded: true };
  }

  async function presentPaused(n) {
    const token = ++seekToken;
    if (mode === "auto_render") return seekVideo(n, token);
    if (mode === "unsupported") return showTruth(n, token);
    const at = cellAt(n);
    if (!at || plateSource.cellState(at.k) !== "ready") {
      emit();
      return { frame: n, presented: false, pending: "plate" };
    }
    const started = d.now();
    const cached = plateSource.frame(at.k, at.j);
    let textMs = null;
    const textPromise = renderText(n, { seek: true }).then((entry) => {
      textMs = d.now() - started;
      return entry;
    });
    textPromise.catch(() => {});
    let bitmap;
    let plateMs = 0;
    try {
      bitmap = cached ?? await plateSource.need(at.k, at.j, { exclusive: true });
      plateMs = d.now() - started;
    } catch (failure) {
      if (token !== seekToken) return superseded(n);
      error = { layer: "plate", message: String(failure?.message ?? failure) };
      emit();
      return { frame: n, presented: false, pending: "plate" };
    }
    if (token !== seekToken) return superseded(n);
    if (!bitmap) return { frame: n, presented: false, pending: "plate" };
    await textPromise.catch(() => null);
    if (token !== seekToken) return superseded(n);
    if (!textEntry(n)) {
      await renderText(n, { seek: true }).catch(() => null); // a track swap came in between
      if (token !== seekToken) return superseded(n);
    }
    const textAt = textEntry(n);
    if (!textAt) {
      emit();
      return { frame: n, presented: false, pending: "text" };
    }
    await logoPromise.catch(() => {});
    if (token !== seekToken) return superseded(n);
    if (!logo.readyFor(plan.logo)) {
      emit();
      return { frame: n, presented: false, pending: "logo" };
    }
    // The bitmap may have been evicted while the text rendered: fetch it again.
    const plateBitmap = plateSource.frame(at.k, at.j) ?? bitmap;
    draw(n, plateBitmap, textAt);
    if (seekLog.length >= 256) seekLog.shift();
    seekLog.push({ n, cold: !cached, plateMs, textMs, totalMs: d.now() - started });
    pruneText(n);
    prefetch(n);
    emit();
    return { frame: n, presented: true };
  }

  // --- playback -------------------------------------------------------------------------------

  function presentPlaying(n) {
    if (shownIs(n)) {
      prefetch(n);
      return;
    }
    const at = cellAt(n);
    const bitmap = plateSource.frame(at.k, at.j);
    const textAt = textEntry(n);
    const logoReady = logo.readyFor(plan.logo);
    const decision = presenter.decide(n, { plate: Boolean(bitmap), text: Boolean(textAt), logo: logoReady });
    if (decision === "present") {
      draw(n, bitmap, textAt);
      pruneText(n);
      pumpText(n + 1);
    } else if (decision === "hold") {
      holdReasons.plate += bitmap ? 0 : 1;
      holdReasons.text += textAt ? 0 : 1;
      holdReasons.logo += logoReady ? 0 : 1;
      if (holdLog.length >= 64) holdLog.shift();
      holdLog.push({ n, plate: Boolean(bitmap), text: Boolean(textAt), at: d.now() });
      if (!bitmap && plateSource.cellState(at.k) === "ready") {
        plateSource.need(at.k, at.j).then(layerArrived, () => {});
      }
      if (!textAt) {
        pruneText(n);
        pumpText(n);
      }
    }
    prefetch(n);
  }

  function layerArrived() {
    if (!playing || mode !== "live" || !clock) return;
    const position = clock.position();
    if (position === null) return;
    const n = frameAt(position, fps);
    if (n < total) presentPlaying(n);
  }

  function scheduleTick() {
    if (rafId === null && playing) rafId = d.requestAnimationFrame(tick);
  }

  function tick() {
    rafId = null;
    if (!playing || destroyed || mode !== "live") return;
    const position = clock ? clock.position() : null;
    const n = position === null ? frame : frameAt(position, fps);
    if (n >= total) {
      finish();
      return;
    }
    if (n !== frame) {
      frame = n;
    }
    presentPlaying(n);
    scheduleTick();
  }

  function finish() {
    stopPlayback();
    ended = true;
    frame = total - 1;
    emit();
    presentPaused(frame).catch(() => {});
  }

  function stopPlayback() {
    playing = false;
    if (rafId !== null) {
      d.cancelAnimationFrame(rafId);
      rafId = null;
    }
    clock?.stop();
    clock = null;
    presenter.stopRun();
    if (video && mode === "auto_render") video.pause();
    stopVideoFrames();
  }

  function releasePlayWaiter(started) {
    if (!playWaiter) return;
    const waiter = playWaiter;
    playWaiter = null;
    waitingFor = null;
    waiter.resolve(started);
  }

  async function startClock(silent) {
    if (silent) {
      wall.start(frame, fps);
      clock = wall;
    } else {
      await audio.start(frame, fps);
      clock = audio;
    }
  }

  // --- revision-0 fallback (<video>) ----------------------------------------------------------

  function decideMode() {
    if (!live) return "unsupported";
    if (plan?.rev0?.exact && plan.rev0.autoRenderUrl && video && !cellReadyAt(frame)) return "auto_render";
    return "live";
  }

  function setMode(next) {
    if (mode === next) return;
    if (mode === "auto_render" && video) video.pause();
    mode = next;
    if (mode === "auto_render") {
      const url = plan.rev0.autoRenderUrl;
      if (video.src !== url) {
        video.preload = "auto";
        video.playsInline = true;
        video.src = url;
      }
    }
  }

  /** Resolves true once the <video> has seeked and composited the frame, false on timeout. */
  function waitVideoFrame() {
    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      const finishWait = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        video.removeEventListener("seeked", onSeeked);
        resolve(ok);
      };
      const onSeeked = () => {
        if (typeof video.requestVideoFrameCallback === "function") {
          video.requestVideoFrameCallback(() => finishWait(true));
          setTimeout(() => finishWait(true), VIDEO_FRAME_WAIT_MS);
        } else {
          finishWait(true);
        }
      };
      video.addEventListener("seeked", onSeeked);
      timer = setTimeout(() => finishWait(false), VIDEO_SEEK_TIMEOUT_MS);
    });
  }

  async function seekVideo(n, token) {
    video.pause();
    const target = ((n + 0.5) * fps[1]) / fps[0];
    let ok = true;
    // A seek to the time already shown fires no "seeked": the frame is already there.
    if (!(video.readyState >= 2 && Math.abs(video.currentTime - target) < 1e-6)) {
      const waited = waitVideoFrame();
      video.currentTime = target;
      ok = await waited;
    }
    if (token !== seekToken) return superseded(n);
    shown = null;
    presenter.invalidate();
    emit();
    return ok ? { frame: n, presented: true } : { frame: n, presented: false, pending: "video" };
  }

  function startVideoFrames() {
    if (typeof video?.requestVideoFrameCallback !== "function") return;
    const step = (_now, metadata) => {
      if (!playing || mode !== "auto_render") return;
      const n = Math.min(total - 1, Math.round((metadata.mediaTime * fps[0]) / fps[1]));
      frame = n;
      onFrame({ frame: n, playing: true, mode: "auto_render", at: d.now(), position: metadata.mediaTime });
      videoFrameHandle = video.requestVideoFrameCallback(step);
    };
    videoFrameHandle = video.requestVideoFrameCallback(step);
  }

  function stopVideoFrames() {
    if (videoFrameHandle !== null && typeof video?.cancelVideoFrameCallback === "function") {
      video.cancelVideoFrameCallback(videoFrameHandle);
    }
    videoFrameHandle = null;
  }

  // --- truth frames ---------------------------------------------------------------------------

  async function showTruth(n, token) {
    if (!requestTruthFrame || !plan) return { frame: n, presented: false, pending: "truth" };
    const planSha = plan.planSha256;
    const blob = await requestTruthFrame(n);
    if (token !== seekToken) return superseded(n);
    const bitmap = await d.createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    if (token !== seekToken) {
      bitmap?.close?.();
      return superseded(n);
    }
    const c = context();
    c.globalCompositeOperation = "copy";
    c.drawImage(bitmap, 0, 0);
    c.globalCompositeOperation = "source-over";
    bitmap?.close?.();
    shown = null;
    truthShown = { planSha, frame: n };
    presenter.invalidate();
    emit();
    return { frame: n, presented: true };
  }

  // --- the API ----------------------------------------------------------------------------------

  const player = {
    async load(dto) {
      assertAlive();
      const nextFps = validatePlan(dto);
      const decision = planChangeDecision({
        playing,
        current: plan ? { docSha256: plan.docSha256, mixSha256: audio?.mixSha256 ?? null } : null,
        next: { docSha256: dto.docSha256, mixSha256: dto.audio.mixSha256 },
      });
      if (decision.pause && playing) player.pause();
      const planChanged = !plan || plan.planSha256 !== dto.planSha256;
      const piecesChanged = !plan || JSON.stringify(plan.pieces) !== JSON.stringify(dto.pieces);
      plan = dto;
      fps = nextFps;
      pieces = dto.pieces;
      total = dto.totalFrames;
      cellFrames = dto.plate.cellFrames;
      aheadFrames = Math.max(preRollFrames(fps, 500) + 1, preRollFrames(fps, lookaheadMs));
      pausedAheadFrames = preRollFrames(fps, PAUSED_LOOKAHEAD_MS);
      if (piecesChanged) presenter = createPresenter({ cuts: cutFrames(pieces) });
      frame = clamp(frame);
      if (canvas.width !== dto.output.w || canvas.height !== dto.output.h) {
        canvas.width = dto.output.w;
        canvas.height = dto.output.h;
        shown = null;
        truthShown = null;
        ctx = null;
      }
      context();
      if (!live) {
        emit();
        if (planChanged || !truthShown) await showTruth(frame, ++seekToken).catch(() => {});
        return;
      }
      if (!plateSource || plateFps !== fps.join("/")) {
        plateSource?.destroy();
        plateSource = d.createPlateSource({ fetchImpl, fps, capacity });
        plateFps = fps.join("/");
      }
      plateSource.setPlate(dto.plate);
      const textPromise = updateText(dto).catch((failure) => {
        error = { layer: "text", message: String(failure?.message ?? failure) };
      });
      logoPromise = logo.load(dto.logo).catch((failure) => {
        error = { layer: "logo", message: String(failure?.message ?? failure) };
      });
      if (decision.swapAudio && !playing) {
        audioPromise = audio.load(dto.audio).catch((failure) => {
          error = { layer: "audio", message: String(failure?.message ?? failure) };
        });
      }
      if (!(playing && mode === "auto_render")) {
        if (mode === "truth" && planChanged) mode = "live";
        if (mode !== "truth") setMode(decideMode());
      }
      emit();
      await Promise.all([textPromise, logoPromise, audioPromise]);
      if (destroyed || plan !== dto) return;
      emit();
      if (playWaiter && audioCurrent()) releasePlayWaiter(true);
      if (!playing && mode === "live" && !shownIs(frame)) presentPaused(frame).catch(() => {});
    },

    async play({ silent = false } = {}) {
      assertAlive();
      if (!plan || playing || mode === "unsupported") return;
      if (mode === "truth") setMode(decideMode());
      if (ended || frame >= total - 1) {
        frame = 0;
        ended = false;
      }
      if (mode === "auto_render") {
        playing = true;
        await video.play();
        startVideoFrames();
        emit();
        return;
      }
      if (!silent && !audioCurrent()) {
        releasePlayWaiter(false);
        waitingFor = "audio";
        emit();
        const started = await new Promise((resolve) => { playWaiter = { resolve }; });
        if (!started || destroyed || playing) return;
      }
      await startClock(silent || !audioCurrent());
      playing = true;
      ended = false;
      presenter.startRun(frame, { shown: shownIs(frame) });
      pumpText(shownIs(frame) ? frame + 1 : frame);
      prefetch(frame);
      scheduleTick();
      emit();
    },

    pause() {
      if (destroyed) return;
      releasePlayWaiter(false);
      if (!playing) {
        emit();
        return;
      }
      if (mode === "auto_render" && video) {
        const n = Math.round((video.currentTime * fps[0]) / fps[1] - 0.5);
        frame = clamp(n);
      }
      stopPlayback();
      if (plan && audio && audio.mixSha256 !== plan.audio.mixSha256) {
        audioPromise = audio.load(plan.audio).catch((failure) => {
          error = { layer: "audio", message: String(failure?.message ?? failure) };
        });
      }
      emit();
    },

    async seek(target) {
      assertAlive();
      if (!plan) return { frame: 0, presented: false, pending: "plan" };
      const n = clamp(target);
      frame = n;
      ended = false;
      if (playing && mode === "live") {
        seekToken += 1;
        clock?.stop();
        await startClock(clock === wall || !audioCurrent());
        presenter.startRun(n, { shown: shownIs(n) });
        presentPlaying(n);
        emit();
        return { frame: n, presented: shownIs(n) };
      }
      if (playing && mode === "auto_render") {
        video.currentTime = ((n + 0.5) * fps[1]) / fps[0];
        return { frame: n, presented: true };
      }
      if (mode !== "unsupported") setMode(decideMode());
      emit();
      return presentPaused(n);
    },

    async step(delta) {
      assertAlive();
      if (playing) player.pause();
      return player.seek(frame + Math.trunc(delta));
    },

    async showTruthFrame(target) {
      assertAlive();
      if (!requestTruthFrame) throw new Error("truth_frame_unavailable");
      if (!plan) return { frame: 0, presented: false, pending: "plan" };
      player.pause();
      const n = clamp(target);
      frame = n;
      if (mode === "auto_render") setMode("live");
      const result = await showTruth(n, ++seekToken);
      if (result.presented && mode !== "unsupported") {
        mode = "truth";
        emit();
      }
      return result;
    },

    state,

    stats() {
      return {
        presenter: { ...presenter.stats(), holdReasons: { ...holdReasons }, recentHolds: holdLog.slice() },
        text: {
          renders: textStats.renders, changed: textStats.changed, unchanged: textStats.unchanged,
          changedTotalMs: textStats.changedTotalMs.slice(), changedLibassMs: textStats.changedLibassMs.slice(),
          totalMs: textStats.totalMs.slice(),
        },
        plate: plateSource ? plateSource.stats() : null,
        seeks: seekLog.slice(),
        device: { slow: deviceCheck.slow, p95: deviceCheck.p95 },
        audio: audio ? { ready: audio.ready, start: audio.startInfo ?? null } : null,
      };
    },

    resetStats() {
      presenter.resetStats();
      holdReasons.plate = 0;
      holdReasons.text = 0;
      holdReasons.logo = 0;
      holdLog.length = 0;
      for (const key of ["changedTotalMs", "changedLibassMs", "totalMs"]) textStats[key] = [];
      textStats.renders = 0;
      textStats.changed = 0;
      textStats.unchanged = 0;
    },

    /** Read-only handles for gates and diagnostics (the parity harness). */
    debug: {
      audioBuffer: () => audio?.buffer ?? null,
      audioContext: () => audio?.context ?? null,
      audioStart: () => (clock === audio ? audio.startInfo ?? null : null),
      clockPosition: () => (clock ? clock.position() : null),
    },

    destroy() {
      if (destroyed) return;
      stopPlayback();
      releasePlayWaiter(false);
      destroyed = true;
      seekToken += 1;
      textLayer?.destroy();
      textLayer = null;
      clearText();
      plateSource?.destroy();
      audio?.destroy();
      logo.destroy();
    },
  };
  return player;
}
