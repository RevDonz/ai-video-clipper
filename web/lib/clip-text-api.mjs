// A clip's title and description on the project page (plan 2026-10-20 P2).
//
//   PATCH /api/jobs/:id/clip-text           {index, title, description} → 200 {clip}
//   POST  /api/jobs/:id/clip-text/rewrite   {index}                     → 200 {suggestion: {title, description}}
//
// Both run behind secureRoute (session, same origin, the job id, the "api" bucket); the handlers
// here check the rest. "Ubah" writes the edit into job.json under the queue lock, only for a
// completed job, as `clip.textEdit` beside the engine's packaging (jobs.mjs serves it in its
// place). "Tulis ulang" runs `python -m ai_clipper.post_text` with the LLM variables of the saved
// Pengaturan settings (the free chain; no request field can name a provider, model or URL), at
// most 30 per job per hour and 3 at once in this process. A suggestion is never saved: the page
// shows it and saves only what the owner keeps.
import { readFile } from "node:fs/promises";
import path from "node:path";

import { BodyTooLargeError, isJobId, isJsonRequest, readBoundedBody } from "./clip-edit.mjs";
import { CLIP_TEXT_LIMITS, sanitizeLine, sanitizeMultiline, serializePublicJob } from "./jobs.mjs";
import { loadLlmEnv } from "./llm-settings.mjs";
import { updateCompletedJob } from "./primary-job-queue.mjs";
import { runPythonCli } from "./python-cli.mjs";
import { EDITOR_RATE_LIMITS, TokenBucketLimiter, retryAfterSeconds } from "./rate-limit.mjs";

export const MAX_TEXT_BODY_BYTES = 32 * 1024;
export const MAX_REWRITE_BODY_BYTES = 256;
export const REWRITE_MODULE = "ai_clipper.post_text";
// Python stops the request at 20 s; the child's process group is killed at 25 s.
export const REWRITE_KILL_AFTER_MS = 25_000;
export const MAX_RUNNING_REWRITES = 3;
const MAX_REWRITE_STDOUT_BYTES = 64 * 1024;
const BUSY_RETRY_MS = 5000;
const MAX_INDEX = 9999;
const OFF = new Set(["off", "0", "false", "no", "disabled", "disable", "none"]);
const LLM_CODE = /^[a-z][a-z0-9_]{0,39}$/;
const TEXT_KEYS = Object.freeze(["description", "index", "title"]);

export const MESSAGES = Object.freeze({
  invalid_request: "Permintaan tidak valid.",
  unsupported_media_type: "Permintaan harus berupa JSON.",
  payload_too_large: "Teksnya terlalu panjang untuk dikirim.",
  title_empty: "Judul tidak boleh kosong.",
  title_too_long: `Judul paling banyak ${CLIP_TEXT_LIMITS.title} karakter.`,
  description_too_long: `Deskripsi paling banyak ${CLIP_TEXT_LIMITS.storedDescription.toLocaleString("id-ID")} karakter.`,
  not_found: "Proyek ini tidak ada atau sudah dihapus.",
  clip_not_found: "Klip ini tidak ada di proyek ini.",
  not_ready: "Judul dan deskripsi bisa diubah setelah proyek selesai.",
  save_failed: "Teks belum tersimpan. Coba lagi.",
  read_failed: "Proyek tidak bisa dibaca sekarang. Coba lagi sebentar lagi.",
  no_transcript: "Klip ini tidak punya transkrip, jadi AI tidak bisa menulis ulang teksnya.",
  llm_disabled: "AI mati atau belum diatur. Nyalakan di Pengaturan.",
  llm_settings: "Pengaturan AI tidak bisa dibaca. Buka Pengaturan, lalu simpan ulang.",
  llm_unavailable: "AI tidak bisa dipakai sekarang. Cek penyedia di Pengaturan, lalu coba lagi.",
  timeout: "AI terlalu lama menjawab. Coba lagi.",
  invalid_output: "Jawaban AI tidak bisa dipakai. Coba lagi.",
  busy: "Tulis ulang sedang berjalan untuk klip lain. Coba lagi sebentar lagi.",
  backend_unavailable: "Tulis ulang tidak tersedia sekarang. Coba lagi sebentar lagi.",
});

// The state of a failed rewrite → the answer's status. Anything else counts as llm_unavailable.
const FAILURE_STATUS = Object.freeze({ timeout: 504, invalid_output: 502, llm_unavailable: 502, llm_disabled: 409, no_transcript: 409 });

function answer(body, status = 200, headers = {}) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers },
  });
}

function failure(code, status, extra = {}, headers = {}) {
  return answer({ error: MESSAGES[code] ?? MESSAGES.invalid_request, code, ...extra }, status, headers);
}

function rateLimited(retryAfterMs, message) {
  return answer({ error: message, code: "rate_limited", retryAfterMs }, 429, { "Retry-After": retryAfterSeconds(retryAfterMs) });
}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isClipNumber = (value) => Number.isSafeInteger(value) && value >= 1 && value <= MAX_INDEX;
const codePoints = (text) => Array.from(text).length;

