import crypto from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { mkdir, open, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import Busboy from "busboy";

import { requireAuth } from "../../../lib/auth.mjs";
import { sameOriginMutation } from "../../../lib/request-security.mjs";
import { parseJobOptions, serializePublicJob, sortJobsNewest, validateYouTubeUrl } from "../../../lib/jobs.mjs";
import {
  QueueCapacityError,
  abortAdmissionStaging,
  cancelAdmission,
  parsePrimaryQueueConfig,
  publishFailedAdmissionJob,
  publishReservedQueuedJob,
  recheckAdmission,
  reserveAdmission,
} from "../../../lib/primary-job-queue.mjs";
import { parseStorageAdmissionConfig, StorageAdmissionError } from "../../../lib/storage-admission.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const jobsRoot = () => path.resolve(process.env.JOBS_ROOT || "/data/jobs");
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v"]);
const NO_STORE_HEADERS = { "Cache-Control": "no-store" };
const postJson = (body, init = {}) => Response.json(body, {
  ...init, headers: { ...init.headers, ...NO_STORE_HEADERS },
});

function publicJob(job) {
  const safe = serializePublicJob(job);
  if (!safe.queue) return safe;
  return { ...safe, queue: { version: safe.queue.version, attempts: safe.queue.attempts } };
}

async function syncDirectory(directory) {
  const fd = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await fd.sync(); } finally { await fd.close(); }
}

export function validatePrimaryRequestLength(headers, env = process.env) {
  const configured = env.MAX_UPLOAD_BYTES;
  if (typeof configured !== "string" || !/^[1-9]\d*$/.test(configured)) throw new Error("Invalid upload configuration: MAX_UPLOAD_BYTES");
  const maximum = Number(configured);
  if (!Number.isSafeInteger(maximum)) throw new Error("Invalid upload configuration: MAX_UPLOAD_BYTES");
  const rawLength = headers.get("content-length");
  if (typeof rawLength !== "string" || !/^(?:0|[1-9]\d*)$/.test(rawLength)) throw new Error("A valid Content-Length header is required");
  const length = Number(rawLength);
  if (!Number.isSafeInteger(length) || length > maximum + MULTIPART_OVERHEAD_BYTES) throw new Error("Request is too large");
  return length;
}

export function selectionV2Enabled(env = process.env) {
  const value = env.SELECTION_V2_ENABLED;
  if (value === undefined || value === "true") return true;
  if (value === "false") return false;
  throw new Error("Invalid Selection V2 configuration");
}

export function parseJobFormOptions(form) {
  return parseJobOptions({
    renderMode: form.get("renderMode"), limit: form.get("limit"), minDuration: form.get("minDuration"), maxDuration: form.get("maxDuration"),
    selectionMode: form.get("selectionMode"), clipProfile: form.get("clipProfile"), maxCandidates: form.get("maxCandidates"),
    maxMediaCandidates: form.get("maxMediaCandidates"), mediaTimeout: form.get("mediaTimeout"),
  });
}

