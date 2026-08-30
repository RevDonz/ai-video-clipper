import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANDIDATE = /^cand_[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{64}$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const STATES = new Set(["queued", "claimed", "rendering", "completed", "failed"]);
const ERROR_CODES = new Set(["render_failed", "verification_failed", "max_attempts_exceeded"]);
const EXACT_KEYS = new Set([
  "version", "render_id", "idempotency_key", "state", "candidate_id",
  "candidate_artifact_sha256", "candidate_snapshot_relative", "edit_manifest_sha256",
  "edit_revision", "edit_manifest_relative", "source_identity_sha256",
  "source_content_sha256", "source_snapshot_relative", "output_relative", "created_at",
  "updated_at", "claimed_at", "rendering_at", "completed_at", "failed_at", "attempts",
  "error_code", "lease_token", "heartbeat_at",
]);
const MAX_OUTPUT = 2 * 1024 * 1024;

export class RenderQueueInvalidError extends Error {}
export class RenderQueueNotFoundError extends Error {}
export class RenderQueueConflictError extends Error {}
export class RenderQueueUnavailableError extends Error {}

export function isRenderId(value) { return typeof value === "string" && UUID.test(value); }
export function isRenderJobId(value) { return isRenderId(value); }
export function isRenderCandidateId(value) { return typeof value === "string" && CANDIDATE.test(value); }
export function isRenderIdempotencyKey(value) { return isRenderId(value); }
export function isRenderEtag(value) { return typeof value === "string" && SHA.test(value); }

function isTimestamp(value) {
  return typeof value === "string" && UTC_TIMESTAMP.test(value)
    && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function validateRenderRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RenderQueueInvalidError();
  const keys = Object.keys(value);
  if (keys.length !== EXACT_KEYS.size || keys.some((key) => !EXACT_KEYS.has(key))) {
    throw new RenderQueueInvalidError();
  }
  if (value.version !== "render-request-v1" || !STATES.has(value.state)
      || !isRenderId(value.render_id) || !isRenderIdempotencyKey(value.idempotency_key)
      || !isRenderCandidateId(value.candidate_id)) throw new RenderQueueInvalidError();

  for (const key of [
    "candidate_artifact_sha256", "edit_manifest_sha256", "source_identity_sha256",
    "source_content_sha256",
  ]) if (!isRenderEtag(value[key])) throw new RenderQueueInvalidError();
  if (!Number.isInteger(value.edit_revision) || typeof value.edit_revision === "boolean"
      || value.edit_revision < 1 || !Number.isInteger(value.attempts)
      || typeof value.attempts === "boolean" || value.attempts < 0 || value.attempts > 3) {
    throw new RenderQueueInvalidError();
  }

  const revision = value.edit_revision;
  if (value.candidate_snapshot_relative
        !== `analysis/render-inputs/candidates.${value.candidate_artifact_sha256}.json`
      || value.edit_manifest_relative
        !== `analysis/edits/archive/${value.candidate_id}.edit.v1.r${revision}.${value.edit_manifest_sha256}.json`
      || value.output_relative !== `output/edits/${value.candidate_id}/revision-${revision}.mp4`
      || typeof value.source_snapshot_relative !== "string"
      || !new RegExp(`^analysis/render-inputs/source\\.${value.source_content_sha256}\\.[a-z0-9]{1,10}$`)
        .test(value.source_snapshot_relative)) throw new RenderQueueInvalidError();

  if (!isTimestamp(value.created_at) || !isTimestamp(value.updated_at)) throw new RenderQueueInvalidError();
  for (const key of ["claimed_at", "rendering_at", "completed_at", "failed_at", "heartbeat_at"]) {
    if (value[key] !== null && !isTimestamp(value[key])) throw new RenderQueueInvalidError();
  }
  if (value.error_code !== null && !ERROR_CODES.has(value.error_code)) throw new RenderQueueInvalidError();
  if (value.lease_token !== null && !isRenderId(value.lease_token)) throw new RenderQueueInvalidError();

  const none = (...fields) => fields.every((field) => value[field] === null);
  const present = (...fields) => fields.every((field) => value[field] !== null);
  let validState = false;
  if (value.state === "queued") {
    validState = value.attempts === 0 && value.error_code === null
      && none("claimed_at", "rendering_at", "completed_at", "failed_at", "lease_token", "heartbeat_at");
  } else if (value.state === "claimed") {
    validState = value.attempts >= 1 && value.error_code === null
      && present("claimed_at", "lease_token", "heartbeat_at")
      && none("rendering_at", "completed_at", "failed_at");
  } else if (value.state === "rendering") {
    validState = value.attempts >= 1 && value.error_code === null
      && present("claimed_at", "rendering_at", "lease_token", "heartbeat_at")
      && none("completed_at", "failed_at");
  } else if (value.state === "completed") {
    validState = value.attempts >= 1 && value.error_code === null
      && present("claimed_at", "rendering_at", "completed_at")
      && none("failed_at", "lease_token", "heartbeat_at");
  } else if (value.state === "failed") {
    validState = value.attempts >= 1 && ERROR_CODES.has(value.error_code)
      && present("claimed_at", "failed_at")
      && none("completed_at", "lease_token", "heartbeat_at");
  }
  if (!validState) throw new RenderQueueInvalidError();
  return value;
}

export function runRenderQueuePython(jobDir, command, options = {}) {
  let raw;
  try { raw = Buffer.from(JSON.stringify(command)); } catch { return Promise.reject(new RenderQueueInvalidError()); }
  const runner = options.execFileImpl || execFile;
  return new Promise((resolve, reject) => {
    const child = runner(options.pythonBin || process.env.PYTHON_BIN || "python", [
      "-m", "ai_clipper.render_queue", "--job-dir", jobDir,
    ], { encoding: "buffer", maxBuffer: MAX_OUTPUT, timeout: 30_000, killSignal: "SIGKILL", windowsHide: true, shell: false },
    (error, stdout) => {
      if (error) {
        if (error.code === 3) reject(new RenderQueueInvalidError());
        else if (error.code === 4) reject(new RenderQueueNotFoundError());
        else if (error.code === 5) reject(new RenderQueueConflictError());
        else reject(new RenderQueueUnavailableError());
        return;
      }
      try {
        if (!Buffer.isBuffer(stdout) || stdout.length > MAX_OUTPUT) throw new Error();
        resolve(validateRenderRequest(JSON.parse(stdout.toString("utf8"))));
      } catch { reject(new RenderQueueUnavailableError()); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(raw);
  });
}

async function resolveJob(jobId, jobsRoot) {
  if (!isRenderJobId(jobId)) throw new RenderQueueInvalidError();
  try {
    const root = await realpath(path.resolve(jobsRoot));
    const job = path.join(root, jobId);
    const [jobInfo, marker] = await Promise.all([lstat(job), lstat(path.join(job, "job.json"))]);
    if (jobInfo.isSymbolicLink() || !jobInfo.isDirectory() || await realpath(job) !== job
        || marker.isSymbolicLink() || !marker.isFile()) throw new RenderQueueNotFoundError();
    return job;
  } catch (error) {
    if (error instanceof RenderQueueInvalidError || error instanceof RenderQueueNotFoundError) throw error;
    if (error?.code === "ENOENT") throw new RenderQueueNotFoundError();
    throw new RenderQueueUnavailableError();
  }
}

export async function createRenderRequest(jobId, candidateId, editEtag, key,
  jobsRoot = process.env.JOBS_ROOT || "/data/jobs", options = {}) {
  if (!isRenderCandidateId(candidateId) || !isRenderEtag(editEtag) || !isRenderIdempotencyKey(key)) throw new RenderQueueInvalidError();
  const job = await resolveJob(jobId, jobsRoot);
  return (options.runner || runRenderQueuePython)(job, {
    operation: "create", candidateId, editEtag, idempotencyKey: key,
  });
}

export async function readRenderRequest(jobId, renderId,
  jobsRoot = process.env.JOBS_ROOT || "/data/jobs", options = {}) {
  if (!isRenderId(renderId)) throw new RenderQueueInvalidError();
  const job = await resolveJob(jobId, jobsRoot);
  return (options.runner || runRenderQueuePython)(job, { operation: "get", renderId });
}

export function sanitizeRenderStatus(jobId, untrustedRequest) {
  const request = validateRenderRequest(untrustedRequest);
  const result = {
    renderId: request.render_id, candidateId: request.candidate_id, state: request.state,
    revision: request.edit_revision, attempts: request.attempts, createdAt: request.created_at,
    updatedAt: request.updated_at, errorCode: request.error_code,
  };
  if (request.state === "completed") {
    const segments = ["api", "jobs", jobId, "files", ...request.output_relative.split("/")];
    result.resultUrl = `/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
  }
  return result;
}
