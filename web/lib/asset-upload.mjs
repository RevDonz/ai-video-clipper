// Editor V3 uploads and the job asset store over HTTP (plan §9.2, §4.2; T3.1).
//
//   POST /api/jobs/:id/assets        raw body (no multipart): a logo or a music file
//   GET  /api/jobs/:id/assets/:sha   the normalised bytes (?part=peaks: the music waveform;
//                                    ?part=meta: the asset object), HEAD alike
//
// POST runs WITHOUT web/proxy.js in front (the proxy makes Next buffer a body at 10 MB and hand
// the route a truncated one; web/tests/proxy-matcher.test.mjs pins the exclusion), so it checks
// everything itself, in this order, before a byte of the body is read: the session
// (requireAuth), POTONGIN_EDITOR_V3 and POTONGIN_EDITOR_UPLOADS (404 while off), same origin
// (Origin, Host, Sec-Fetch-Site), the job id, the upload rate (30 per minute per session), the
// transport headers (X-Asset-Kind, the Content-Type allowlist of the kind, Idempotency-Key, a
// Content-Length within the kind's cap, X-Asset-Name ≤ 80 characters: percent-encoded UTF-8,
// display only), the job's quota (≤ 50 assets, ≤ 1 GiB) and a storage-admission reservation.
// The body is then streamed and counted into the quarantine `analysis/assets/.incoming/<uuid>`
// (O_EXCL | O_NOFOLLOW, 0600, directories 0700 and never symlinks), refused at the cap or when
// its first 64 bytes do not match the declared type, and handed to
// `python -m ai_clipper.edit_v2.assets ingest` through web/lib/python-cli.mjs (allowlisted
// environment, E11; at most two ingests at a time per process). The quarantine file and the
// reservation are gone when the request ends, whatever happened. Answers carry fixed codes with
// Indonesian messages and never echo a path, a name or the backend's output.
import { randomUUID as nodeRandomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";

import { SESSION_COOKIE } from "./auth.mjs";
import { callCli, editorDeps, isEditorEnabled, isIdempotencyKey, isJobId } from "./clip-edit.mjs";
import { IMMUTABLE, openedFileResponse } from "./clip-media.mjs";
import { createEditorRateLimits } from "./rate-limit.mjs";
import { releaseRenderStorage, reserveRenderStorage } from "./render-storage-admission.mjs";
import { sameOriginMutation } from "./request-security.mjs";
import { parseStorageAdmissionConfig } from "./storage-admission.mjs";

export const ASSET_MODULE = "ai_clipper.edit_v2.assets";
export const ASSET_KINDS = Object.freeze({
  logo: Object.freeze({ types: Object.freeze(["image/png", "image/jpeg", "image/webp"]), maxBytes: 10 * 1024 * 1024 }),
  music: Object.freeze({ types: Object.freeze(["audio/mpeg", "audio/mp4", "audio/wav", "audio/ogg", "audio/flac"]), maxBytes: 50 * 1024 * 1024 }),
});
export const FORMATS = Object.freeze({
  "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp", "audio/mpeg": "mp3", "audio/mp4": "mp4",
  "audio/wav": "wav", "audio/ogg": "ogg", "audio/flac": "flac",
});
export const MAX_ASSETS_PER_JOB = 50;
export const MAX_STORE_BYTES = 1024 * 1024 * 1024;
export const MAX_ASSET_NAME_CHARS = 80;
export const SNIFF_BYTES = 64;
// The Python ingest's own wall caps are 20 s (image) and 60 s (audio); these are the backstop.
const INGEST_TIMEOUT_MS = Object.freeze({ logo: 30_000, music: 90_000 });
// Room for the normalised output beside the quarantined upload (a 1024² RGBA PNG; 15 min of
// AAC 192k + peaks), reserved together with the upload's own length.
const OUTPUT_RESERVE_BYTES = Object.freeze({ logo: 5 * 1024 * 1024, music: 24 * 1024 * 1024 });
const MAX_CONCURRENT_INGESTS = 2;
// A refusal made after the session checks reads at most this much of the body first (drain).
const MAX_DRAIN_BYTES = 64 * 1024 * 1024;
const SHA = /^[0-9a-f]{64}$/;
const STORE_FILE = /^([0-9a-f]{64})\.(png|m4a|json|peaks\.bin)$/;
const REASONS = new Set(["empty", "dimensions", "duration", "short", "streams", "channels", "codec", "probe", "decode", "timeout"]);
const DTO_KEYS = ["durationMs", "h", "kind", "lufsC", "mime", "name", "sha256", "w"];

export const ASSET_MESSAGES = Object.freeze({
  invalid_request: "Permintaan tidak valid",
  csrf_rejected: "Permintaan ditolak karena tidak berasal dari halaman ini; muat ulang halaman",
  editor_disabled: "Editor belum diaktifkan",
  uploads_disabled: "Unggahan logo dan musik belum diaktifkan",
  not_found: "Data tidak ditemukan",
  rate_limited: "Terlalu banyak unggahan; tunggu sebentar lalu coba lagi",
  length_required: "Ukuran file tidak diketahui; unggah ulang",
  asset_empty: "File kosong",
  asset_type_unsupported: "Jenis file tidak didukung. Logo: PNG, JPEG atau WebP. Musik: MP3, M4A, WAV, OGG atau FLAC.",
  asset_too_large: "File terlalu besar (logo maksimal 10 MB, musik maksimal 50 MB)",
  asset_rejected: "File tidak bisa dibaca atau tidak aman diproses; simpan ulang file-nya lalu unggah lagi",
  asset_quota_exceeded: "Batas file untuk job ini tercapai (maksimal 50 file dan 1 GB)",
  idempotency_conflict: "Unggahan ganda dengan isi yang berbeda; coba lagi",
  storage_quota_exhausted: "Penyimpanan server tidak cukup",
  storage_free_space_low: "Penyimpanan server tidak cukup",
  storage_admission_unavailable: "Pemeriksaan penyimpanan tidak tersedia",
  backend_unavailable: "Layanan unggah sedang tidak tersedia; coba lagi sebentar lagi",
});

export class UploadRequestError extends Error {
  constructor(status, code) {
    super(`upload ${status} ${code}`);
    this.name = "UploadRequestError";
    this.status = status;
    this.code = code;
  }
}

const refuse = (status, code) => { throw new UploadRequestError(status, code); };

export function uploadsEnabled(env = process.env) {
  return env?.POTONGIN_EDITOR_UPLOADS === "on";
}

// --- shared rules (tests/test_edit_v2_assets.py holds the same vectors) ---------------------------

const HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1", "avif", "avis", "heif"]);
const ascii = (bytes, start, end) => String.fromCharCode(...bytes.subarray(start, end));

function id3(head) {
  return head.length >= 10 && ascii(head, 0, 3) === "ID3" && [2, 3, 4].includes(head[3]) && head[4] !== 0xff
    && [6, 7, 8, 9].every((index) => head[index] < 0x80);
}

function mpegLayer3(head) {
  if (head.length < 4 || head[0] !== 0xff || (head[1] & 0xe0) !== 0xe0) return false;
  const version = (head[1] >> 3) & 3;
  const layer = (head[1] >> 1) & 3;
  const bitrate = head[2] >> 4;
  const rate = (head[2] >> 2) & 3;
  return version !== 1 && layer === 1 && bitrate >= 1 && bitrate <= 14 && rate !== 3;
}

/** The format of a file from its first 64 bytes, or null (plan §9.2 "Sniff"). */
export function sniffAsset(bytes) {
  const head = bytes.subarray(0, SNIFF_BYTES);
  const n = head.length;
  if (n >= 16 && head[0] === 0x89 && ascii(head, 1, 8) === "PNG\r\n\x1a\n" && ascii(head, 12, 16) === "IHDR") return "png";
  if (n >= 4 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff && head[3] >= 0xc0 && head[3] <= 0xfe) return "jpeg";
  if (n >= 16 && ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP" && ["VP8 ", "VP8L", "VP8X"].includes(ascii(head, 12, 16))) return "webp";
  if (n >= 12 && ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WAVE") return "wav";
  if (n >= 12 && ascii(head, 4, 8) === "ftyp") {
    const size = ((head[0] << 24) >>> 0) + (head[1] << 16) + (head[2] << 8) + head[3];
    if (size >= 12 && size <= 1024 && !HEIF_BRANDS.has(ascii(head, 8, 12))) return "mp4";
  }
  if (n >= 5 && ascii(head, 0, 4) === "OggS" && head[4] === 0) return "ogg";
  if (n >= 4 && ascii(head, 0, 4) === "fLaC") return "flac";
  if (id3(head) || mpegLayer3(head)) return "mp3";
  return null;
}

/**
 * The display name: the last path segment, NFC, outer spaces removed; null when empty.
 * Throws UploadRequestError(400) for a Cc/Cs character anywhere or more than 80 code points.
 * `edit_v2.assets.normalise_name` applies the same rule.
 */
export function normaliseAssetName(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || /[\p{Cc}\p{Cs}]/u.test(value)) refuse(400, "invalid_request");
  const segments = value.split(/[/\\]/);
  const base = segments[segments.length - 1].normalize("NFC").replace(/^ +| +$/g, "");
  if (base === "" || base === "." || base === "..") return null;
  if ([...base].length > MAX_ASSET_NAME_CHARS) refuse(400, "invalid_request");
  return base;
}

/** `X-Asset-Name` (percent-encoded UTF-8) → the display name, or null when absent. */
export function decodeAssetNameHeader(value) {
  if (value === null || value === undefined) return null;
  if (value.length > 3 * 4 * MAX_ASSET_NAME_CHARS * 2) refuse(400, "invalid_request");
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { refuse(400, "invalid_request"); }
  return normaliseAssetName(decoded);
}

/** The transport headers of an upload (plan §9.2 "Transport"); throws UploadRequestError. */
export function parseUploadRequest(headers) {
  const kind = headers.get("x-asset-kind");
  if (typeof kind !== "string" || !Object.hasOwn(ASSET_KINDS, kind)) refuse(400, "invalid_request");
  const rules = ASSET_KINDS[kind];
  const mime = (headers.get("content-type") || "").trim().toLowerCase();
  if (!rules.types.includes(mime)) refuse(415, "asset_type_unsupported");
  const idempotencyKey = headers.get("idempotency-key");
  if (!isIdempotencyKey(idempotencyKey)) refuse(400, "invalid_request");
  const declared = headers.get("content-length");
  if (declared === null) refuse(411, "length_required");
  if (!/^\d{1,15}$/.test(declared)) refuse(400, "invalid_request");
  const length = Number(declared);
  if (length === 0) refuse(400, "asset_empty");
  if (length > rules.maxBytes) refuse(413, "asset_too_large");
  const name = decodeAssetNameHeader(headers.get("x-asset-name"));
  return { kind, mime, format: FORMATS[mime], length, name, idempotencyKey };
}

/** The POST /assets DTO (plan §4.2): the asset object plus `peaksUrl` for music. */
export function assetDto(jobId, asset) {
  return { ...asset, peaksUrl: asset.kind === "music" ? `/api/jobs/${jobId}/assets/${asset.sha256}?part=peaks` : null };
}

function validAsset(value, kind) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(DTO_KEYS)) return false;
  const int = (item, low, high) => Number.isSafeInteger(item) && item >= low && item <= high;
  if (!SHA.test(value.sha256 ?? "") || value.kind !== kind) return false;
  if (!(value.name === null || (typeof value.name === "string" && normaliseSafe(value.name) === value.name))) return false;
  if (kind === "logo") {
    return value.mime === "image/png" && int(value.w, 1, 1024) && int(value.h, 1, 1024)
      && value.durationMs === null && value.lufsC === null;
  }
  return value.mime === "audio/mp4" && value.w === null && value.h === null && int(value.durationMs, 1, 15 * 60_000 + 1000)
    && int(value.lufsC, -100_000, 10_000);
}

