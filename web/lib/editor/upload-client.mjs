// Browser upload helper of the Editor V3 asset store (plan §9.2, Appendix A.2 `uploadAsset`;
// T3.1). Used by the Logo (T3.2) and Musik (T3.3) panels.
//
// `uploadAsset(jobId, file, kind, { onProgress, signal, key })` sends the file itself as the raw
// body of `POST /api/jobs/:id/assets` (no multipart) through XMLHttpRequest, the one browser API
// that reports upload progress. Before a byte is sent it maps the browser's type (and the
// extension when the browser gives none) to the server's allowlist and checks the size cap, so
// the common mistakes never cost an upload. Headers: `Content-Type` (canonical), `X-Asset-Kind`,
// `Idempotency-Key` (one per call; pass `key` to retry the same upload), `X-Asset-Name` (the
// display name, NFC, ≤ 80 code points, percent-encoded because header values are ASCII).
//
// `onProgress(fraction, {phase})`: `phase` "upload" while bytes go out, then once
// `(1, {phase: "processing"})` while the server normalises the file (a few seconds for music).
// Resolves with the DTO `{sha256, kind, mime, w, h, durationMs, lufsC, peaksUrl, name}`; rejects
// with `UploadError {status, code, reason, message}` (an Indonesian message for the panel; status
// 0 = the network failed) or a DOMException "AbortError".

import { randomUuid as defaultRandomUuid } from "./api-client.mjs";

// The server's rules (web/lib/asset-upload.mjs ASSET_KINDS; equal by test).
export const UPLOAD_RULES = Object.freeze({
  logo: Object.freeze({ types: Object.freeze(["image/png", "image/jpeg", "image/webp"]), maxBytes: 10 * 1024 * 1024 }),
  music: Object.freeze({ types: Object.freeze(["audio/mpeg", "audio/mp4", "audio/wav", "audio/ogg", "audio/flac"]), maxBytes: 50 * 1024 * 1024 }),
});
export const MAX_NAME_CHARS = 80;

// What browsers report for the same files (Chrome on Windows says audio/x-m4a, Firefox
// audio/x-wav, …) → the allowlisted type. Unknown types are not guessed.
const TYPE_ALIASES = Object.freeze({
  "image/png": "image/png", "image/x-png": "image/png",
  "image/jpeg": "image/jpeg", "image/jpg": "image/jpeg", "image/pjpeg": "image/jpeg",
  "image/webp": "image/webp",
  "audio/mpeg": "audio/mpeg", "audio/mp3": "audio/mpeg", "audio/mpeg3": "audio/mpeg", "audio/x-mpeg": "audio/mpeg",
  "audio/x-mp3": "audio/mpeg",
  "audio/mp4": "audio/mp4", "audio/x-m4a": "audio/mp4", "audio/m4a": "audio/mp4", "video/mp4": "audio/mp4",
  "audio/wav": "audio/wav", "audio/x-wav": "audio/wav", "audio/wave": "audio/wav", "audio/vnd.wave": "audio/wav",
  "audio/ogg": "audio/ogg", "application/ogg": "audio/ogg", "audio/opus": "audio/ogg",
  "audio/flac": "audio/flac", "audio/x-flac": "audio/flac",
});
const EXTENSION_TYPES = Object.freeze({
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", jpe: "image/jpeg", webp: "image/webp",
  mp3: "audio/mpeg", m4a: "audio/mp4", mp4: "audio/mp4", wav: "audio/wav", wave: "audio/wav",
  ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", flac: "audio/flac",
});