export async function streamPrimaryMultipart(request, inputRoot, maximumUploadBytes, maximumRequestBytes = maximumUploadBytes + MULTIPART_OVERHEAD_BYTES, renewal = {}) {
  if (!request.body) throw new Error("Multipart request body is required");
  await mkdir(inputRoot, { recursive: true });
  const fields = new Map();
  let upload = null;
  let uploadDone = Promise.resolve();
  let parserError = null;
  const parser = Busboy({
    headers: Object.fromEntries(request.headers.entries()),
    limits: { files: 1, fields: 20, parts: 21, fieldNameSize: 100, fieldSize: 10_000, fileSize: maximumUploadBytes },
  });
  const completed = new Promise((resolve, reject) => {
    parser.once("error", reject);
    parser.once("partsLimit", () => reject(new Error("Multipart part limit exceeded")));
    parser.once("filesLimit", () => reject(new Error("Only one video upload is allowed")));
    parser.once("fieldsLimit", () => reject(new Error("Multipart field limit exceeded")));
    parser.once("finish", async () => {
      try { await uploadDone; if (parserError) throw parserError; resolve(); } catch (error) { reject(error); }
    });
  });
  parser.on("field", (name, value, info) => {
    if (info.valueTruncated || fields.has(name)) { parserError ||= new Error("Invalid or duplicate multipart field"); return; }
    fields.set(name, value);
  });
  parser.on("file", (name, file, info) => {
    if (name !== "video" || upload) { parserError ||= new Error("Only one video upload is allowed"); file.resume(); return; }
    const filename = info.filename;
    const extension = path.extname(filename || "").toLowerCase();
    if (!filename || filename !== path.basename(filename) || filename.length > 255 || /[\0-\x1f\x7f]/.test(filename) || !VIDEO_EXTENSIONS.has(extension)) {
      parserError ||= new Error("Format video tidak didukung"); file.resume(); return;
    }
    const target = path.join(inputRoot, `source${extension}`);
    let size = 0;
    const output = createWriteStream(target, { flags: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode: 0o600 });
    uploadDone = new Promise((resolve, reject) => {
      file.on("data", (chunk) => { size += chunk.length; });
      file.once("limit", () => { parserError ||= new Error("Ukuran upload melewati batas server"); output.destroy(parserError); });
      file.once("error", reject);
      output.once("error", reject);
      output.once("close", async () => {
        if (parserError) { reject(parserError); return; }
        try {
          const fd = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
          try { await fd.sync(); } finally { await fd.close(); }
          await syncDirectory(inputRoot);
          upload = { name: filename, size, path: target };
          resolve();
        } catch (error) { reject(error); }
      });
      file.pipe(output);
    });
  });

  let consumed = 0;
  const recheck = renewal.recheck || renewal.heartbeat;
  const heartbeatEnabled = typeof recheck === "function";
  const heartbeatMs = renewal.heartbeatMs ?? 60_000;
  const recheckBytes = renewal.recheckBytes ?? 8 * 1024 * 1024;
  if (heartbeatEnabled && (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1)) throw new Error("Invalid admission heartbeat interval");
  if (heartbeatEnabled && (!Number.isSafeInteger(recheckBytes) || recheckBytes < 8 * 1024 * 1024 || recheckBytes > 16 * 1024 * 1024)) throw new Error("Invalid admission byte recheck interval");
  if (heartbeatEnabled) await recheck(BigInt(consumed));
  const reader = request.body.getReader();
  let heartbeatStopped = false;
  let heartbeatTimer = null;
  let wakeHeartbeat = null;
  let heartbeatError = null;
  let rejectHeartbeat;
  const heartbeatFailure = new Promise((_, reject) => { rejectHeartbeat = reject; });
  heartbeatFailure.catch(() => {});
  const heartbeatTask = heartbeatEnabled ? (async () => {
    while (!heartbeatStopped) {
      await new Promise((resolve) => {
        wakeHeartbeat = resolve;
        heartbeatTimer = setTimeout(resolve, heartbeatMs);
      });
      heartbeatTimer = null;
      if (heartbeatStopped) break;
      try { await recheck(BigInt(consumed)); }
      catch (error) {
        heartbeatError ||= error;
        rejectHeartbeat(error);
        break;
      }
    }
  })() : Promise.resolve();
  const awaitHeartbeatSafe = (promise) => heartbeatEnabled ? Promise.race([promise, heartbeatFailure]) : promise;
  const stopHeartbeat = async () => {
    if (heartbeatStopped) return;
    heartbeatStopped = true;
    if (heartbeatTimer !== null) clearTimeout(heartbeatTimer);
    wakeHeartbeat?.();
    await heartbeatTask;
    if (heartbeatError) throw heartbeatError;
  };

  let nextRecheck = recheckBytes;
  let failure = null;
  try {
    while (true) {
      const { done, value } = await awaitHeartbeatSafe(reader.read());
      if (done) break;
      consumed += value.byteLength;
      if (consumed > maximumRequestBytes) throw new Error("Request is too large");
      if (heartbeatEnabled && consumed >= nextRecheck) {
        await recheck(BigInt(consumed));
        nextRecheck = consumed + recheckBytes;
      }
      if (!parser.write(Buffer.from(value))) await awaitHeartbeatSafe(new Promise((resolve) => parser.once("drain", resolve)));
    }
    parser.end();
    await awaitHeartbeatSafe(completed);
    if (heartbeatEnabled) await recheck(BigInt(consumed));
  } catch (error) {
    failure = error;
    parser.destroy(error);
    await completed.catch(() => {});
    await uploadDone.catch(() => {});
  }
  try { await stopHeartbeat(); }
  catch (error) {
    if (!failure) {
      failure = error;
      parser.destroy(error);
      await completed.catch(() => {});
      await uploadDone.catch(() => {});
    }
  }
  try {
    if (failure) {
      await reader.cancel(failure).catch(() => {});
      throw failure;
    }
  } finally {
    reader.releaseLock();
  }

  return { form: { get: (name) => fields.get(name) ?? null }, upload, consumedBytes: consumed };
}

export async function GET(request) {
  const denied = requireAuth(request);
  if (denied) return denied;
  await mkdir(jobsRoot(), { recursive: true });
  const entries = await readdir(jobsRoot(), { withFileTypes: true });
  const jobs = [];
  for (const entry of entries.filter((item) => item.isDirectory() && !item.name.startsWith("."))) {
    try { jobs.push(publicJob(JSON.parse(await readFile(path.join(jobsRoot(), entry.name, "job.json"), "utf8")))); }
    catch { /* Ignore incomplete directories; queue validation is authoritative. */ }
  }
  return Response.json({ jobs: sortJobsNewest(jobs), total: jobs.length });
}

