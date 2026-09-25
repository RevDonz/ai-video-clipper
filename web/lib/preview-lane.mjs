// The server preview lane (plan §2.6, §4.2, §4.3, §6; T2.3).
//
// Every piece of preview work is a call of `python -m ai_clipper.edit_v2.preview_cli` through
// web/lib/python-cli.mjs (allowlisted env, bounded IO, process-group kill; E11):
//
// * plan: one light process per request (at most PLAN_SLOTS at once). A newer plan request for
//   the same clip aborts the superseded one (409 `superseded`); an identical request body shares
//   the one in flight, and a repeated body (the client polling for readiness) is answered from a
//   small cache with the cell, audio and logo states refreshed from disk, without a new process.
// * heavy work (plate cells, the audio mix, truth frames, derived logos, prepare with its camera
//   plan): at most HEAVY_SLOTS processes (plan §2.6: semaphore 2; the CLI renices itself to 5
//   and caps FFmpeg at 2 threads). Priority: truth frame, then audio and logo, then prepare, then
//   cells. When every slot holds cells, a higher-priority job preempts the newest cell job.
// * cells: the playhead's cell first and alone (a fast first frame), then batches of up to
//   MAX_BATCH_CELLS consecutive cells in playback order from the playhead, wrapping around.
// * cancellation of superseded work (a new plate key, a new mix, a preemption) writes
//   `preview/.cancel/<token>` in the clip directory; the CLI polls it, kills FFmpeg's process
//   group and exits 12. python-cli's SIGKILL of the Python group would leave FFmpeg (its own
//   session) running, so the marker comes first and the kill is only the fallback after 5 s.
// * caches: `preview/{plates,audio,ass,frames,derived}` of every clip of a job are held under
//   a per-job cap (K11: 1 GiB) by evicting the least recently used files; a file used within
//   `protectMs` is kept. The existing storage-admission scan counts these files (they live in
//   the job directory).
import { createHash, randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { lstat, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import { SESSION_COOKIE, requireAuth } from "./auth.mjs";
import { CLIP_ID, FRAME_FILE, JOB_ID, openClipFile, openedFileResponse } from "./clip-media.mjs";
import { PythonCliError, httpStatusForExit, runPythonCli } from "./python-cli.mjs";
import { createEditorRateLimits } from "./rate-limit.mjs";
import { sameOriginMutation } from "./request-security.mjs";

export const PREVIEW_MODULE = "ai_clipper.edit_v2.preview_cli";
export const LAYOUTS = Object.freeze(["fit_blur", "camera", "fill_center"]);
export const DEFAULT_CACHE_CAP_BYTES = 1024 * 1024 * 1024; // K11
export const HEAVY_SLOTS = 2;
export const PLAN_SLOTS = 4;
export const MAX_BATCH_CELLS = 4;
export const MAX_DOC_REQUEST_BYTES = 1024 * 1024 + 4096; // a ≤ 1 MiB document plus its wrapper
export const MAX_PREPARE_BYTES = 1024;
export const PRIORITY = Object.freeze({ frame: 0, audio: 1, derive: 1, prepare: 2, cells: 3 });
const CACHE_DIRS = Object.freeze(["plates", "audio", "ass", "frames", "derived"]);
const PLAN_TIMEOUT_MS = 20_000;
const CANCEL_GRACE_MS = 5_000;
const DTO_TTL_MS = 10 * 60_000;
const DTO_CACHE_PER_CLIP = 4;
const RETRY_BACKOFF_MS = 30_000;
const DONE_MEMORY_MS = 30_000;
const STALE_TEMP_MS = 10 * 60_000;
const CAP_INTERVAL_MS = 2_000;
const MAX_ACCESS_ENTRIES = 50_000;
const MAX_CLIPS = 64;
const MEMORY_ENTRIES = 64;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;

export class LaneRequestError extends Error {
  constructor(status, code) {
    super(`preview request: ${code}`);
    this.name = "LaneRequestError";
    this.status = status;
    this.code = code;
  }
}

export function editorV3Enabled(env = process.env) {
  return env.POTONGIN_EDITOR_V3 === "on";
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isFrame = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function parseJsonObject(buffer, limit) {
  if (!Buffer.isBuffer(buffer)) throw new LaneRequestError(400, "invalid_request");
  if (buffer.length > limit) throw new LaneRequestError(413, "invalid_request");
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
  } catch {
    throw new LaneRequestError(400, "invalid_request");
  }
  if (!isObject(value)) throw new LaneRequestError(400, "invalid_request");
  return value;
}

function onlyKeys(value, allowed) {
  if (!Object.keys(value).every((key) => allowed.includes(key))) throw new LaneRequestError(400, "invalid_request");
}

/** `{doc, known?: {assSha256?}, playhead?}` (plan §4.2; `playhead`: the output frame to build first). */
export function parsePlanBody(buffer) {
  const value = parseJsonObject(buffer, MAX_DOC_REQUEST_BYTES);
  onlyKeys(value, ["doc", "known", "playhead"]);
  if (!isObject(value.doc)) throw new LaneRequestError(400, "invalid_request");
  if (value.known !== undefined) {
    if (!isObject(value.known)) throw new LaneRequestError(400, "invalid_request");
    onlyKeys(value.known, ["assSha256"]);
    const sha = value.known.assSha256;
    if (sha !== undefined && sha !== null && !(typeof sha === "string" && HEX64.test(sha))) {
      throw new LaneRequestError(400, "invalid_request");
    }
  }
  if (value.playhead !== undefined && !isFrame(value.playhead)) throw new LaneRequestError(400, "invalid_request");
  return { playhead: value.playhead ?? 0, known: value.known?.assSha256 ?? null };
}

const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);

function skipSpace(buffer, index) {
  while (index < buffer.length && WS.has(buffer[index])) index += 1;
  return index;
}

function skipString(buffer, index) { // index at the opening quote; returns past the closing one
  for (index += 1; index < buffer.length; index += 1) {
    if (buffer[index] === 0x5c) index += 1;
    else if (buffer[index] === 0x22) return index + 1;
  }
  throw new LaneRequestError(400, "invalid_request");
}

function skipValue(buffer, index) {
  if (buffer[index] === 0x22) return skipString(buffer, index);
  if (buffer[index] === 0x7b || buffer[index] === 0x5b) {
    let depth = 0;
    for (; index < buffer.length; index += 1) {
      const byte = buffer[index];
      if (byte === 0x22) index = skipString(buffer, index) - 1;
      else if (byte === 0x7b || byte === 0x5b) depth += 1;
      else if ((byte === 0x7d || byte === 0x5d) && --depth === 0) return index + 1;
    }
    throw new LaneRequestError(400, "invalid_request");
  }
  while (index < buffer.length && !WS.has(buffer[index]) && ![0x2c, 0x7d, 0x5d].includes(buffer[index])) index += 1;
  return index;
}

/**
 * The exact bytes of the top-level `doc` member of a request body (already known to be a JSON
 * object): Python validates these bytes as received, and the lane keys its caches on them.
 */
export function docBytes(buffer) {
  let index = skipSpace(buffer, 0);
  if (buffer[index] !== 0x7b) throw new LaneRequestError(400, "invalid_request");
  index = skipSpace(buffer, index + 1);
  let found = null;
  while (index < buffer.length && buffer[index] !== 0x7d) {
    if (buffer[index] !== 0x22) throw new LaneRequestError(400, "invalid_request");
    const keyEnd = skipString(buffer, index);
    const key = JSON.parse(buffer.subarray(index, keyEnd).toString("utf8"));
    index = skipSpace(buffer, keyEnd);
    if (buffer[index] !== 0x3a) throw new LaneRequestError(400, "invalid_request");
    const start = skipSpace(buffer, index + 1);
    const end = skipValue(buffer, start);
    if (key === "doc") {
      if (found) throw new LaneRequestError(400, "invalid_request"); // a doubled member
      found = buffer.subarray(start, end);
    }
    index = skipSpace(buffer, end);
    if (buffer[index] === 0x2c) index = skipSpace(buffer, index + 1);
  }
  if (!found) throw new LaneRequestError(400, "invalid_request");
  return found;
}

/** `{doc, f}` (plan §4.2 `preview/frame`). */
export function parseFrameBody(buffer) {
  const value = parseJsonObject(buffer, MAX_DOC_REQUEST_BYTES);
  onlyKeys(value, ["doc", "f"]);
  if (!isObject(value.doc) || !isFrame(value.f)) throw new LaneRequestError(400, "invalid_request");
  return { f: value.f };
}

/** `{layout?}` ≤ 1 KiB, or an empty body (plan §4.2 `prepare`). */
export function parsePrepareBody(buffer) {
  if (Buffer.isBuffer(buffer) && buffer.length === 0) return { layout: null };
  const value = parseJsonObject(buffer, MAX_PREPARE_BYTES);
  onlyKeys(value, ["layout"]);
  if (value.layout !== undefined && value.layout !== null && !LAYOUTS.includes(value.layout)) {
    throw new LaneRequestError(400, "invalid_request");
  }
  return { layout: value.layout ?? null };
}

/**
 * The cells (given in output order, each once) in the order to build them: the cell shown at
 * the playhead first, then the following ones in playback order, then those before it.
 */
export function cellOrder(cells, pieces, cellFrames, playhead) {
  if (!Array.isArray(cells) || cells.length === 0) return [];
  let start = 0;
  if (Array.isArray(pieces) && pieces.length && Number.isSafeInteger(cellFrames) && cellFrames > 0) {
    const last = pieces.at(-1);
    const total = last.outF0 + last.frames;
    const n = Math.min(Math.max(Number.isSafeInteger(playhead) ? playhead : 0, 0), Math.max(total - 1, 0));
    const piece = pieces.find((p) => n >= p.outF0 && n < p.outF0 + p.frames) ?? last;
    const k = Math.floor((piece.inSf + (n - piece.outF0)) / cellFrames);
    start = Math.max(cells.indexOf(k), 0);
  }
  return [...cells.slice(start), ...cells.slice(0, start)];
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function cellName(key, k) {
  return `${key.slice(0, 16)}-c${String(k).padStart(7, "0")}.mp4`;
}

async function isFile(file) {
  try {
    return (await lstat(file)).isFile();
  } catch {
    return false;
  }
}

function errorJson(json) {
  const error = isObject(json?.error) ? json.error : null;
  if (!error || typeof error.code !== "string") return { error: { code: "backend_unavailable", messageId: "edit.backend_unavailable" } };
  const clean = {};
  for (const key of ["code", "path", "ref", "messageId"]) if (key in error) clean[key] = error[key];
  const result = { error: clean };
  if (Array.isArray(json.errors)) {
    result.errors = json.errors.filter(isObject).map((issue) => {
      const item = {};
      for (const key of ["code", "path", "ref", "f"]) if (key in issue) item[key] = issue[key];
      return item;
    });
  }
  return result;
}

const unavailable = () => ({ status: 503, json: { error: { code: "backend_unavailable", messageId: "edit.backend_unavailable" } } });
const superseded = () => ({ status: 409, json: { error: { code: "superseded", messageId: "edit.superseded" } } });

function cliFailure(error) {
  if (error instanceof PythonCliError && error.code === "aborted") return superseded();
  return unavailable();
}

function heavyTimeout(op, cells = 0) {
  switch (op) {
    case "cells": return 60_000 + 20_000 * cells;
    case "audio": return 900_000;
    case "frame": return 90_000;
    case "derive": return 60_000;
    default: return 600_000; // prepare (the camera plan of a long window)
  }
}

/**
 * The lane. `runCli` is `runPythonCli`'s signature (tests pass a stand-in); `jobsRoot` defaults
 * to JOBS_ROOT at the time of each call.
 */
export function createPreviewLane({
  jobsRoot = null,
  runCli = runPythonCli,
  heavySlots = HEAVY_SLOTS,
  planSlots = PLAN_SLOTS,
  maxBatch = MAX_BATCH_CELLS,
  cacheCapBytes = null,
  protectMs = 30_000,
  now = Date.now,
  token = () => randomBytes(16).toString("hex"),
  env = process.env,
} = {}) {
  const clips = new Map();
  const queue = []; // heavy non-cell tasks
  const running = new Set();
  const planWaiters = [];
  const idleWaiters = [];
  const accessed = new Map();
  const capTimers = new Map();
  let planRunning = 0;
  let sequence = 0;
  let closed = false;

  const root = () => jobsRoot ?? env.JOBS_ROOT ?? "";
  const capBytes = () => {
    if (Number.isSafeInteger(cacheCapBytes) && cacheCapBytes > 0) return cacheCapBytes;
    const configured = Number(env.POTONGIN_PREVIEW_CACHE_BYTES);
    return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_CACHE_CAP_BYTES;
  };
  const clipDir = (clip) => path.join(root(), clip.jobId, "analysis", "clips", clip.clipId);
  const url = (clip, kind, name) => `/api/jobs/${clip.jobId}/clips/${clip.clipId}/media/${kind}/${name}`;

  function clipState(jobId, clipId) {
    const key = `${jobId}/${clipId}`;
    let clip = clips.get(key);
    if (!clip) {
      clip = {
        key, jobId, clipId, lastActive: 0, cache: new Map(), inflight: null,
        plate: null, order: [], queued: new Set(), runningCells: new Map(), doneCells: new Map(), failedCells: new Map(),
        head: false, audio: null, audioDone: new Map(), audioFailed: new Map(), audioWarnings: new Map(),
        derive: new Map(), deriveDone: new Map(), deriveFailed: new Map(),
      };
      clips.set(key, clip);
      if (clips.size > MAX_CLIPS) {
        const idle = [...clips.values()].filter((c) => !c.inflight && !c.runningCells.size && !c.audio?.task && !c.queued.size)
          .sort((a, b) => a.lastActive - b.lastActive)[0];
        if (idle) clips.delete(idle.key);
      }
    }
    return clip;
  }

  const recent = (map, key, window) => {
    const at = map.get(key);
    return at !== undefined && now() - at < window;
  };
  // Per-key memories (done, failed, warnings) are bounded: one entry per edit otherwise.
  const remember = (map, key, value) => {
    map.delete(key);
    map.set(key, value);
    while (map.size > MEMORY_ENTRIES) map.delete(map.keys().next().value);
  };

  // --- cancellation markers ----------------------------------------------------------------------

  function writeMarker(task) {
    const directory = path.join(clipDir(task.clip), "preview", ".cancel");
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      closeSync(openSync(path.join(directory, task.cancelToken), "w", 0o600));
      task.marker = path.join(directory, task.cancelToken);
    } catch { /* the fallback kill below still stops the work */ }
  }

  function removeMarker(task) {
    if (!task.marker) return;
    try { unlinkSync(task.marker); } catch { /* already gone */ }
    task.marker = null;
  }

  function cancel(task) {
    if (task.cancelled) return;
    task.cancelled = true;
    const index = queue.indexOf(task);
    if (index >= 0) {
      queue.splice(index, 1);
      task.settle?.(null, new PythonCliError("aborted"));
      return;
    }
    if (!running.has(task)) return;
    if (task.cancelToken) writeMarker(task);
    task.fallback = setTimeout(() => task.controller.abort(), task.cancelToken ? CANCEL_GRACE_MS : 0);
    task.fallback.unref?.();
  }

  // --- heavy queue -------------------------------------------------------------------------------

  function makeTask(kind, clip, payload, extra = {}) {
    const cancelToken = kind === "prepare" ? null : token();
    return {
      id: ++sequence, kind, priority: PRIORITY[kind], clip, op: kind,
      payload: { jobId: clip.jobId, clipId: clip.clipId, ...payload, ...(cancelToken ? { cancelToken } : {}) },
      cancelToken, ...extra,
    };
  }

  function enqueue(task, { now: dispatch = true } = {}) {
    queue.push(task);
    if (dispatch) pump();
  }

  // A waiting frame, mix, logo or prepare takes a slot from the newest cell job when every slot
  // is busy (the cells go back to the queue: plan §6.2 wants frames and audio first).
  function preempt() {
    const freeing = [...running].filter((t) => t.kind === "cells" && t.cancelled).length;
    let needed = queue.length - freeing;
    while (needed > 0) {
      const cells = [...running].filter((t) => t.kind === "cells" && !t.cancelled);
      if (!cells.length) break;
      cancel(cells.reduce((newest, t) => (t.started > newest.started ? t : newest)));
      needed -= 1;
    }
  }

  function nextCellBatch() {
    const candidates = [...clips.values()].filter((clip) => clip.queued.size && clip.plate)
      .sort((a, b) => b.lastActive - a.lastActive);
    for (const clip of candidates) {
      const index = clip.order.findIndex((k) => clip.queued.has(k));
      if (index < 0) continue;
      const cells = [clip.order[index]];
      if (!clip.head) {
        for (let i = index + 1; i < clip.order.length && cells.length < maxBatch; i += 1) {
          const k = clip.order[i];
          if (k !== cells.at(-1) + 1 || !clip.queued.has(k)) break;
          cells.push(k);
        }
      }
      clip.head = false;
      for (const k of cells) clip.queued.delete(k);
      const task = makeTask("cells", clip, { layout: clip.plate.layout, cells }, { plateKey: clip.plate.key, cells });
      for (const k of cells) clip.runningCells.set(k, task);
      return task;
    }
    return null;
  }

  function nextTask() {
    let best = -1;
    for (let i = 0; i < queue.length; i += 1) {
      if (best < 0 || queue[i].priority < queue[best].priority) best = i;
    }
    if (best >= 0) return queue.splice(best, 1)[0];
    return nextCellBatch();
  }

  function pump() {
    if (closed) return;
    while (running.size < heavySlots) {
      const task = nextTask();
      if (!task) break;
      start(task);
    }
    if (queue.length && heavySlots > 0) preempt();
    if (!running.size && !queue.length && ![...clips.values()].some((c) => c.queued.size)) {
      for (const resolve of idleWaiters.splice(0)) resolve();
    }
  }

  function start(task) {
    running.add(task);
    task.started = ++sequence;
    task.controller = new AbortController();
    const cells = task.kind === "cells" ? task.cells.length : 0;
    Promise.resolve()
      .then(() => runCli(PREVIEW_MODULE, task.op, task.payload, { timeoutMs: heavyTimeout(task.op, cells), signal: task.controller.signal }))
      .then((result) => finish(task, result, null), (error) => finish(task, null, error));
  }

  function finish(task, result, error) {
    running.delete(task);
    clearTimeout(task.fallback);
    removeMarker(task);
    const ok = !error && result?.exitCode === 0;
    const wasCancelled = task.cancelled || result?.exitCode === 12 || (error instanceof PythonCliError && error.code === "aborted");
    const clip = task.clip;
    if (task.kind === "cells") {
      for (const k of task.cells) {
        if (clip.runningCells.get(k) === task) clip.runningCells.delete(k);
        if (task.plateKey !== clip.plate?.key) continue;
        if (ok) remember(clip.doneCells, k, now());
        else if (wasCancelled) clip.queued.add(k); // preempted: back in the queue, same order
        else remember(clip.failedCells, k, now());
      }
    } else if (task.kind === "audio") {
      if (clip.audio?.task === task) clip.audio = { key: task.key, task: null };
      if (ok) {
        remember(clip.audioDone, task.key, now());
        if (Array.isArray(result.json?.warnings)) remember(clip.audioWarnings, task.key, result.json.warnings.filter(isObject));
      } else if (!wasCancelled) {
        remember(clip.audioFailed, task.key, now());
      }
    } else if (task.kind === "derive") {
      if (clip.derive.get(task.key) === task) clip.derive.delete(task.key);
      if (ok) remember(clip.deriveDone, task.key, now());
      else if (!wasCancelled) remember(clip.deriveFailed, task.key, now());
    }
    task.settle?.(result, error);
    scheduleCap(clip.jobId);
    pump();
  }

  function awaitTask(task) {
    return new Promise((resolve) => {
      task.settle = (result, error) => resolve({ result, error });
      enqueue(task);
    });
  }

  // --- what a plan asks for ----------------------------------------------------------------------

  function switchPlate(clip, key, layout) {
    for (const task of running) {
      if (task.kind === "cells" && task.clip === clip && task.plateKey !== key) cancel(task);
    }
    clip.plate = { key, layout };
    clip.order = [];
    clip.queued = new Set();
    clip.doneCells = new Map();
    clip.failedCells = new Map();
  }

  function ensure(clip, lane, pieces, missingCells, audioReady, logoReady, body) {
    if (!clip.plate || clip.plate.key !== lane.plateKey) switchPlate(clip, lane.plateKey, lane.layout);
    const missing = new Set(missingCells);
    const order = cellOrder(lane.cells, pieces, lane.cellFrames, lane.playhead).filter((k) => missing.has(k));
    const wanted = order.filter((k) => !clip.runningCells.has(k)
      && !recent(clip.failedCells, k, RETRY_BACKOFF_MS) && !recent(clip.doneCells, k, DONE_MEMORY_MS));
    clip.order = order;
    clip.queued = new Set(wanted);
    // the playhead's own cell goes first and alone, but only while it is still missing
    const playheadCell = cellOrder(lane.cells, pieces, lane.cellFrames, lane.playhead)[0];
    clip.head = wanted.length > 0 && wanted[0] === playheadCell;
    if (!audioReady && lane.audio?.key && body) ensureAudio(clip, lane.audio.key, body);
    if (lane.logo && !logoReady) ensureDerive(clip, lane.logo);
    pump();
  }

  function ensureAudio(clip, key, body) {
    if (clip.audio?.key === key && clip.audio.task) return;
    if (recent(clip.audioDone, key, DONE_MEMORY_MS) || recent(clip.audioFailed, key, RETRY_BACKOFF_MS)) return;
    if (clip.audio?.task) cancel(clip.audio.task);
    const task = makeTask("audio", clip, { requestRaw: body.toString("base64") }, { key });
    clip.audio = { key, task };
    enqueue(task, { now: false });
  }

  function ensureDerive(clip, logo) {
    const key = logo.name;
    if (clip.derive.has(key) || recent(clip.deriveDone, key, DONE_MEMORY_MS) || recent(clip.deriveFailed, key, RETRY_BACKOFF_MS)) return;
    const task = makeTask("derive", clip, { asset: logo.asset, w: logo.w, h: logo.h, opacityPm: logo.opacityPm }, { key });
    clip.derive.set(key, task);
    enqueue(task, { now: false });
  }

  // --- plan --------------------------------------------------------------------------------------

  async function acquirePlanSlot(signal) {
    if (planRunning < planSlots) {
      planRunning += 1;
      return;
    }
    await new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      planWaiters.push(waiter);
      signal.addEventListener("abort", () => {
        const index = planWaiters.indexOf(waiter);
        if (index >= 0) planWaiters.splice(index, 1);
        reject(new PythonCliError("aborted"));
      }, { once: true });
    });
    planRunning += 1;
  }

  function releasePlanSlot() {
    planRunning -= 1;
    planWaiters.shift()?.resolve();
  }

  function validPlanResult(json) {
    const lane = json?.lane;
    return isObject(json?.dto) && isObject(lane) && typeof lane.plateKey === "string" && HEX64.test(lane.plateKey)
      && typeof lane.layout === "string" && LAYOUTS.includes(lane.layout)
      && Array.isArray(lane.cells) && lane.cells.every(Number.isSafeInteger)
      && Array.isArray(lane.missing) && Number.isSafeInteger(lane.cellFrames) && Number.isSafeInteger(lane.playhead)
      && isObject(json.dto.plate) && Array.isArray(json.dto.plate.cells);
  }

  function runPlan(clip, sha, body) {
    const controller = new AbortController();
    const promise = (async () => {
      try {
        await acquirePlanSlot(controller.signal);
      } catch (error) {
        return cliFailure(error);
      }
      let result;
      try {
        result = await runCli(PREVIEW_MODULE, "plan", { jobId: clip.jobId, clipId: clip.clipId, requestRaw: body.toString("base64") },
          { timeoutMs: PLAN_TIMEOUT_MS, signal: controller.signal });
      } catch (error) {
        return cliFailure(error);
      } finally {
        releasePlanSlot();
      }
      if (result.exitCode !== 0) return { status: httpStatusForExit(result.exitCode), json: errorJson(result.json) };
      if (!validPlanResult(result.json)) return unavailable();
      const entry = { dto: result.json.dto, lane: result.json.lane, body, at: now() };
      clip.cache.delete(sha);
      clip.cache.set(sha, entry);
      while (clip.cache.size > DTO_CACHE_PER_CLIP) clip.cache.delete(clip.cache.keys().next().value);
      scheduleCap(clip.jobId);
      return { entry };
    })().finally(() => {
      if (clip.inflight?.controller === controller) clip.inflight = null;
    });
    clip.inflight = { sha, controller, promise };
    return promise;
  }

  async function respond(clip, entry, { playhead = 0, known = null } = {}) {
    const dto = structuredClone(entry.dto);
    const lane = { ...entry.lane, playhead: Math.min(playhead, Math.max((dto.totalFrames ?? 1) - 1, 0)) };
    if (isObject(dto.text) && known && known === dto.text.assSha256) delete dto.text.ass;
    const directory = clipDir(clip);
    const missing = [];
    const states = await Promise.all(dto.plate.cells.map(async (cell) => {
      const name = cellName(lane.plateKey, cell.k);
      if (await isFile(path.join(directory, "preview", "plates", name))) return { k: cell.k, state: "ready", url: url(clip, "plates", name) };
      missing.push(cell.k);
      const task = clip.runningCells.get(cell.k);
      return { k: cell.k, state: task && task.plateKey === lane.plateKey ? "building" : "queued" };
    }));
    dto.plate.cells = states;
    let audioReady = false;
    if (isObject(dto.audio) && typeof lane.audio?.key === "string") {
      const name = `${lane.audio.key.slice(0, 16)}.flac`;
      audioReady = await isFile(path.join(directory, "preview", "audio", name));
      const { url: _old, ...rest } = dto.audio;
      dto.audio = audioReady ? { ...rest, state: "ready", url: url(clip, "audio", name) }
        : { ...rest, state: clip.audio?.key === lane.audio.key && clip.audio.task && running.has(clip.audio.task) ? "building" : "queued" };
      const measured = clip.audioWarnings.get(lane.audio.key);
      if (measured && Array.isArray(dto.warnings)) {
        const seen = new Set(dto.warnings.map((w) => `${w.code}\0${w.path}\0${w.ref ?? ""}`));
        for (const warning of measured) {
          const marker = `${warning.code}\0${warning.path}\0${warning.ref ?? ""}`;
          if (!seen.has(marker)) { seen.add(marker); dto.warnings.push(warning); }
        }
      }
    }
    let logoReady = false;
    if (lane.logo && isObject(dto.logo)) {
      logoReady = await isFile(path.join(directory, "preview", "derived", lane.logo.name));
      const { url: _old, ...rest } = dto.logo;
      const task = clip.derive.get(lane.logo.name);
      dto.logo = logoReady ? { ...rest, state: "ready", url: url(clip, "derived", lane.logo.name) }
        : { ...rest, state: task && running.has(task) ? "building" : "queued" };
    }
    ensure(clip, lane, dto.pieces, missing, audioReady, logoReady, entry.body);
    return { status: 200, json: dto };
  }

  async function plan({ jobId, clipId, body }) {
    let request;
    let doc;
    try {
      request = parsePlanBody(body);
      doc = docBytes(body);
    } catch (error) {
      return { status: error.status ?? 400, json: { error: { code: "invalid_request", messageId: "edit.invalid_request" } } };
    }
    const clip = clipState(jobId, clipId);
    clip.lastActive = now();
    // Keyed on the document's bytes: a poll that only updates `known` or `playhead` is answered
    // from the cache; Python always gets `{"doc": …}` alone and returns the ASS.
    const sha = sha256(doc);
    const cached = clip.cache.get(sha);
    if (cached && now() - cached.at < DTO_TTL_MS && clip.inflight?.sha !== sha) {
      if (clip.inflight) clip.inflight.controller.abort();
      return respond(clip, cached, request);
    }
    let pending;
    if (clip.inflight?.sha === sha) {
      pending = clip.inflight.promise;
    } else {
      clip.inflight?.controller.abort(); // a newer document supersedes the one being planned
      pending = runPlan(clip, sha, Buffer.concat([Buffer.from('{"doc":'), doc, Buffer.from("}")]));
    }
    const outcome = await pending;
    if (!outcome.entry) return outcome;
    return respond(clip, outcome.entry, request);
  }

  // --- prepare and frame -------------------------------------------------------------------------

  async function prepare({ jobId, clipId, layout = null }) {
    const clip = clipState(jobId, clipId);
    clip.lastActive = now();
    const task = makeTask("prepare", clip, { layout });
    const { result, error } = await awaitTask(task);
    if (error) return cliFailure(error);
    if (result.exitCode !== 0) return { status: httpStatusForExit(result.exitCode), json: errorJson(result.json) };
    const json = result.json;
    if (!(typeof json?.plateKey === "string" && HEX64.test(json.plateKey) && LAYOUTS.includes(json.layout)
      && Array.isArray(json.cells) && Array.isArray(json.ready) && Number.isSafeInteger(json.cellFrames))) return unavailable();
    const ready = new Set(json.ready);
    const missing = json.cells.filter((k) => !ready.has(k));
    ensure(clip, { plateKey: json.plateKey, layout: json.layout, cells: json.cells, cellFrames: json.cellFrames, playhead: 0 },
      null, missing, true, true, null);
    return {
      status: 202,
      json: { words: json.words, camera: json.camera,
        plate: { state: missing.length ? "building" : "ready", ready: json.cells.length - missing.length, total: json.cells.length } },
    };
  }

  async function frame({ jobId, clipId, body }) {
    try { parseFrameBody(body); } catch (error) {
      return { status: error.status ?? 400, json: { error: { code: "invalid_request", messageId: "edit.invalid_request" } } };
    }
    const clip = clipState(jobId, clipId);
    clip.lastActive = now();
    const task = makeTask("frame", clip, { requestRaw: body.toString("base64") });
    const { result, error } = await awaitTask(task);
    if (error) return cliFailure(error);
    if (result.exitCode !== 0) return { status: httpStatusForExit(result.exitCode), json: errorJson(result.json) };
    const name = result.json?.name;
    if (typeof name !== "string" || !FRAME_FILE.pattern.test(name)) return unavailable();
    return { status: 200, name, path: path.join(clipDir(clip), "preview", "frames", name) };
  }

  // --- caches ------------------------------------------------------------------------------------

  function touch(file) {
    if (typeof file !== "string") return;
    accessed.delete(file);
    accessed.set(file, now());
    while (accessed.size > MAX_ACCESS_ENTRIES) accessed.delete(accessed.keys().next().value);
  }

  async function enforceCacheCap(jobId) {
    if (!JOB_ID.test(jobId || "")) return { totalBytes: 0, evicted: 0 };
    const clipsDir = path.join(root(), jobId, "analysis", "clips");
    let clipNames = [];
    try { clipNames = (await readdir(clipsDir, { withFileTypes: true })).filter((e) => e.isDirectory() && CLIP_ID.test(e.name)).map((e) => e.name); } catch { /* no clips */ }
    const files = [];
    const at = now();
    for (const clipName of clipNames) {
      for (const kind of CACHE_DIRS) {
        const directory = path.join(clipsDir, clipName, "preview", kind);
        let entries = [];
        try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const file = path.join(directory, entry.name);
          let info;
          try { info = await stat(file); } catch { continue; }
          if (entry.name.startsWith(".")) {
            if (entry.name.endsWith(".tmp") && at - info.mtimeMs > STALE_TEMP_MS) await unlink(file).catch(() => {});
            continue;
          }
          files.push({ file, size: info.size, used: Math.max(info.mtimeMs, accessed.get(file) ?? 0) });
        }
      }
    }
    let totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    let evicted = 0;
    const cap = capBytes();
    if (totalBytes > cap) {
      files.sort((a, b) => a.used - b.used);
      for (const entry of files) {
        if (totalBytes <= cap) break;
        if (at - entry.used < protectMs) continue;
        try {
          await unlink(entry.file);
          totalBytes -= entry.size;
          evicted += 1;
          accessed.delete(entry.file);
        } catch { /* gone already */ }
      }
    }
    return { totalBytes, evicted };
  }

  function scheduleCap(jobId) {
    if (closed || capTimers.has(jobId)) return;
    const timer = setTimeout(() => {
      capTimers.delete(jobId);
      enforceCacheCap(jobId).catch(() => {});
    }, CAP_INTERVAL_MS);
    timer.unref?.();
    capTimers.set(jobId, timer);
  }

  return {
    plan,
    prepare,
    frame,
    touch,
    jobsRoot: root,
    enforceCacheCap,
    idle() {
      if (!running.size && !queue.length && ![...clips.values()].some((c) => c.queued.size)) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
    stats() {
      return { running: [...running].map((t) => ({ op: t.op, clip: t.clip.key, cells: t.cells ?? null })), queued: queue.length };
    },
    close() {
      closed = true;
      for (const timer of capTimers.values()) clearTimeout(timer);
      capTimers.clear();
      for (const task of queue.splice(0)) task.settle?.(null, new PythonCliError("aborted"));
      for (const task of running) { clearTimeout(task.fallback); task.controller.abort(); }
      for (const clip of clips.values()) clip.inflight?.controller.abort();
      for (const resolve of idleWaiters.splice(0)) resolve();
    },
  };
}

