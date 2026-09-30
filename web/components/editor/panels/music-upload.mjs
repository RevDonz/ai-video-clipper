// How the Musik panel uploads (Appendix A.2 `uploadAsset(jobId, file, kind, { onProgress, signal })`).
//
// - Fake editor runtime (POTONGIN_EDITOR_FAKES, the e2e specs): the fakes' upload client, or a
//   scenario's `uploadAsset`; nothing leaves the page.
// - Real editor: `POST /api/jobs/:id/assets` (plan §4.2, §9.2) with the raw file as the body. This
//   is the same contract as T3.1's web/lib/editor/upload-client.mjs; the W3 integrator points the
//   real branch at that module when it merges (docs/editor/GATES.md, T3.3 requests).
import { musicFileType } from "./music-model.mjs";

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KINDS = new Set(["logo", "music"]);
const PRINTABLE_ASCII = /^[\x20-\x7e]{1,80}$/;

export class UploadError extends Error {
  constructor(status, code) {
    super(`upload failed: ${status} ${code}`);
    this.name = "UploadError";
    this.status = status;
    this.code = code;
  }
}

function abortError() {
  const error = new Error("upload aborted");
  error.name = "AbortError";
  return error;
}

function uuid() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function errorCode(text) {
  try {
    const body = JSON.parse(text);
    const code = body?.error?.code ?? body?.code;
    return typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : "upload_failed";
  } catch {
    return "upload_failed";
  }
}

/**
 * The §4.2 upload over XMLHttpRequest (fetch has no upload progress). Resolves with the 201 DTO
 * `{sha256, kind, mime, w, h, durationMs, lufsC, peaksUrl}`; rejects with UploadError (status,
 * code) or an AbortError.
 */
export function httpUploadAsset(jobId, file, kind, { onProgress = () => {}, signal, xhrFactory } = {}) {
  if (!JOB_ID.test(String(jobId))) return Promise.reject(new TypeError("invalid job id"));
  if (!KINDS.has(kind)) return Promise.reject(new TypeError("invalid asset kind"));
  if (signal?.aborted) return Promise.reject(abortError());
  const create = xhrFactory ?? (() => new XMLHttpRequest());
  return new Promise((resolve, reject) => {
    const xhr = create();
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.("abort", onAbort);
      fn(value);
    };
    const onAbort = () => {
      xhr.abort();
      finish(reject, abortError());
    };
    xhr.open("POST", `/api/jobs/${jobId}/assets`);
    xhr.setRequestHeader("Content-Type", kind === "music" ? musicFileType(file) ?? "application/octet-stream" : file.type);
    xhr.setRequestHeader("X-Asset-Kind", kind);
    xhr.setRequestHeader("Idempotency-Key", uuid());
    const name = typeof file?.name === "string" ? file.name.normalize("NFC") : "";
    if (PRINTABLE_ASCII.test(name)) xhr.setRequestHeader("X-Asset-Name", name); // display only; header values are Latin-1
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(Math.min(1, event.loaded / event.total));
    };
    xhr.onload = () => {
      if (xhr.status === 201 || xhr.status === 200) {
        try {
          onProgress(1);
          finish(resolve, JSON.parse(xhr.responseText));
        } catch {
          finish(reject, new UploadError(xhr.status, "invalid_response"));
        }
        return;
      }
      finish(reject, new UploadError(xhr.status, errorCode(xhr.responseText)));
    };
    xhr.onerror = () => finish(reject, new UploadError(0, "network"));
    xhr.onabort = () => finish(reject, abortError());
    signal?.addEventListener?.("abort", onAbort, { once: true });
    xhr.send(file);
  });
}

let fakeClient = null;

/** The upload function for the page the panel runs in (see the header). */
export async function resolveUploadAsset(win = globalThis.window) {
  if (win && win.__potonginEditor) {
    const scripted = win.__potonginEditorScenario?.uploadAsset;
    if (typeof scripted === "function") return scripted;
    if (!fakeClient) fakeClient = (await import("../__dev__/fakes.mjs")).createFakeUploadClient();
    return (...args) => fakeClient.uploadAsset(...args);
  }
  return httpUploadAsset;
}
