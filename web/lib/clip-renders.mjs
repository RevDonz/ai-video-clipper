// Editor V3 exports: render-request-v3 over HTTP (plan §4.2, §4.6, §9.1).
//
//   POST   /api/jobs/:id/clips/:clipId/renders   export a revision: body exactly {"editEtag"}
//   GET    /api/jobs/:id/clips/:clipId/renders   the clip's exports, newest first
//   GET    /api/jobs/:id/renders/:renderId       status of a legacy (unchanged) or v3 request
//   DELETE /api/jobs/:id/renders/:renderId       cancel a v3 request
//
// POST: storage reservation first (the existing render admission), then
// `python -m ai_clipper.render_queue` `create` through web/lib/python-cli.mjs. The request either
// completes at once (R10: the document is the seed and the auto clip is hard-linked; or an
// export of the same render key exists) → 200 and the reservation is released, or it is queued
// → 202 and the reservation is bound to it (the render worker releases it at the end).
// Status reads parse the request file in Node (no spawn); legacy requests keep their old path and
// DTO. No path, token or hash of the server's layout leaves in a RenderDTO.
import { randomUUID as nodeRandomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import {
  BodyTooLargeError,
  callCli,
  editorDeps,
  editorError,
  editorResponse,
  guard,
  isClipId,
  isEtag,
  isIdempotencyKey,
  isJobId,
  isJsonRequest,
  readBoundedBody,
  MAX_SMALL_BODY_BYTES,
  MESSAGES,
} from "./clip-edit.mjs";
import {
  RenderQueueInvalidError,
  RenderQueueNotFoundError,
  isRenderId,
  isRenderJobId,
  readRenderRequest,
  sanitizeRenderStatus,
} from "./render-requests.mjs";
import { bindRenderStorage, releaseRenderStorage, reserveRenderStorage } from "./render-storage-admission.mjs";
import { parseStorageAdmissionConfig } from "./storage-admission.mjs";

export const RENDER_QUEUE_MODULE = "ai_clipper.render_queue";
export const V3_VERSION = "render-request-v3";
const CREATE_TIMEOUT_MS = 3 * 60_000;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_LISTED_REQUESTS = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const WARNING = /^([a-z][a-z_]{0,39})(?::[0-9A-Za-z .+-]{1,32})?$/;
const WARNING_CODES = new Set(["tight_cut", "laughter_cut", "hook_overflow", "glyph_unsupported", "no_face",
  "unsafe_zone", "loudness_clamped", "peak_reduced", "music_shorter_than_clip", "auto_file_unavailable",
  "engine_fallback"]);
const STATES = new Set(["queued", "claimed", "rendering", "completed", "failed", "cancelled"]);
const STAGES = new Set(["antre", "merender", "memverifikasi", "selesai"]);
const FAILURES = new Set(["render_failed", "render_timeout", "render_stalled", "verification_failed"]);
const ERRORS = new Set([...FAILURES, "cancelled", "max_attempts_exceeded"]);
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const KEYS = Object.freeze([
  "version", "render_id", "idempotency_key", "state", "stage", "progress_pm",
  "clip_id", "doc_sha256", "doc_revision", "doc_relative",
  "render_key", "size", "quality", "output_relative",
  "source_content_sha256", "source_snapshot_relative", "timeout_ms",
  "created_at", "updated_at", "claimed_at", "rendering_at", "completed_at", "failed_at",
  "cancelled_at", "cancel_requested_at",
  "attempts", "error_code", "warnings", "completed_by", "lease_token", "heartbeat_at",
  "storage_reservation_id", "storage_reservation_token", "storage_reserved_bytes",
].sort());
const MESSAGES_V3 = Object.freeze({
  ...MESSAGES,
  render_finished: "Render sudah selesai dan tidak bisa dibatalkan",
  not_cancellable: "Render ini tidak bisa dibatalkan dari Editor V3",
  storage_quota_exhausted: "Penyimpanan server tidak cukup",
  storage_free_space_low: "Penyimpanan server tidak cukup",
  storage_admission_unavailable: "Pemeriksaan penyimpanan tidak tersedia",
  storage_admission_lost: "Pemeriksaan penyimpanan tidak tersedia",
});

export class RenderRequestInvalidError extends Error {}

function invalid() { throw new RenderRequestInvalidError(); }
function int(value, low, high) { return Number.isSafeInteger(value) && value >= low && value <= high; }
function uuid(value) { return typeof value === "string" && UUID.test(value); }
function time(value) {
  return typeof value === "string" && TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}
function warning(value) {
  const match = typeof value === "string" ? WARNING.exec(value) : null;
  return match !== null && WARNING_CODES.has(match[1]);
}

function docRelative(clipId, revision, sha) {
  return revision === 0 ? `analysis/clips/${clipId}/seed.json`
    : `analysis/clips/${clipId}/edit/archive/r${revision}.${sha}.json.gz`;
}

/** Strict validation of a render-request-v3 (the Python `_validate_v3` rules). */
export function validateRenderRequestV3(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const keys = Object.keys(value).sort();
  if (keys.length !== KEYS.length || keys.some((key, index) => key !== KEYS[index]) || value.version !== V3_VERSION) invalid();
  const v = value;
  if (!uuid(v.render_id) || !uuid(v.idempotency_key) || !isClipId(v.clip_id)
      || !isEtag(v.doc_sha256) || !isEtag(v.render_key) || !isEtag(v.source_content_sha256)
      || !int(v.doc_revision, 0, Number.MAX_SAFE_INTEGER)
      || v.doc_relative !== docRelative(v.clip_id, v.doc_revision, v.doc_sha256)
      || v.size !== "output" || v.quality !== "standar"
      || v.output_relative !== `output/edits/${v.clip_id}/${v.render_key.slice(0, 16)}.mp4`
      || !STATES.has(v.state) || !STAGES.has(v.stage) || !int(v.progress_pm, 0, 1000)
      || !int(v.timeout_ms, 120_000, 86_400_000) || !int(v.attempts, 0, 3)
      || (v.error_code !== null && !ERRORS.has(v.error_code))
      || (v.completed_by !== null && !["render", "seed", "key"].includes(v.completed_by))
      || (v.lease_token !== null && !uuid(v.lease_token))) invalid();
  if (!Array.isArray(v.warnings) || v.warnings.length > 16 || new Set(v.warnings).size !== v.warnings.length
      || !v.warnings.every(warning)) invalid();
  if (v.source_snapshot_relative !== null && (typeof v.source_snapshot_relative !== "string"
      || !new RegExp(`^analysis/render-inputs/source\\.${v.source_content_sha256}\\.[a-z0-9]{1,10}$`).test(v.source_snapshot_relative))) invalid();
  const storage = [v.storage_reservation_id, v.storage_reservation_token, v.storage_reserved_bytes];
  if (storage.some((item) => item !== null) && !(uuid(storage[0]) && uuid(storage[1]) && int(storage[2], 1, Number.MAX_SAFE_INTEGER))) invalid();
  if (!time(v.created_at) || !time(v.updated_at)) invalid();
  for (const field of ["claimed_at", "rendering_at", "completed_at", "failed_at", "cancelled_at", "cancel_requested_at", "heartbeat_at"]) {
    if (v[field] !== null && !time(v[field])) invalid();
  }
  const set = (...fields) => fields.every((field) => v[field] !== null);
  const unset = (...fields) => fields.every((field) => v[field] === null);
  let ok = ["claimed", "rendering"].includes(v.state) === set("lease_token", "heartbeat_at");
  ok &&= v.source_snapshot_relative !== null || (v.state === "completed" && ["seed", "key"].includes(v.completed_by));
  if (v.state === "queued") {
    ok &&= v.attempts === 0 && v.stage === "antre" && v.progress_pm === 0 && v.error_code === null && v.completed_by === null
      && unset("claimed_at", "rendering_at", "completed_at", "failed_at", "cancelled_at", "cancel_requested_at");
  } else if (v.state === "claimed") {
    ok &&= v.attempts >= 1 && v.stage === "antre" && v.progress_pm === 0 && v.error_code === null && v.completed_by === null
      && set("claimed_at") && unset("rendering_at", "completed_at", "failed_at", "cancelled_at");
  } else if (v.state === "rendering") {
    ok &&= v.attempts >= 1 && ["merender", "memverifikasi"].includes(v.stage) && v.error_code === null && v.completed_by === null
      && set("claimed_at", "rendering_at") && unset("completed_at", "failed_at", "cancelled_at");
  } else if (v.state === "completed") {
    ok &&= v.stage === "selesai" && v.progress_pm === 1000 && v.error_code === null && v.completed_by !== null
      && set("completed_at") && unset("failed_at", "cancelled_at")
      && (v.completed_by !== "render" || (v.attempts >= 1 && set("claimed_at", "rendering_at")));
  } else if (v.state === "failed") {
    ok &&= v.attempts >= 1 && (FAILURES.has(v.error_code) || v.error_code === "max_attempts_exceeded")
      && v.completed_by === null && set("failed_at", "claimed_at") && unset("completed_at", "cancelled_at");
  } else {
    ok &&= v.error_code === "cancelled" && v.completed_by === null && set("cancelled_at") && unset("completed_at", "failed_at");
  }
  if (!ok) invalid();
  return value;
}

function fileUrl(jobId, relative) {
  return `/${["api", "jobs", jobId, "files", ...relative.split("/")].map((segment) => encodeURIComponent(segment)).join("/")}`;
}

/** RenderDTO (plan §4.2) of a validated v3 request: links only when completed. */
export function renderDtoV3(jobId, untrusted) {
  const request = validateRenderRequestV3(untrusted);
  const done = request.state === "completed";
  const srt = `${request.output_relative.slice(0, -".mp4".length)}.srt`;
  return {
    renderId: request.render_id,
    clipId: request.clip_id,
    state: request.state,
    stage: request.stage,
    progressPm: request.progress_pm,
    revision: request.doc_revision,
    errorCode: request.error_code,
    resultUrl: done ? fileUrl(jobId, request.output_relative) : null,
    srtUrl: done ? fileUrl(jobId, srt) : null,
    warnings: [...request.warnings],
    completedBy: request.completed_by,
    cancelRequested: request.cancel_requested_at !== null,
    createdAt: request.created_at,
    updatedAt: request.updated_at,
  };
}

/** `latestRender` of the clips listing: `{renderId, state, url, srtUrl, revision}`. */
export function latestRenderDto(jobId, request) {
  const dto = renderDtoV3(jobId, request);
  return { renderId: dto.renderId, state: dto.state, url: dto.resultUrl, srtUrl: dto.srtUrl, revision: dto.revision };
}

// --- reading request files (Node, no spawn; writes stay with the Python queue under its lock) -----

async function realDirectory(target) {
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(target) !== target) {
    const error = new Error("unsafe directory");
    error.code = "EUNSAFE";
    throw error;
  }
}