// --- process-wide singletons (one app container: per-process state is the whole picture) --------

const LANE = Symbol.for("potongin.previewLane");
const LIMITS = Symbol.for("potongin.editorRateLimits");

export function getPreviewLane() {
  globalThis[LANE] ??= createPreviewLane();
  return globalThis[LANE];
}

export function getEditorRateLimits() {
  globalThis[LIMITS] ??= createEditorRateLimits();
  return globalThis[LIMITS];
}

// --- routes ---------------------------------------------------------------------------------------

const JSON_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

function json(status, body, headers = {}) {
  return Response.json(body, { status, headers: { ...JSON_HEADERS, ...headers } });
}

const failure = (status, code, headers) => json(status, { error: { code, messageId: `edit.${code}` } }, headers);

function sessionToken(request) {
  for (const item of (request.headers.get("cookie") || "").split(";")) {
    const at = item.indexOf("=");
    if (at > 0 && item.slice(0, at).trim() === SESSION_COOKIE) return item.slice(at + 1).trim();
  }
  return "";
}

async function readBody(request, limit) {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new LaneRequestError(413, "invalid_request");
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new LaneRequestError(400, "invalid_request");
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new LaneRequestError(413, "invalid_request");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function isJson(request) {
  return /^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "");
}

// Flag, session, ids and origin (plan §4.2, §9.1): common to the three mutations.
function gate(request, params, env) {
  if (!editorV3Enabled(env)) return failure(404, "not_found");
  const denied = requireAuth(request);
  if (denied) return denied;
  if (!JOB_ID.test(params?.id || "") || !CLIP_ID.test(params?.clipId || "")) return failure(400, "invalid_request");
  if (!sameOriginMutation(request)) return failure(403, "csrf_rejected");
  return null;
}