const MESSAGES = Object.freeze({
  invalid_request: "Permintaan tidak valid",
  asset_empty: "File kosong",
  asset_type_unsupported: "Jenis file tidak didukung. Logo: PNG, JPEG atau WebP. Musik: MP3, M4A, WAV, OGG atau FLAC.",
  asset_too_large: "File terlalu besar (logo maksimal 10 MB, musik maksimal 50 MB)",
  asset_rejected: "File tidak bisa dibaca atau tidak aman diproses; simpan ulang file-nya lalu unggah lagi",
  asset_quota_exceeded: "Batas file untuk job ini tercapai (maksimal 50 file dan 1 GB)",
  uploads_disabled: "Unggahan logo dan musik belum diaktifkan",
  editor_disabled: "Editor V3 belum diaktifkan",
  rate_limited: "Terlalu banyak unggahan; tunggu sebentar lalu coba lagi",
  csrf_rejected: "Permintaan ditolak karena tidak berasal dari halaman ini; muat ulang halaman",
  length_required: "Ukuran file tidak diketahui; unggah ulang",
  idempotency_conflict: "Unggahan ganda dengan isi yang berbeda; coba lagi",
  not_found: "Job tidak ditemukan",
  unauthorized: "Sesi login berakhir; masuk lagi lalu unggah ulang",
  storage_quota_exhausted: "Penyimpanan server tidak cukup",
  storage_free_space_low: "Penyimpanan server tidak cukup",
  storage_admission_unavailable: "Layanan unggah sedang tidak tersedia; coba lagi sebentar lagi",
  backend_unavailable: "Layanan unggah sedang tidak tersedia; coba lagi sebentar lagi",
  network_error: "Koneksi terputus saat mengunggah; coba lagi",
  invalid_response: "Jawaban server tidak dikenali; coba lagi",
});
const REASON_MESSAGES = Object.freeze({
  dimensions: "Gambar terlalu besar (maksimal 4096 × 4096 piksel)",
  duration: "Musik terlalu panjang (maksimal 15 menit)",
  short: "Musik terlalu pendek",
  channels: "Musik harus mono atau stereo",
  streams: "File musik harus berisi satu trek audio tanpa video",
  timeout: "File terlalu lama diproses; coba file yang lebih kecil",
});
const DEFAULT_MESSAGE = "Unggahan gagal; coba lagi";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;

/** The Indonesian message of an upload error code (and `asset_rejected` reason). */
export function uploadMessage(code, reason = null) {
  if (code === "asset_rejected" && typeof reason === "string" && Object.hasOwn(REASON_MESSAGES, reason)) return REASON_MESSAGES[reason];
  return Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : DEFAULT_MESSAGE;
}

export class UploadError extends Error {
  constructor(status, code, { reason = null, body = null } = {}) {
    super(uploadMessage(code, reason));
    this.name = "UploadError";
    this.status = status;
    this.code = code;
    this.reason = reason;
    this.body = body;
  }
}

function abortError() {
  return new DOMException("Unggahan dibatalkan", "AbortError");
}

/** The allowlisted Content-Type of `file` for `kind`, or null when the server would refuse it. */
export function canonicalType(file, kind) {
  const rules = Object.hasOwn(UPLOAD_RULES, kind) ? UPLOAD_RULES[kind] : null;
  if (!rules) return null;
  const reported = typeof file?.type === "string" ? file.type.trim().toLowerCase() : "";
  let type = null;
  if (reported && reported !== "application/octet-stream") {
    type = Object.hasOwn(TYPE_ALIASES, reported) ? TYPE_ALIASES[reported] : null;
  } else {
    const match = /\.([A-Za-z0-9]{1,5})$/.exec(typeof file?.name === "string" ? file.name : "");
    const extension = match ? match[1].toLowerCase() : "";
    type = Object.hasOwn(EXTENSION_TYPES, extension) ? EXTENSION_TYPES[extension] : null;
  }
  return type && rules.types.includes(type) ? type : null;
}

/** The display name sent as X-Asset-Name: last path segment, controls removed, NFC, ≤ 80. */
export function displayName(name) {
  if (typeof name !== "string") return null;
  const segments = name.split(/[/\\]/);
  const trim = (value) => value.replace(/^ +| +$/g, "");
  let base = trim(segments[segments.length - 1].replace(/[\p{Cc}\p{Cs}]/gu, "").normalize("NFC"));
  let points = [...base];
  if (points.length > MAX_NAME_CHARS) {
    const dot = base.lastIndexOf(".");
    const extension = dot > 0 && base.length - dot <= 10 ? base.slice(dot) : "";
    const stem = [...base.slice(0, base.length - extension.length)];
    base = trim(stem.slice(0, MAX_NAME_CHARS - [...extension].length).join("") + extension);
    points = [...base];
  }
  if (base === "" || base === "." || base === ".." || points.length > MAX_NAME_CHARS) return null;
  return base;
}

/** The URL of a stored asset (`part`: undefined for the bytes, "peaks" or "meta"). */
export function assetUrl(jobId, sha, part, base = "") {
  if (typeof jobId !== "string" || !UUID.test(jobId)) throw new TypeError("jobId is invalid");
  const hex = typeof sha === "string" ? sha.replace(/^sha256:/, "") : "";
  if (!SHA.test(hex)) throw new TypeError("sha is invalid");
  if (part !== undefined && part !== "peaks" && part !== "meta") throw new TypeError("part is invalid");
  return `${base}/api/jobs/${jobId}/assets/${hex}${part ? `?part=${part}` : ""}`;
}