function parseJson(raw) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    return undefined;
  }
}

/**
 * `{index, title, description}` cleaned as the job serves text (one line; newlines kept with at
 * most one blank line), or `{code}`: invalid_request, title_empty, title_too_long or
 * description_too_long. Over-long text is refused, not cut: the form counts the same characters.
 */
export function parseClipTextBody(raw) {
  const value = parseJson(raw);
  if (!isPlainObject(value) || Object.keys(value).sort().join() !== TEXT_KEYS.join()) return { code: "invalid_request" };
  if (!isClipNumber(value.index) || typeof value.title !== "string" || typeof value.description !== "string") {
    return { code: "invalid_request" };
  }
  const title = sanitizeLine(value.title, Infinity);
  if (!title) return { code: "title_empty" };
  if (codePoints(title) > CLIP_TEXT_LIMITS.title) return { code: "title_too_long" };
  const description = sanitizeMultiline(value.description, Infinity) ?? "";
  if (codePoints(description) > CLIP_TEXT_LIMITS.storedDescription) return { code: "description_too_long" };
  return { index: value.index, title, description };
}

/** The clip number of a rewrite body (exactly `{index}`), or null. */
export function parseRewriteBody(raw) {
  const value = parseJson(raw);
  if (!isPlainObject(value) || Object.keys(value).join() !== "index" || !isClipNumber(value.index)) return null;
  return value.index;
}

function findClip(job, index) {
  return (Array.isArray(job?.clips) ? job.clips : []).find((clip) => isPlainObject(clip) && clip.index === index) ?? null;
}

function withTextEdit(job, { index, title, description }, editedAt) {
  const clip = findClip(job, index);
  if (!clip) return null;
  return { ...job, clips: job.clips.map((item) => (item === clip ? { ...clip, textEdit: { title, description, editedAt } } : item)) };
}

function llmOff(env) {
  return typeof env?.POTONGIN_LLM === "string" && OFF.has(env.POTONGIN_LLM.trim().toLowerCase());
}

function hasProvider(env) {
  const names = env?.POTONGIN_LLM_PROVIDERS ?? env?.POTONGIN_LLM_PROVIDER;
  return typeof names === "string" && names.split(",").some((name) => name.trim() !== "");
}

const LIMITER = Symbol.for("potongin.clipTextRewriteLimiter");
const RUNNING = Symbol.for("potongin.clipTextRewriteRunning");

function sharedLimiter() {
  const limit = EDITOR_RATE_LIMITS.ai;
  globalThis[LIMITER] ??= new TokenBucketLimiter({ capacity: limit.capacity, refillPerSecond: limit.refillPerSecond });
  return globalThis[LIMITER];
}

function sharedRunning() {
  globalThis[RUNNING] ??= { count: 0 };
  return globalThis[RUNNING];
}

function routeDeps(options) {
  const env = options.env ?? process.env;
  const runner = options.runCli ?? runPythonCli;
  return {
    env,
    // Read on each request, so the route files follow JOBS_ROOT as the other job routes do.
    jobsRoot: () => path.resolve(options.jobsRoot ?? (env.JOBS_ROOT || "/data/jobs")),
    runCli: (module, op, payload, extra = {}) => runner(module, op, payload, { env, ...extra }),
    loadLlmEnv: options.loadLlmEnv ?? loadLlmEnv,
    updateJob: options.updateJob ?? updateCompletedJob,
    limiter: options.limiter ?? sharedLimiter(),
    running: options.running ?? sharedRunning(),
    maxRunning: options.maxRunning ?? MAX_RUNNING_REWRITES,
    killAfterMs: options.killAfterMs ?? REWRITE_KILL_AFTER_MS,
    now: options.now ?? Date.now,
  };
}

async function readBody(request, maximum) {
  if (!isJsonRequest(request)) return { denied: failure("unsupported_media_type", 415) };
  try {
    return { raw: await readBoundedBody(request, maximum) };
  } catch (error) {
    return { denied: error instanceof BodyTooLargeError ? failure("payload_too_large", 413) : failure("invalid_request", 400) };
  }
}

// --- PATCH /api/jobs/:id/clip-text ----------------------------------------------------------------

export function createClipTextRoute(options = {}) {
  const deps = routeDeps(options);
  return {
    async PATCH(request, { params }) {
      const { id } = await params;
      if (!isJobId(id)) return failure("invalid_request", 400);
      const body = await readBody(request, MAX_TEXT_BODY_BYTES);
      if (body.denied) return body.denied;
      const edit = parseClipTextBody(body.raw);
      if (edit.code) return failure(edit.code, 400);
      let result;
      try {
        const editedAt = new Date(deps.now()).toISOString();
        result = await deps.updateJob({ jobsRoot: deps.jobsRoot(), id }, (job) => withTextEdit(job, edit, editedAt));
      } catch {
        return failure("save_failed", 500);
      }
      if (result.outcome === "not_found") return failure("not_found", 404);
      if (result.outcome === "not_completed") return failure("not_ready", 409);
      if (result.outcome !== "updated") return failure("clip_not_found", 404);
      const clip = findClip(serializePublicJob(result.job), edit.index);
      return clip ? answer({ clip }) : failure("save_failed", 500);
    },
  };
}