function limited(limits, kind, request) {
  const verdict = limits.check(kind, { sessionToken: sessionToken(request) || "anonymous" });
  if (verdict.allowed) return null;
  return failure(429, "rate_limited", { "Retry-After": String(Math.max(1, Math.ceil(verdict.retryAfterMs / 1000))) });
}

async function body(request, limit, { optional = false } = {}) {
  if (!isJson(request) && !(optional && !request.headers.get("content-type"))) throw new LaneRequestError(415, "invalid_request");
  return readBody(request, limit);
}

/** `POST /api/jobs/:id/clips/:clipId/preview/plan` → `200 PlanDTO` (plan §4.2, §4.3). */
export async function planResponse(request, params, { lane = getPreviewLane(), limits = getEditorRateLimits(), env = process.env } = {}) {
  const denied = gate(request, params, env) || limited(limits, "plan", request);
  if (denied) return denied;
  let raw;
  try {
    raw = await body(request, MAX_DOC_REQUEST_BYTES);
    parsePlanBody(raw);
  } catch (error) {
    return failure(error.status ?? 400, "invalid_request");
  }
  const result = await lane.plan({ jobId: params.id, clipId: params.clipId, body: raw });
  return json(result.status, result.json);
}

/** `POST /api/jobs/:id/clips/:clipId/preview/frame` → the truth frame PNG (plan §4.2). */
export async function frameResponse(request, params, { lane = getPreviewLane(), limits = getEditorRateLimits(), env = process.env } = {}) {
  const denied = gate(request, params, env) || limited(limits, "frame", request);
  if (denied) return denied;
  let raw;
  try {
    raw = await body(request, MAX_DOC_REQUEST_BYTES);
    parseFrameBody(raw);
  } catch (error) {
    return failure(error.status ?? 400, "invalid_request");
  }
  const result = await lane.frame({ jobId: params.id, clipId: params.clipId, body: raw });
  if (result.status !== 200) return json(result.status, result.json);
  let opened;
  try {
    opened = await openClipFile(lane.jobsRoot(), params.id, params.clipId, FRAME_FILE, result.name);
  } catch {
    return failure(503, "backend_unavailable");
  }
  return openedFileResponse(request, opened, { type: "image/png", cacheControl: "private, no-store" });
}

/** `POST /api/jobs/:id/clips/:clipId/prepare` → `202 {words, camera, plate}` (plan §4.2). */
export async function prepareResponse(request, params, { lane = getPreviewLane(), env = process.env } = {}) {
  const denied = gate(request, params, env);
  if (denied) return denied;
  let layout;
  try {
    ({ layout } = parsePrepareBody(await body(request, MAX_PREPARE_BYTES, { optional: true })));
  } catch (error) {
    return failure(error.status ?? 400, "invalid_request");
  }
  const result = await lane.prepare({ jobId: params.id, clipId: params.clipId, layout });
  return json(result.status, result.json);
}