async function queueDirectory(jobsRoot, jobId) {
  if (!isJobId(jobId)) return null;
  try {
    const root = await realpath(path.resolve(/* turbopackIgnore: true */ jobsRoot));
    const job = path.join(root, jobId);
    const directory = path.join(job, "analysis", "render-requests");
    for (const part of [job, path.join(job, "analysis"), directory]) await realDirectory(part);
    return directory;
  } catch {
    return null;
  }
}

async function readJson(file) {
  const handle = await open(/* turbopackIgnore: true */ file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_REQUEST_BYTES) throw new RenderRequestInvalidError();
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

/** The parsed request file (any version), `null` when it does not exist. Throws when unsafe. */
export async function readRenderRequestFile(jobId, renderId, jobsRoot) {
  if (!isJobId(jobId) || !uuid(renderId)) throw new RenderRequestInvalidError();
  const directory = await queueDirectory(jobsRoot, jobId);
  if (directory === null) return null;
  try {
    return await readJson(path.join(/* turbopackIgnore: true */ directory, `${renderId}.json`));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function v3Requests(jobId, jobsRoot) {
  const directory = await queueDirectory(jobsRoot, jobId);
  if (directory === null) return [];
  let names;
  try { names = await readdir(/* turbopackIgnore: true */ directory); } catch { return []; }
  const result = [];
  for (const name of names.slice(0, MAX_LISTED_REQUESTS + 16)) {
    if (!/^[0-9a-f-]{36}\.json$/.test(name) || !uuid(name.slice(0, -5))) continue;
    try {
      const value = await readJson(path.join(/* turbopackIgnore: true */ directory, name));
      if (value?.version === V3_VERSION && value.render_id === name.slice(0, -5)) result.push(validateRenderRequestV3(value));
    } catch { /* a legacy, partial or unsafe entry is not listed */ }
  }
  return result.sort((a, b) => (a.created_at === b.created_at ? (a.render_id < b.render_id ? 1 : -1)
    : (a.created_at < b.created_at ? 1 : -1)));
}

/** The v3 requests of one clip, newest first (validated; anything else is skipped). */
export async function listClipRenders(jobId, clipId, jobsRoot) {
  if (!isClipId(clipId)) return [];
  return (await v3Requests(jobId, jobsRoot)).filter((request) => request.clip_id === clipId);
}

/** clipId → `latestRender` of the newest v3 request of each clip of the job. */
export async function latestRenders(jobId, jobsRoot) {
  const latest = new Map();
  for (const request of await v3Requests(jobId, jobsRoot)) {
    if (!latest.has(request.clip_id)) latest.set(request.clip_id, latestRenderDto(jobId, request));
  }
  return latest;
}

// --- routes -----------------------------------------------------------------------------------------

function renderError(code, status, extra = {}) {
  return editorResponse({ error: MESSAGES_V3[code] ?? MESSAGES_V3.invalid_request, code, ...extra }, status);
}

/** A queue CLI failure as HTTP: `{exitCode, json}` of a non-zero exit, or null (→ 503). */
function queueFailure(result) {
  if (result === null) return renderError("backend_unavailable", 503);
  const code = typeof result.json?.error?.code === "string" ? result.json.error.code : "internal_error";
  switch (result.exitCode) {
    case 4: return code === "source_missing" ? renderError("source_missing", 409) : renderError("not_found", 404);
    case 5: return renderError("revision_conflict", 409);
    case 8: return renderError("analysis_missing", 409);
    case 9: return renderError("idempotency_conflict", 409);
    case 3: case 6: return renderError(/^[a-z_]{1,40}$/.test(code) ? code : "document_invalid", 422);
    default: return renderError("backend_unavailable", 503);
  }
}

function storageFailure(error) {
  const code = ["storage_quota_exhausted", "storage_free_space_low"].includes(error?.code) ? error.code
    : "storage_admission_unavailable";
  return renderError(code, code === "storage_admission_unavailable" ? 503 : 507);
}

async function parseRenderBody(request) {
  if (!isJsonRequest(request)) return { status: 400 };
  let raw;
  try { raw = await readBoundedBody(request, MAX_SMALL_BODY_BYTES); } catch (error) {
    return { status: error instanceof BodyTooLargeError ? 413 : 400 };
  }
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(raw); } catch { return { status: 400 }; }
  const match = /^\s*\{\s*"editEtag"\s*:\s*"([0-9a-f]{64})"\s*\}\s*$/.exec(text);
  return match ? { editEtag: match[1] } : { status: 400 };
}

export function createClipRendersRoute(options = {}) {
  const deps = editorDeps(options);
  const reserve = options.reserve ?? reserveRenderStorage;
  const bind = options.bind ?? bindRenderStorage;
  const release = options.release ?? releaseRenderStorage;
  const randomUUID = options.randomUUID ?? nodeRandomUUID;
  const ids = { id: isJobId, clipId: isClipId };

  return {
    async GET(request, { params }) {
      const checked = await guard(request, params, deps, { ids });
      if (checked.denied) return checked.denied;
      const { id: jobId, clipId } = checked.params;
      const renders = await listClipRenders(jobId, clipId, deps.jobsRoot);
      return editorResponse({ renders: renders.map((item) => renderDtoV3(jobId, item)) });
    },
    async POST(request, { params }) {
      const checked = await guard(request, params, deps, { ids, mutation: true });
      if (checked.denied) return checked.denied;
      const idempotencyKey = request.headers.get("idempotency-key");
      if (!isIdempotencyKey(idempotencyKey)) return renderError("invalid_request", 400);
      const body = await parseRenderBody(request);
      if (!body.editEtag) return body.status === 413 ? renderError("payload_too_large", 413) : renderError("invalid_request", 400);
      const { id: jobId, clipId } = checked.params;
      const { editEtag } = body;

      const estimate = await callCli(deps, RENDER_QUEUE_MODULE, "estimate", { jobId, clipId, editEtag });
      if (estimate?.exitCode !== 0) return queueFailure(estimate);
      if (typeof estimate.json.bytes !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(estimate.json.bytes)) return queueFailure(null);

      let reservation;
      try {
        const storageConfig = options.storageConfig ?? parseStorageAdmissionConfig(deps.env);
        reservation = await reserve(deps.jobsRoot, {
          reservationId: randomUUID(), jobId, declaredBytes: BigInt(estimate.json.bytes), storageConfig,
          storageOps: options.storageOps,
        });
      } catch (error) {
        return storageFailure(error);
      }
      const reserved = BigInt(reservation.reservedBytes);
      const releaseAs = (terminalState) => release(deps.jobsRoot, reservation.reservationId, reservation.token, terminalState)
        .catch(() => false);
      if (reserved > BigInt(Number.MAX_SAFE_INTEGER)) {
        await releaseAs("failed");
        return renderError("storage_admission_unavailable", 503);
      }

      const created = await callCli(deps, RENDER_QUEUE_MODULE, "create", {
        jobId, clipId, editEtag, idempotencyKey,
        storageReservation: { reservation_id: reservation.reservationId, token: reservation.token, reserved_bytes: Number(reserved) },
      }, { timeoutMs: CREATE_TIMEOUT_MS });
      if (created?.exitCode !== 0) {
        await releaseAs("failed");
        return queueFailure(created);
      }
      let value;
      try {
        value = validateRenderRequestV3(created.json.request);
        if (value.clip_id !== clipId) throw new RenderRequestInvalidError();
      } catch {
        await releaseAs("failed");
        return renderError("backend_unavailable", 503);
      }
      if (value.storage_reservation_id !== reservation.reservationId) {
        await releaseAs("failed");  // an idempotent replay: its own reservation is already bound
      } else if (TERMINAL.has(value.state)) {
        await releaseAs(value.state === "completed" ? "completed" : "failed");
      } else if (!await bind(deps.jobsRoot, reservation.reservationId, reservation.token, value.render_id).catch(() => false)) {
        return renderError("storage_admission_lost", 503);
      }
      // 200: nothing is left to do (an instant completion, or a replay of a finished export)
      return editorResponse(renderDtoV3(jobId, value), TERMINAL.has(value.state) ? 200 : 202);
    },
  };
}

// The legacy status answers exactly as the route did before render-request-v3.
function legacyStatus(error) {
  const respond = (body, status) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  if (error instanceof RenderQueueNotFoundError) return respond({ error: "Render tidak ditemukan", code: "not_found" }, 404);
  if (error instanceof RenderQueueInvalidError) return respond({ error: "Render tidak valid", code: "invalid_request" }, 400);
  return respond({ error: "Layanan render tidak tersedia", code: "backend_unavailable" }, 503);
}

export function createRenderStatusRoute(options = {}) {
  const deps = editorDeps(options);
  const legacyRead = options.legacyRead ?? readRenderRequest;
  const legacyResponse = (body, status) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

  return {
    async GET(request, { params }) {
      const denied = deps.authorize(request);
      if (denied) return denied;
      const { id: jobId, renderId } = await params;
      if (!isRenderJobId(jobId) || !isRenderId(renderId)) {  // the legacy id rules, unchanged
        return legacyResponse({ error: "Render tidak valid", code: "invalid_request" }, 400);
      }
      let value;
      try {
        value = await readRenderRequestFile(jobId, renderId, deps.jobsRoot);
      } catch {
        value = undefined;  // unsafe or unreadable: the legacy path answers as it always did
      }
      if (value === null) return legacyResponse({ error: "Render tidak ditemukan", code: "not_found" }, 404);
      if (value?.version === V3_VERSION) {
        try {
          if (value.render_id !== renderId) throw new RenderRequestInvalidError();
          return editorResponse(renderDtoV3(jobId, value));
        } catch {
          return renderError("backend_unavailable", 503);
        }
      }
      try {
        return legacyResponse(sanitizeRenderStatus(jobId, await legacyRead(jobId, renderId)), 200);
      } catch (error) {
        return legacyStatus(error);
      }
    },
    async DELETE(request, { params }) {
      const checked = await guard(request, params, deps, { ids: { id: isJobId, renderId: uuid }, mutation: true });
      if (checked.denied) return checked.denied;
      const { id: jobId, renderId } = checked.params;
      const result = await callCli(deps, RENDER_QUEUE_MODULE, "cancel", { jobId, renderId });
      if (result?.exitCode !== 0) return queueFailure(result);
      const value = result.json.request;
      if (value?.version !== V3_VERSION) return renderError("not_cancellable", 409);
      let dto;
      try { dto = renderDtoV3(jobId, value); } catch { return renderError("backend_unavailable", 503); }
      if (dto.state === "cancelled") return editorResponse(dto, 200);
      if (dto.state === "completed" || dto.state === "failed") return renderError("render_finished", 409, { render: dto });
      return editorResponse(dto, 202);
    },
  };
}
