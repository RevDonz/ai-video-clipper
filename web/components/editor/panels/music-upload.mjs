// How music is uploaded (Appendix A.2 `uploadAsset(jobId, file, kind, { onProgress, signal })`).
//
// - Fake editor runtime (POTONGIN_EDITOR_FAKES, the e2e specs): the fakes' upload client, or a
//   scenario's `uploadAsset`; nothing leaves the page.
// - Real editor: `POST /api/jobs/:id/assets` (plan §4.2, §9.2) with the raw file as the body. This
//   is the same contract as T3.1's web/lib/editor/upload-client.mjs; the W3 integrator points the
//   real branch at that module when it merges (docs/editor/GATES.md, T3.3 requests).
// - `musicUploadFor(clipId)`: the running upload of one clip, outside any component
//   (docs/plans/2026-10-02-editor-mode-cepat.md §4.1, AC16). The Logo & Musik card and the Musik
//   panel both start and read it, so closing the card or switching the view never drops it.
// - The per-viewer conveniences both views share: the one-time copyright notice and the file
//   names of uploaded tracks (the document keeps only the asset's sha).
import { FILE_PROBLEM_TEXT, musicCommands, musicFileProblem, musicFileType, uploadErrorText } from "./music-model.mjs";

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

// --- per-viewer conveniences (storage may be missing: private mode, blocked site data) -------------

export const MUSIC_NOTICE_KEY = "potongin-editor-music-notice";
export const MUSIC_NAMES_KEY = "potongin-editor-music-names";
const MAX_NAMES = 50;

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Whether the viewer has read the copyright notice (shown once, in either view). */
export function musicNoticeRead(storage = defaultStorage()) {
  try {
    return storage?.getItem(MUSIC_NOTICE_KEY) === "1";
  } catch {
    return false;
  }
}

export function markMusicNoticeRead(storage = defaultStorage()) {
  try {
    storage?.setItem(MUSIC_NOTICE_KEY, "1");
  } catch {
    // the notice shows again next time
  }
}

/** `{ [assetId]: file name }` of the viewer's uploads; {} when storage is missing or unreadable. */
export function storedMusicNames(storage = defaultStorage()) {
  try {
    const names = JSON.parse(storage?.getItem(MUSIC_NAMES_KEY) || "{}");
    return names && typeof names === "object" && !Array.isArray(names) ? names : {};
  } catch {
    return {};
  }
}

function rememberMusicName(storage, assetId, name) {
  try {
    const names = storedMusicNames(storage);
    delete names[assetId];
    names[assetId] = name;
    const keys = Object.keys(names);
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_NAMES))) delete names[key];
    storage?.setItem(MUSIC_NAMES_KEY, JSON.stringify(names));
  } catch {
    // the card and the panel fall back to "Musik terunggah"
  }
}

// --- the running upload of one clip ------------------------------------------------------------------

const CANCELLED_TEXT = "Unggahan dibatalkan.";
const REFUSED_TEXT = "Perubahan ini tidak bisa diterapkan.";

/**
 * One clip's music upload. State: `{ phase: "idle" | "uploading" | "processing", name, progress,
 * replace, message: { tone: "error" | "info", text } | null, names }`. `start` checks the file,
 * sends it, and applies `SetMusic` (or the replacement, to the document as it is when the file
 * arrives) through the dispatch it was given; one upload at a time.
 */
export function createMusicUpload({ storage = defaultStorage(), resolveUpload = resolveUploadAsset } = {}) {
  const listeners = new Set();
  let state = Object.freeze({ phase: "idle", name: null, progress: 0, replace: false, message: null,
    names: Object.freeze(storedMusicNames(storage)) });
  let controller = null;

  const set = (patch) => {
    state = Object.freeze({ ...state, ...patch });
    for (const listener of [...listeners]) listener(state);
  };
  const busy = () => state.phase !== "idle";

  async function start({ file, jobId, upload = null, dispatch, getState, replace = false } = {}) {
    if (busy() || !file) return false;
    const problem = musicFileProblem(file);
    if (problem) {
      set({ message: { tone: "error", text: FILE_PROBLEM_TEXT[problem] } });
      return false;
    }
    const type = musicFileType(file);
    const body = file.type === type || typeof File !== "function" ? file : new File([file], file.name, { type });
    const mine = new AbortController();
    controller = mine;
    set({ phase: "uploading", name: file.name, progress: 0, replace, message: null });
    try {
      const send = upload ?? (await resolveUpload());
      const dto = await send(jobId, body, "music", {
        signal: mine.signal,
        onProgress: (value) => {
          if (controller !== mine) return;
          const progress = Math.max(0, Math.min(1, Number(value) || 0));
          set({ progress, phase: progress >= 1 ? "processing" : "uploading" });
        },
      });
      const doc = getState?.()?.doc ?? null;
      const commands = replace ? musicCommands.replace(doc, dto) : musicCommands.add(dto);
      for (const { type: command, args, mergeKey } of commands) {
        try {
          dispatch(command, args, { mergeKey });
        } catch (error) {
          set({ phase: "idle", progress: 0, message: { tone: "error", text: error?.message || REFUSED_TEXT } });
          return false;
        }
      }
      const assetId = `sha256:${String(dto.sha256).replace(/^sha256:/, "")}`;
      rememberMusicName(storage, assetId, file.name);
      set({ phase: "idle", progress: 0, message: null, names: Object.freeze({ ...state.names, [assetId]: file.name }) });
      return true;
    } catch (error) {
      const text = uploadErrorText(error);
      set({ phase: "idle", progress: 0, message: text === null ? { tone: "info", text: CANCELLED_TEXT } : { tone: "error", text } });
      return false;
    } finally {
      if (controller === mine) controller = null;
    }
  }

  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    busy,
    start,
    cancel() {
      controller?.abort();
    },
    clearMessage() {
      if (state.message) set({ message: null });
    },
    setMessage(tone, text) {
      set({ message: { tone, text } });
    },
  };
}

const UPLOADS = new Map();

/** The page-lifetime music upload of one clip (null without a clip id). */
export function musicUploadFor(clipId, factory = createMusicUpload) {
  if (typeof clipId !== "string" || !clipId) return null;
  if (!UPLOADS.has(clipId)) UPLOADS.set(clipId, factory());
  return UPLOADS.get(clipId);
}
