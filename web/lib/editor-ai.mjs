// Hook suggestions for the clip editor (plan §7, §7.1, §4.2, K13; T3.4).
//
//   POST /api/jobs/:id/clips/:clipId/ai            body exactly {task: "hooks", doc}
//        → 202 {taskId | null, heuristic: [variant], llm: {state, retryAfterMs?, message?}}
//   GET  /api/jobs/:id/clips/:clipId/ai/:taskId     → {state, suggestions, error}
//
// The instant variants come from `python -m ai_clipper.editor_ai heuristic` with the allowlisted
// child environment. The LLM part runs only when POTONGIN_EDITOR_LLM=on, POTONGIN_LLM is not off
// and the saved Pengaturan settings (or, without a settings file, the environment) name a
// provider: `run-task` is then spawned with `engineProcessEnv(await loadLlmEnv())`, the only
// child that receives LLM variables (E11). Python stops the request at 20 s; this process kills
// the child's group at 25 s and reports `failed/timeout` when no task file was written. At most
// 30 tasks per job per hour and 3 at once. No request field can name a provider, model or URL.
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import { requireAuth } from "./auth.mjs";
import {
  BodyTooLargeError,
  apiFailure,
  callCli,
  editorDeps,
  editorResponse,
  isClipId,
  isJobId,
  isJsonRequest,
  readBoundedBody,
} from "./clip-edit.mjs";
import { readEditorFlags } from "./editor/flags.mjs";
import { loadLlmEnv } from "./llm-settings.mjs";
import { EDITOR_RATE_LIMITS, TokenBucketLimiter } from "./rate-limit.mjs";
import { sameOriginMutation } from "./request-security.mjs";

export const AI_MODULE = "ai_clipper.editor_ai";
export const MAX_AI_BODY_BYTES = (1 << 20) + 4096;
export const HEURISTIC_TIMEOUT_MS = 15_000;
export const KILL_AFTER_MS = 25_000;
export const MAX_RUNNING_TASKS = 3;
export const MAX_TASK_FILE_BYTES = 512 * 1024;
const TASK_MEMORY_MS = 15 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ITEM_ID = /^[a-z]{2,3}_[0-9a-z]{1,16}$/;
const LINE_ID = /^L[0-9]{4,6}$/;
const UNIT_ID = /^S[0-9]{4,}$/;
const SOURCES = new Set(["ai_selection", "heuristic", "llm"]);
const KINDS = new Set(["v3_hook", "v3_title", "hook_unit", "question", "strongest", "llm"]);
export const STYLES = Object.freeze(["pertanyaan", "klaim", "penasaran", "angka", "kutipan", "lucu"]);
export const TASK_ERROR_CODES = Object.freeze(["timeout", "llm_unavailable", "llm_disabled", "invalid_output", "internal_error"]);
const OFF = new Set(["off", "0", "false", "no", "disabled", "disable", "none"]);

export const MESSAGES = Object.freeze({
  invalid_request: "Permintaan tidak valid",
  csrf_rejected: "Origin permintaan tidak diizinkan",
  editor_disabled: "Editor belum diaktifkan",
  not_found: "Data tidak ditemukan",
  payload_too_large: "Permintaan terlalu besar",
  rate_limited: "Terlalu banyak permintaan; tunggu sebentar lalu coba lagi",
  backend_unavailable: "Layanan editor tidak tersedia",
});
// The pipeline's wording for an unreadable settings file (web/scripts/run-job.mjs), for the editor.
export const SETTINGS_PROBLEM_MESSAGE = "Pengaturan AI tidak bisa dibaca; saran AI dimatikan dan saran otomatis dipakai.";

function failure(code, status, headers = {}) {
  return editorResponse({ error: MESSAGES[code] ?? MESSAGES.invalid_request, code }, status, headers);
}

const isTaskId = (value) => typeof value === "string" && UUID.test(value);
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** `{task: "hooks", doc: {…}}` and nothing else (a provider, model or URL field is refused). */
export function parseAiBody(raw) {
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    return null;
  }
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("task") || !keys.includes("doc")) return null;
  if (value.task !== "hooks" || !isPlainObject(value.doc)) return null;
  return value;
}

function cleanText(value, max) {
  if (typeof value !== "string") return null;
  const text = value.normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  return text && [...text].length <= max ? text : null;
}

/** One suggestion reduced to the DTO fields; null when anything is off. */
export function sanitizeSuggestion(item, { llm }) {
  if (!isPlainObject(item) || typeof item.id !== "string" || !ITEM_ID.test(item.id)) return null;
  const text = cleanText(item.text, 90);
  if (!text || !SOURCES.has(item.source) || (item.source === "llm") !== llm || typeof item.fits !== "boolean") return null;
  const evidence = Array.isArray(item.evidence) ? item.evidence.filter((ref) => typeof ref === "string" && LINE_ID.test(ref)).slice(0, 8) : [];
  const out = {
    id: item.id, text, source: item.source, kind: KINDS.has(item.kind) ? item.kind : (llm ? "llm" : "heuristic"),
    fits: item.fits, style: STYLES.includes(item.style) ? item.style : null, evidence,
    basis: cleanText(item.basis, 141),
  };
  if (typeof item.unit === "string" && UNIT_ID.test(item.unit)) out.unit = item.unit;
  return out;
}