function normaliseSafe(value) {
  try { return normaliseAssetName(value); } catch { return undefined; }
}

// --- responses ---------------------------------------------------------------------------------------

function json(body, status, headers = {}) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers } });
}

export function uploadError(code, status, extra = {}, headers = {}) {
  return json({ error: ASSET_MESSAGES[code] ?? ASSET_MESSAGES.invalid_request, code, messageId: `edit.${code}`, ...extra }, status, headers);
}

function storageFailure(error) {
  const code = ["storage_quota_exhausted", "storage_free_space_low"].includes(error?.code) ? error.code : "storage_admission_unavailable";
  return uploadError(code, code === "storage_admission_unavailable" ? 503 : 507);
}

const EXIT3_STATUS = Object.freeze({ asset_type_unsupported: 415, asset_too_large: 413, asset_rejected: 422, asset_quota_exceeded: 409 });

function ingestFailure(result) {
  if (result === null) return uploadError("backend_unavailable", 503);
  const code = typeof result.json?.error?.code === "string" ? result.json.error.code : null;
  if (result.exitCode === 3) {
    const known = Object.hasOwn(EXIT3_STATUS, code) ? code : "asset_rejected";
    const ref = result.json?.error?.ref;
    return uploadError(known, EXIT3_STATUS[known], known === "asset_rejected" && REASONS.has(ref) ? { reason: ref } : {});
  }
  if (result.exitCode === 9) return uploadError("idempotency_conflict", 409);
  if (result.exitCode === 4) return uploadError("not_found", 404);
  return uploadError("backend_unavailable", 503);
}