export async function POST(request) {
  const denied = requireAuth(request);
  if (denied) return denied;
  if (!sameOriginMutation(request)) return postJson({ error: "Origin permintaan tidak diizinkan", code: "csrf_rejected" }, { status: 403 });
  let reservation = null;
  let jobRoot = null;
  let createdJobRoot = false;
  let published = false;
  try {
    const queueConfig = parsePrimaryQueueConfig(process.env);
    const storageConfig = parseStorageAdmissionConfig(process.env);
    const requestLength = validatePrimaryRequestLength(request.headers, process.env);
    const id = crypto.randomUUID();
    reservation = await reserveAdmission(jobsRoot(), queueConfig.maxActiveJobs, id, {
      declaredRequestBytes: BigInt(requestLength), storageConfig,
    });

    await mkdir(jobsRoot(), { recursive: true });
    jobRoot = path.join(jobsRoot(), id);
    await mkdir(jobRoot, { mode: 0o700 });
    createdJobRoot = true;
    await syncDirectory(jobsRoot());
    const inputRoot = path.join(jobRoot, "input");
    await mkdir(inputRoot, { mode: 0o700 });
    await syncDirectory(jobRoot);

    const maximum = Number(process.env.MAX_UPLOAD_BYTES);
    const parsed = await streamPrimaryMultipart(request, inputRoot, maximum, maximum + MULTIPART_OVERHEAD_BYTES, {
      recheck: async (consumed) => {
        if (!await recheckAdmission(jobsRoot(), reservation, consumed, storageConfig)) {
          throw new StorageAdmissionError("storage_admission_unavailable", "Primary admission reservation was lost");
        }
      },
      heartbeatMs: storageConfig.recheckIntervalMs,
      recheckBytes: storageConfig.recheckBytes,
    });
    const options = parseJobFormOptions(parsed.form);
    if (options.selectionMode === "v2-shadow" && !selectionV2Enabled(process.env)) throw new Error("Selection V2 dinonaktifkan oleh operator");
    const youtubeUrl = String(parsed.form.get("youtubeUrl") || "").trim();
    const hasUpload = Boolean(parsed.upload && parsed.upload.size > 0);
    if ((hasUpload && youtubeUrl) || (!hasUpload && !youtubeUrl)) throw new Error("Pilih tepat satu sumber: upload video atau URL YouTube");
    if (youtubeUrl && !validateYouTubeUrl(youtubeUrl)) throw new Error("URL harus berasal dari youtube.com atau youtu.be");
    const source = hasUpload ? { type: "upload", name: parsed.upload.name, size: parsed.upload.size } : { type: "youtube", url: youtubeUrl };
    const sourcePath = hasUpload ? parsed.upload.path : null;
    const now = new Date().toISOString();
    const job = { id, status: "queued", progress: 0, createdAt: now, updatedAt: now, source, sourcePath, options, clips: [] };
    const queued = await publishReservedQueuedJob(jobsRoot(), job, reservation);
    published = true;
    return postJson({ job: publicJob(queued) }, { status: 202 });
  } catch (error) {
    if (error instanceof StorageAdmissionError) {
      let failedJobId = null;
      if (reservation && createdJobRoot && !published) {
        try {
          const failed = await publishFailedAdmissionJob(jobsRoot(), reservation, error.code);
          failedJobId = failed?.id || null;
        } catch {
          return postJson({
            error: "Status penyimpanan server tidak dapat diverifikasi.",
            code: "storage_admission_unavailable", retryable: true, jobId: null,
          }, { status: 503 });
        }
      } else if (reservation && !createdJobRoot) {
        await cancelAdmission(jobsRoot(), reservation).catch(() => {});
      }
      const messages = {
        storage_quota_exhausted: "Penyimpanan server tidak cukup untuk job baru.",
        storage_free_space_low: "Ruang kosong penyimpanan server terlalu rendah.",
        storage_admission_unavailable: "Status penyimpanan server tidak dapat diverifikasi.",
      };
      return postJson({ error: messages[error.code], code: error.code, retryable: error.status === 503, jobId: failedJobId }, { status: error.status });
    }
    if (reservation && !published) {
      const recovered = await abortAdmissionStaging(jobsRoot(), reservation).catch(() => null);
      if (recovered?.published) return postJson({ job: publicJob(recovered.job) }, { status: 202 });
      if (!createdJobRoot) await cancelAdmission(jobsRoot(), reservation).catch(() => {});
    }
    const status = error instanceof QueueCapacityError ? 429
      : /V2 dinonaktifkan/i.test(error.message || "") ? 403
        : /configuration/i.test(error.message || "") ? 503
        : /Content-Length/i.test(error.message || "") ? 411
          : /too large|melewati batas|limit exceeded/i.test(error.message || "") ? 413 : 400;
    const response = status === 429
      ? { error: "Antrean job sedang penuh.", code: "queue_capacity_reached" }
      : status === 403
        ? { error: "Selection V2 dinonaktifkan oleh operator.", code: "selection_v2_disabled" }
        : status === 503
          ? { error: "Layanan pembuatan job sementara tidak tersedia.", code: "job_service_unavailable" }
          : status === 413
            ? { error: "Ukuran permintaan job terlalu besar.", code: "request_too_large" }
            : { error: "Permintaan job tidak valid.", code: "invalid_request" };
    return postJson(response, { status });
  }
}