function sanitizeList(list, options, limit) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list.slice(0, limit)) {
    const clean = sanitizeSuggestion(item, options);
    if (clean && !out.some((other) => other.id === clean.id)) out.push(clean);
  }
  return out;
}

function taskError(code) {
  const known = TASK_ERROR_CODES.includes(code) ? code : "internal_error";
  return { code: known, messageId: `editor_ai.${known}` };
}

/** The GET answer from a task file (`potongin.editor-ai-task/1`), or null when it is not one. */
export function taskView(record, { taskId, clipId }) {
  if (!isPlainObject(record) || record.schema !== "potongin.editor-ai-task/1" || record.taskId !== taskId
    || record.clipId !== clipId || !["done", "failed"].includes(record.state)) return null;
  if (record.state === "failed") {
    return { state: "failed", suggestions: [], error: taskError(record.error?.code) };
  }
  return { state: "done", suggestions: sanitizeList(record.suggestions, { llm: true }, 6), error: null };
}

class TaskFileMissing extends Error {}

async function realDirectory(target) {
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(target) !== target) throw new TaskFileMissing();
}

/** `analysis/clips/<clip>/suggestions/<task>.json`: no symlink on the way, a bounded regular file. */
export async function readTaskFile(jobsRoot, jobId, clipId, taskId) {
  if (!isJobId(jobId) || !isClipId(clipId) || !isTaskId(taskId)) throw new TaskFileMissing();
  let handle;
  try {
    const root = await realpath(path.resolve(/* turbopackIgnore: true */ jobsRoot));
    const job = path.join(root, jobId);
    const folders = [job, path.join(job, "analysis"), path.join(job, "analysis", "clips"),
      path.join(job, "analysis", "clips", clipId), path.join(job, "analysis", "clips", clipId, "suggestions")];
    for (const folder of folders) await realDirectory(folder);
    handle = await open(path.join(/* turbopackIgnore: true */ folders.at(-1), `${taskId}.json`),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_TASK_FILE_BYTES) throw new TaskFileMissing();
    const raw = await handle.readFile();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new TaskFileMissing();
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Tasks this process started: running, or finished without a file (killed, crashed). */
export function createTaskRegistry({ now = Date.now, memoryMs = TASK_MEMORY_MS } = {}) {
  const tasks = new Map();
  const sweep = () => {
    for (const [id, task] of tasks) {
      if (task.state !== "running" && now() - task.at > memoryMs) tasks.delete(id);
    }
  };
  return {
    start(taskId, owner) {
      sweep();
      tasks.set(taskId, { ...owner, state: "running", at: now(), error: null });
    },
    finish(taskId, error = null) {
      const task = tasks.get(taskId);
      if (task) Object.assign(task, { state: error ? "failed" : "exited", at: now(), error });
    },
    get(taskId) {
      sweep();
      return tasks.get(taskId) ?? null;
    },
    running() {
      let count = 0;
      for (const task of tasks.values()) if (task.state === "running") count += 1;
      return count;
    },
  };
}

function llmOff(env) {
  return typeof env?.POTONGIN_LLM === "string" && OFF.has(env.POTONGIN_LLM.trim().toLowerCase());
}

function hasProvider(env) {
  const names = env?.POTONGIN_LLM_PROVIDERS ?? env?.POTONGIN_LLM_PROVIDER;
  return typeof names === "string" && names.split(",").some((name) => name.trim() !== "");
}

const TASKS = Symbol.for("potongin.editorAiTasks");
const LIMITER = Symbol.for("potongin.editorAiLimiter");

function sharedRegistry() {
  globalThis[TASKS] ??= createTaskRegistry();
  return globalThis[TASKS];
}

function sharedLimiter() {
  const limit = EDITOR_RATE_LIMITS.ai;
  globalThis[LIMITER] ??= new TokenBucketLimiter({ capacity: limit.capacity, refillPerSecond: limit.refillPerSecond });
  return globalThis[LIMITER];
}

function aiDeps(options) {
  const deps = editorDeps(options);
  return {
    ...deps,
    authorize: options.authorize ?? requireAuth,
    loadLlmEnv: options.loadLlmEnv ?? loadLlmEnv,
    registry: options.registry ?? sharedRegistry(),
    limiter: options.limiter ?? sharedLimiter(),
    newTaskId: options.newTaskId ?? (() => randomUUID()),
    killAfterMs: options.killAfterMs ?? KILL_AFTER_MS,
    maxRunning: options.maxRunning ?? MAX_RUNNING_TASKS,
  };
}

async function prologue(request, params, deps, { mutation, task = false }) {
  const denied = deps.authorize(request);
  if (denied) return { denied };
  if (!readEditorFlags(deps.env).editorV3) return { denied: failure("editor_disabled", 404) };
  if (mutation && !sameOriginMutation(request)) return { denied: failure("csrf_rejected", 403) };
  const resolved = await params;
  if (!isJobId(resolved?.id) || !isClipId(resolved?.clipId) || (task && !isTaskId(resolved?.taskId))) {
    return { denied: failure("invalid_request", 400) };
  }
  return { params: resolved };
}

/** Whether (and how) the LLM part runs for this request: `{state, loaded?, retryAfterMs?, message?}`. */
async function llmPlan(deps, jobId) {
  if (!readEditorFlags(deps.env).llm) return { state: "disabled" };
  let loaded;
  try {
    loaded = await deps.loadLlmEnv(deps.env);
  } catch {
    return { state: "disabled", message: SETTINGS_PROBLEM_MESSAGE };
  }
  if (loaded?.problem) return { state: "disabled", message: SETTINGS_PROBLEM_MESSAGE };
  if (!loaded?.env || llmOff(loaded.env) || !hasProvider(loaded.env)) return { state: "disabled" };
  if (deps.registry.running() >= deps.maxRunning) return { state: "rate_limited", retryAfterMs: 5000 };
  const verdict = deps.limiter.take(`job:${jobId}`);
  if (!verdict.allowed) return { state: "rate_limited", retryAfterMs: verdict.retryAfterMs };
  const env = { ...loaded.env };
  // K13's optional fast models are not a secret; the saved settings drop env LLM names, so pass it on.
  if (typeof deps.env.POTONGIN_LLM_EDITOR_MODELS === "string" && deps.env.POTONGIN_LLM_EDITOR_MODELS.trim()) {
    env.POTONGIN_LLM_EDITOR_MODELS = deps.env.POTONGIN_LLM_EDITOR_MODELS;
  }
  return { state: "pending", loaded: { ...loaded, env } };
}

function startTask(deps, { jobId, clipId, requestRaw, loaded }) {
  const taskId = deps.newTaskId();
  deps.registry.start(taskId, { jobId, clipId });
  deps.runCli(AI_MODULE, "run-task", { jobId, clipId, taskId, requestRaw }, {
    withLlmEnv: true, loadLlmEnvImpl: async () => loaded, timeoutMs: deps.killAfterMs, killGraceMs: 0,
    maxStdoutBytes: 512 * 1024,
  }).then((result) => {
    deps.registry.finish(taskId, result?.exitCode === 0 ? null : "internal_error");
  }, (error) => {
    deps.registry.finish(taskId, error?.code === "timeout" ? "timeout" : "internal_error");
  });
  return taskId;
}

export function createAiRoute(options = {}) {
  const deps = aiDeps(options);
  return {
    async POST(request, { params }) {
      const checked = await prologue(request, params, deps, { mutation: true });
      if (checked.denied) return checked.denied;
      if (!isJsonRequest(request)) return failure("invalid_request", 415);
      let raw;
      try { raw = await readBoundedBody(request, MAX_AI_BODY_BYTES); } catch (error) {
        return error instanceof BodyTooLargeError ? failure("payload_too_large", 413) : failure("invalid_request", 400);
      }
      if (!parseAiBody(raw)) return failure("invalid_request", 400);
      const { id: jobId, clipId } = checked.params;
      const requestRaw = Buffer.from(raw).toString("base64");
      const result = await callCli(deps, AI_MODULE, "heuristic", { jobId, clipId, requestRaw },
        { timeoutMs: HEURISTIC_TIMEOUT_MS, maxStdoutBytes: 256 * 1024 });
      if (result?.exitCode !== 0) return apiFailure(result);
      const heuristic = sanitizeList(result.json.heuristic, { llm: false }, 5);
      const plan = await llmPlan(deps, jobId);
      const llm = { state: plan.state };
      if (plan.retryAfterMs !== undefined) llm.retryAfterMs = Math.max(1000, plan.retryAfterMs);
      if (plan.message) llm.message = plan.message;
      const taskId = plan.state === "pending" ? startTask(deps, { jobId, clipId, requestRaw, loaded: plan.loaded }) : null;
      return editorResponse({ taskId, heuristic, llm }, 202);
    },
  };
}

export function createAiTaskRoute(options = {}) {
  const deps = aiDeps(options);
  return {
    async GET(request, { params }) {
      const checked = await prologue(request, params, deps, { mutation: false, task: true });
      if (checked.denied) return checked.denied;
      const { id: jobId, clipId, taskId } = checked.params;
      const task = deps.registry.get(taskId);
      if (task && (task.jobId !== jobId || task.clipId !== clipId)) return failure("not_found", 404);
      if (task?.state === "running") return editorResponse({ state: "pending", suggestions: [], error: null });
      let view = null;
      try {
        view = taskView(await readTaskFile(deps.jobsRoot, jobId, clipId, taskId), { taskId, clipId });
      } catch {
        view = null;
      }
      if (view) return editorResponse(view);
      if (task?.state === "failed" || task?.state === "exited") {
        return editorResponse({ state: "failed", suggestions: [], error: taskError(task.error ?? "internal_error") });
      }
      return failure("not_found", 404);
    },
  };
}