// --- filesystem --------------------------------------------------------------------------------------

class UnsafePath extends Error {}

async function realDirectory(target) {
  let info;
  try { info = await lstat(/* turbopackIgnore: true */ target); } catch { throw new UnsafePath(); }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new UnsafePath();
  if (await realpath(/* turbopackIgnore: true */ target).catch(() => null) !== target) throw new UnsafePath();
  return target;
}

async function ensureDirectory(target) {
  try { await mkdir(/* turbopackIgnore: true */ target, { mode: 0o700 }); } catch (error) {
    if (error?.code !== "EEXIST") throw new UnsafePath();
  }
  return realDirectory(target);
}

/** `{job, store, incoming}` of a job: every level a real directory; the store levels created 0700. */
export async function assetDirectories(jobsRoot, jobId, { create = false } = {}) {
  if (!isJobId(jobId)) throw new UnsafePath();
  let root;
  try { root = await realpath(path.resolve(/* turbopackIgnore: true */ jobsRoot)); } catch { throw new UnsafePath(); }
  const job = await realDirectory(path.join(root, jobId));
  const analysis = await realDirectory(path.join(job, "analysis"));
  const storePath = path.join(analysis, "assets");
  const store = create ? await ensureDirectory(storePath) : await realDirectory(storePath);
  const incomingPath = path.join(store, ".incoming");
  const incoming = create ? await ensureDirectory(incomingPath) : incomingPath;
  return { job, store, incoming };
}