function validDto(body, kind) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const int = (value) => Number.isSafeInteger(value);
  if (typeof body.sha256 !== "string" || !SHA.test(body.sha256) || body.kind !== kind) return false;
  if (!(body.peaksUrl === null || typeof body.peaksUrl === "string")) return false;
  if (kind === "logo") return body.mime === "image/png" && int(body.w) && body.w > 0 && int(body.h) && body.h > 0;
  return body.mime === "audio/mp4" && int(body.durationMs) && body.durationMs > 0 && int(body.lufsC);
}

function responseBody(xhr) {
  const type = (typeof xhr.getResponseHeader === "function" && xhr.getResponseHeader("content-type")) || "";
  if (!/json/i.test(type)) return null;
  try { return JSON.parse(xhr.responseText); } catch { return null; }
}

export function createUploadClient({ xhrFactory = () => new XMLHttpRequest(), base = "", randomUuid = defaultRandomUuid } = {}) {
  async function uploadAsset(jobId, file, kind, { onProgress, signal, key } = {}) {
    if (typeof jobId !== "string" || !UUID.test(jobId)) throw new TypeError("jobId is invalid");
    if (signal?.aborted) throw abortError();
    if (!Object.hasOwn(UPLOAD_RULES, kind)) throw new UploadError(400, "invalid_request");
    const mime = canonicalType(file, kind);
    if (!mime) throw new UploadError(415, "asset_type_unsupported");
    const size = file?.size;
    if (!Number.isSafeInteger(size) || size <= 0) throw new UploadError(400, "asset_empty");
    if (size > UPLOAD_RULES[kind].maxBytes) throw new UploadError(413, "asset_too_large");
    const name = displayName(file?.name);
    const idempotencyKey = typeof key === "string" && UUID.test(key) ? key : randomUuid();
    const progress = typeof onProgress === "function" ? onProgress : () => {};

    return new Promise((resolve, reject) => {
      const xhr = xhrFactory();
      let settled = false;
      const finish = (settle) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        settle();
      };
      function onAbort() {
        try { xhr.abort(); } catch { /* already done */ }
        finish(() => reject(abortError()));
      }
      xhr.open("POST", `${base}/api/jobs/${jobId}/assets`);
      xhr.setRequestHeader("Accept", "application/json");
      xhr.setRequestHeader("Content-Type", mime);
      xhr.setRequestHeader("X-Asset-Kind", kind);
      xhr.setRequestHeader("Idempotency-Key", idempotencyKey);
      if (name) xhr.setRequestHeader("X-Asset-Name", encodeURIComponent(name));
      if (xhr.upload) {
        xhr.upload.onprogress = (event) => {
          if (settled || !event?.lengthComputable || !(event.total > 0)) return;
          progress(Math.min(1, event.loaded / event.total), { phase: "upload", loaded: event.loaded, total: event.total });
        };
        xhr.upload.onload = () => { if (!settled) progress(1, { phase: "processing" }); };
      }
      xhr.onerror = () => finish(() => reject(new UploadError(0, "network_error")));
      xhr.ontimeout = () => finish(() => reject(new UploadError(0, "network_error")));
      xhr.onabort = () => finish(() => reject(abortError()));
      xhr.onload = () => finish(() => {
        const status = xhr.status;
        const body = responseBody(xhr);
        if (status >= 200 && status < 300) {
          if (validDto(body, kind)) resolve(body);
          else reject(new UploadError(status, "invalid_response"));
          return;
        }
        const code = typeof body?.code === "string" ? body.code
          : typeof body?.error?.code === "string" ? body.error.code
            : status === 401 ? "unauthorized" : `http_${status}`;
        const reason = typeof body?.reason === "string" && Object.hasOwn(REASON_MESSAGES, body.reason) ? body.reason : null;
        reject(new UploadError(status, code, { reason, body }));
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      xhr.send(file);
    });
  }
  return { uploadAsset };
}

let defaultClient = null;

/** Appendix A.2: `uploadAsset(jobId, file, kind, { onProgress, signal })` with the page's XHR. */
export function uploadAsset(jobId, file, kind, options = {}) {
  defaultClient ??= createUploadClient();
  return defaultClient.uploadAsset(jobId, file, kind, options);
}