// --- POST /api/jobs/:id/clip-text/rewrite --------------------------------------------------------------

async function readJob(jobsRoot, id) {
  try {
    return { job: JSON.parse(await readFile(path.join(jobsRoot, id, "job.json"), "utf8")) };
  } catch (error) {
    return { denied: error?.code === "ENOENT" ? failure("not_found", 404) : failure("read_failed", 503) };
  }
}

/** The saved Pengaturan chain for this request: `{loaded}` or `{denied}` (AI off, no provider). */
async function llmPlan(deps) {
  if (llmOff(deps.env)) return { denied: failure("llm_disabled", 409) };
  let loaded;
  try {
    loaded = await deps.loadLlmEnv(deps.env);
  } catch {
    return { denied: failure("llm_settings", 409) };
  }
  if (loaded?.problem) return { denied: failure("llm_settings", 409) };
  if (!loaded?.env || llmOff(loaded.env) || !hasProvider(loaded.env)) return { denied: failure("llm_disabled", 409) };
  const env = { ...loaded.env };
  // The editor's optional fast models (not a secret); the saved settings drop env LLM names.
  if (typeof deps.env.POTONGIN_LLM_EDITOR_MODELS === "string" && deps.env.POTONGIN_LLM_EDITOR_MODELS.trim()) {
    env.POTONGIN_LLM_EDITOR_MODELS = deps.env.POTONGIN_LLM_EDITOR_MODELS;
  }
  return { loaded: { ...loaded, env } };
}

/** The HTTP answer for the CLI's result: the suggestion, re-cleaned, or the failure's code. */
export function rewriteAnswer(result) {
  if (!isPlainObject(result) || !Number.isInteger(result.exitCode) || !isPlainObject(result.json)) {
    return failure("backend_unavailable", 503);
  }
  if (result.exitCode === 4) return failure("clip_not_found", 404);
  if (result.exitCode !== 0) return failure("backend_unavailable", 503);
  const { state, suggestion, error } = result.json;
  if (state === "done") {
    const title = isPlainObject(suggestion) ? sanitizeLine(suggestion.title, Infinity) : null;
    const description = isPlainObject(suggestion) ? sanitizeMultiline(suggestion.description, Infinity) ?? "" : "";
    if (!title || codePoints(title) > CLIP_TEXT_LIMITS.title || codePoints(description) > CLIP_TEXT_LIMITS.storedDescription) {
      return failure("invalid_output", 502);
    }
    return answer({ suggestion: { title, description } });
  }
  if (state !== "failed") return failure("backend_unavailable", 503);
  const code = Object.hasOwn(FAILURE_STATUS, error?.code) ? error.code : "llm_unavailable";
  const llmCode = typeof error?.llmCode === "string" && LLM_CODE.test(error.llmCode) ? error.llmCode : null;
  return failure(code, FAILURE_STATUS[code], { llmCode });
}

export function createRewriteRoute(options = {}) {
  const deps = routeDeps(options);
  return {
    async POST(request, { params }) {
      const { id } = await params;
      if (!isJobId(id)) return failure("invalid_request", 400);
      const body = await readBody(request, MAX_REWRITE_BODY_BYTES);
      if (body.denied) return body.denied;
      const index = parseRewriteBody(body.raw);
      if (index === null) return failure("invalid_request", 400);
      const read = await readJob(deps.jobsRoot(), id);
      if (read.denied) return read.denied;
      if (read.job?.status !== "completed") return failure("not_ready", 409);
      const clip = findClip(read.job, index);
      if (!clip) return failure("clip_not_found", 404);
      if (!sanitizeLine(clip.text, CLIP_TEXT_LIMITS.text)) return failure("no_transcript", 409);
      const plan = await llmPlan(deps);
      if (plan.denied) return plan.denied;
      if (deps.running.count >= deps.maxRunning) return rateLimited(BUSY_RETRY_MS, MESSAGES.busy);
      const verdict = deps.limiter.take(`job:${id}`);
      if (!verdict.allowed) {
        const minutes = Math.max(1, Math.ceil(verdict.retryAfterMs / 60_000));
        return rateLimited(verdict.retryAfterMs,
          `Batas Tulis ulang untuk proyek ini tercapai (${EDITOR_RATE_LIMITS.ai.capacity} per jam). Coba lagi dalam ${minutes} menit.`);
      }
      deps.running.count += 1;
      let result;
      try {
        result = await deps.runCli(REWRITE_MODULE, "rewrite", { jobId: id, index }, {
          withLlmEnv: true, loadLlmEnvImpl: async () => plan.loaded, timeoutMs: deps.killAfterMs, killGraceMs: 0,
          maxStdoutBytes: MAX_REWRITE_STDOUT_BYTES,
        });
      } catch (error) {
        return error?.code === "timeout" ? failure("timeout", 504) : failure("backend_unavailable", 503);
      } finally {
        deps.running.count -= 1;
      }
      return rewriteAnswer(result);
    },
  };
}