/** `{count, bytes}` of the job's stored assets (metadata files; bytes of every store file). */
export async function storeUsage(store) {
  let count = 0;
  let bytes = 0;
  for (const entry of await readdir(/* turbopackIgnore: true */ store, { withFileTypes: true })) {
    const match = STORE_FILE.exec(entry.name);
    if (!match || !entry.isFile()) continue;
    if (match[2] === "json") count += 1;
    try { bytes += (await lstat(/* turbopackIgnore: true */ path.join(store, entry.name))).size; } catch { /* raced away */ }
  }
  return { count, bytes };
}

async function writeAll(handle, chunk) {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
    offset += bytesWritten;
  }
}

/**
 * Stream the body into `target` (a new 0600 file), counting and sniffing; throws
 * UploadRequestError. After a sniff mismatch nothing more is written, but the rest of the
 * declared body is still read (and dropped): answering in the middle of an upload would reset
 * the connection, and the browser would report a network error instead of the 415.
 */
async function streamToQuarantine(request, target, { length, format, maxBytes }) {
  if (!request.body || request.bodyUsed) refuse(400, "invalid_request");
  const handle = await open(/* turbopackIgnore: true */ target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const reader = request.body.getReader();
  let total = 0;
  let head = new Uint8Array(0);
  let sniffed = false;
  let mismatch = false;
  const check = () => {
    sniffed = true;
    mismatch = sniffAsset(head) !== format;
  };
  try {
    while (true) {
      let item;
      try { item = await reader.read(); } catch { refuse(400, "invalid_request"); }
      if (item.done) break;
      const chunk = item.value;
      if (!(chunk instanceof Uint8Array)) refuse(400, "invalid_request");
      total += chunk.byteLength;
      if (total > length || total > maxBytes) refuse(413, "asset_too_large");
      if (!sniffed) {
        const joined = new Uint8Array(Math.min(SNIFF_BYTES, head.length + chunk.byteLength));
        joined.set(head);
        joined.set(chunk.subarray(0, joined.length - head.length), head.length);
        head = joined;
        if (head.length >= SNIFF_BYTES) check();
      }
      if (!mismatch) await writeAll(handle, chunk);
    }
    if (!sniffed) check();
    if (mismatch) refuse(415, "asset_type_unsupported");
    if (total !== length) refuse(400, "invalid_request");
  } catch (error) {
    try { await reader.cancel(); } catch { /* the stream is abandoned */ }
    throw error;
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
    await handle.close();
  }
}

/**
 * Read and drop the request body (at most `limit` bytes). Over HTTP, answering while the client
 * is still sending closes the connection and the browser reports a network error instead of
 * the answer, so refusals made after the session checks read the declared body first.
 */
async function drain(request, limit) {
  if (!request.body || request.bodyUsed || !(limit > 0)) return;
  let reader;
  try { reader = request.body.getReader(); } catch { return; }
  let total = 0;
  try {
    while (total <= limit) {
      const { done, value } = await reader.read();
      if (done) return;
      total += value?.byteLength ?? 0;
    }
    await reader.cancel().catch(() => {});
  } catch { /* the client went away */ } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

// --- the concurrency gate and the rate limits ---------------------------------------------------------

const GATE = Symbol.for("potongin.assetIngestGate");
const LIMITS = Symbol.for("potongin.editorRateLimits");

function ingestGate() {
  globalThis[GATE] ??= (() => {
    let running = 0;
    const waiting = [];
    return async (task) => {
      if (running >= MAX_CONCURRENT_INGESTS) await new Promise((resolve) => waiting.push(resolve));
      running += 1;
      try { return await task(); } finally {
        running -= 1;
        waiting.shift()?.();
      }
    };
  })();
  return globalThis[GATE];
}

function sessionToken(request) {
  for (const item of (request.headers.get("cookie") || "").split(";")) {
    const at = item.indexOf("=");
    if (at > 0 && item.slice(0, at).trim() === SESSION_COOKIE) return item.slice(at + 1).trim();
  }
  return "";
}

// --- routes ------------------------------------------------------------------------------------------

export function createAssetUploadRoute(options = {}) {
  const deps = editorDeps(options);
  const limits = options.limits ?? (globalThis[LIMITS] ??= createEditorRateLimits());
  const reserve = options.reserve ?? reserveRenderStorage;
  const release = options.release ?? releaseRenderStorage;
  const randomUUID = options.randomUUID ?? nodeRandomUUID;
  const gate = options.gate ?? ingestGate();

  return {
    async POST(request, { params }) {
      const denied = deps.authorize(request);
      if (denied) return denied;
      if (!isEditorEnabled(deps.env)) return uploadError("editor_disabled", 404);
      if (!uploadsEnabled(deps.env)) return uploadError("uploads_disabled", 404);
      if (!sameOriginMutation(request)) return uploadError("csrf_rejected", 403);
      const jobId = (await params)?.id;
      if (!isJobId(jobId)) return uploadError("invalid_request", 400);
      const verdict = limits.check("upload", { sessionToken: sessionToken(request) || "anonymous" });
      if (!verdict.allowed) {
        return uploadError("rate_limited", 429, {}, { "Retry-After": String(Math.max(1, Math.ceil(verdict.retryAfterMs / 1000))) });
      }
      // From here on the caller is a signed-in page of this origin: a refusal reads the declared
      // body first (at most MAX_DRAIN_BYTES), so the browser gets the answer, not a reset.
      const declared = request.headers.get("content-length");
      const drainable = /^\d{1,15}$/.test(declared ?? "") && Number(declared) <= MAX_DRAIN_BYTES ? Number(declared) : 0;
      const refused = async (response) => {
        await drain(request, drainable);
        return response;
      };
      let upload;
      try { upload = parseUploadRequest(request.headers); } catch (error) {
        if (error instanceof UploadRequestError) return refused(uploadError(error.code, error.status));
        return refused(uploadError("invalid_request", 400));
      }
      let directories; // the job and its analysis directory must exist; only the store is created
      try { directories = await assetDirectories(deps.jobsRoot, jobId, { create: true }); } catch {
        return refused(uploadError("not_found", 404));
      }
      let usage;
      try { usage = await storeUsage(directories.store); } catch {
        return refused(uploadError("backend_unavailable", 503));
      }
      if (usage.count >= MAX_ASSETS_PER_JOB || usage.bytes >= MAX_STORE_BYTES) return refused(uploadError("asset_quota_exceeded", 409));

      let reservation;
      try {
        const storageConfig = options.storageConfig ?? parseStorageAdmissionConfig(deps.env);
        reservation = await reserve(deps.jobsRoot, {
          reservationId: randomUUID(), jobId, storageConfig, storageOps: options.storageOps,
          declaredBytes: BigInt(upload.length + OUTPUT_RESERVE_BYTES[upload.kind]),
        });
      } catch (error) {
        return refused(storageFailure(error));
      }
      const incomingId = randomUUID();
      const target = path.join(directories.incoming, incomingId);
      let terminal = "failed";
      try {
        try {
          await streamToQuarantine(request, target, { length: upload.length, format: upload.format, maxBytes: ASSET_KINDS[upload.kind].maxBytes });
        } catch (error) {
          if (error instanceof UploadRequestError) return uploadError(error.code, error.status);
          return uploadError("invalid_request", 400);
        }
        const result = await gate(() => callCli(deps, ASSET_MODULE, "ingest", {
          jobId, incomingId, kind: upload.kind, mime: upload.mime, name: upload.name, idempotencyKey: upload.idempotencyKey,
        }, { timeoutMs: INGEST_TIMEOUT_MS[upload.kind] }));
        if (result?.exitCode !== 0) return ingestFailure(result);
        const { asset, created } = result.json;
        if (!validAsset(asset, upload.kind) || typeof created !== "boolean") return uploadError("backend_unavailable", 503);
        terminal = "completed";
        return json(assetDto(jobId, asset), created ? 201 : 200);
      } finally {
        await unlink(/* turbopackIgnore: true */ target).catch(() => {});
        await release(deps.jobsRoot, reservation.reservationId, reservation.token, terminal).catch(() => false);
      }
    },
  };
}

class AssetNotFound extends Error {}

function contained(parent, target) {
  const relative = path.relative(parent, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function openStoreFile(store, name, options = {}) {
  const resolveFdPath = options.resolveFdPath || ((fd) => realpath(`/proc/self/fd/${fd}`));
  let handle;
  try {
    handle = await open(/* turbopackIgnore: true */ path.join(store, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    const opened = await resolveFdPath(handle.fd);
    if (!info.isFile() || !Number.isSafeInteger(info.size) || !contained(store, opened)) throw new AssetNotFound();
    return { handle, size: info.size };
  } catch {
    await handle?.close().catch(() => {});
    throw new AssetNotFound();
  }
}

async function readMeta(store, sha) {
  const opened = await openStoreFile(store, `${sha}.json`);
  try {
    if (opened.size > 64 * 1024) throw new AssetNotFound();
    const meta = JSON.parse(await opened.handle.readFile("utf8"));
    if (!meta || typeof meta !== "object" || !["image", "audio"].includes(meta.kind)) throw new AssetNotFound();
    return meta;
  } catch {
    throw new AssetNotFound();
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

function metaAsset(sha, meta) {
  const image = meta.kind === "image";
  const name = typeof meta.name === "string" ? meta.name : null;
  return {
    sha256: sha, kind: image ? "logo" : "music", mime: meta.mime, w: image ? meta.w : null, h: image ? meta.h : null,
    durationMs: image ? null : meta.duration_ms, lufsC: image ? null : meta.lufs_c, name,
  };
}

function notFound() {
  return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Type": "text/plain; charset=utf-8" } });
}

const SERVED_HEADERS = { "Content-Security-Policy": "default-src 'none'; sandbox" };

export function createAssetFileRoute(options = {}) {
  const deps = editorDeps(options);

  async function serve(request, { params }, head) {
    const denied = deps.authorize(request);
    if (denied) return denied;
    if (!isEditorEnabled(deps.env)) return uploadError("editor_disabled", 404);
    const resolved = await params;
    const jobId = resolved?.id;
    const sha = resolved?.sha;
    if (!isJobId(jobId) || typeof sha !== "string" || !SHA.test(sha)) return uploadError("invalid_request", 400);
    const part = new URL(request.url).searchParams.get("part");
    if (part !== null && part !== "peaks" && part !== "meta") return uploadError("invalid_request", 400);
    let store;
    let meta;
    try {
      ({ store } = await assetDirectories(deps.jobsRoot, jobId));
      meta = await readMeta(store, sha);
    } catch {
      return notFound();
    }
    const asset = metaAsset(sha, meta);
    if (part === "meta") {
      return Response.json(assetDto(jobId, asset), { headers: { "Cache-Control": IMMUTABLE, "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin" } });
    }
    if (part === "peaks" && meta.kind !== "audio") return notFound();
    const file = part === "peaks" ? { name: `${sha}.peaks.bin`, type: "application/octet-stream", download: "asset.peaks.bin" }
      : meta.kind === "image" ? { name: `${sha}.png`, type: "image/png", download: "asset.png" }
        : { name: `${sha}.m4a`, type: "audio/mp4", download: "asset.m4a" };
    let opened;
    try { opened = await openStoreFile(store, file.name); } catch { return notFound(); }
    return openedFileResponse(request, opened, {
      type: file.type, cacheControl: IMMUTABLE, head,
      extraHeaders: { ...SERVED_HEADERS, "Content-Disposition": `inline; filename="${file.download}"`, ETag: `"${sha}"` },
    });
  }

  return {
    GET: (request, context) => serve(request, context, false),
    HEAD: (request, context) => serve(request, context, true),
  };
}
