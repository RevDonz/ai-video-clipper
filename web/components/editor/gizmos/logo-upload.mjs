// The Logo panel's side of uploads (plan §9.2, Appendix A.2 `uploadAsset`, T3.1's
// web/lib/editor/upload-client.mjs): which client uploads, the running upload (it outlives the
// panel), the panel's messages for upload errors, and the URL of a stored asset.
//
// The client is the panel's `uploadAsset` prop when the shell passes one; otherwise the one
// registered here (`provideLogoUploader`), which the specs use for the fake. Neither: the panel
// says uploads are not available, and a logo already in the document can still be placed.

export const LOGO_TYPES = Object.freeze(["image/png", "image/jpeg", "image/webp"]);
export const LOGO_MAX_BYTES = 10 * 1024 * 1024;
export const LOGO_ACCEPT = "image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp";

let registered = null;

/** Registers the upload function; returns the function that unregisters it. */
export function provideLogoUploader(uploadAsset) {
  if (typeof uploadAsset !== "function") throw new TypeError("uploadAsset must be a function");
  registered = uploadAsset;
  return () => {
    if (registered === uploadAsset) registered = null;
  };
}

export function logoUploader() {
  return registered;
}

// Codes whose logo-specific wording is clearer than the shared upload message.
const LOGO_MESSAGES = Object.freeze({
  asset_type_unsupported: "Format ini tidak didukung. Pakai PNG, JPEG, atau WebP.",
  asset_too_large: "File terlalu besar. Logo maksimal 10 MB.",
  asset_empty: "File ini kosong. Pilih file logo yang lain.",
  asset_rejected: "Gambar ini tidak bisa dibaca atau tidak aman diproses. Simpan ulang sebagai PNG, lalu unggah lagi.",
  asset_quota_exceeded: "Batas file proyek ini tercapai (50 file atau 1 GB).",
  uploads_disabled: "Unggah logo belum diaktifkan di server ini.",
  editor_disabled: "Unggah logo belum diaktifkan di server ini.",
  network_error: "Koneksi terputus saat mengunggah. Coba lagi.",
});
const GENERIC = "Logo gagal diunggah. Coba lagi.";
const CANCELLED = "Unggahan dibatalkan.";

/**
 * `{ code, cancelled, message }` for a rejected upload: a cancel is not an error; T3.1's
 * UploadError carries an Indonesian message that is used for codes without a logo wording
 * (an `asset_rejected` reason such as the pixel limit keeps its own message).
 */
export function logoUploadError(error) {
  if (error?.name === "AbortError") return { code: "cancelled", cancelled: true, message: CANCELLED };
  if (error instanceof TypeError) return { code: "network_error", cancelled: false, message: LOGO_MESSAGES.network_error };
  const code = typeof error?.code === "string" ? error.code : "upload_failed";
  const own = error?.name === "UploadError" && typeof error.message === "string" && error.message.trim() ? error.message : null;
  if (code === "asset_rejected" && error?.reason && own) return { code, cancelled: false, message: own };
  if (Object.hasOwn(LOGO_MESSAGES, code)) return { code, cancelled: false, message: LOGO_MESSAGES[code] };
  return { code, cancelled: false, message: own ?? GENERIC };
}

/**
 * The page's logo upload, outside the panel: switching tabs unmounts the panel, and an upload must
 * not stop because of that. One upload at a time; a new one replaces (aborts) the running one.
 * State: `{ progress: { owner, name, fraction, phase } | null, message: { owner, tone, text } | null,
 * names: { [assetId]: file name } }`; `owner` names the clip the upload belongs to.
 */
export function createLogoUploads() {
  let state = Object.freeze({ progress: null, message: null, names: Object.freeze({}) });
  let running = null;
  const listeners = new Set();
  const set = (patch) => {
    state = Object.freeze({ ...state, ...patch });
    for (const listener of [...listeners]) listener();
  };
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clearMessage() {
      if (state.message) set({ message: null });
    },
    setMessage(owner, tone, text) {
      set({ message: { owner, tone, text } });
    },
    cancel() {
      running?.abort();
    },
    /** Uploads `file`; `onUploaded(dto)` applies it and returns a message string if that failed. */
    async start({ owner, upload, jobId, file, onUploaded }) {
      running?.abort();
      const controller = new AbortController();
      running = controller;
      set({ message: null, progress: { owner, name: file.name, fraction: 0, phase: "upload" } });
      const mine = () => running === controller;
      try {
        const dto = await upload(jobId, file, "logo", {
          signal: controller.signal,
          onProgress: (fraction, info) => {
            if (!mine()) return;
            const value = Math.max(0, Math.min(1, Number(fraction) || 0));
            set({ progress: { owner, name: file.name, fraction: value, phase: info?.phase === "processing" ? "processing" : "upload" } });
          },
        });
        if (!mine()) return;
        running = null;
        const answer = onUploaded(dto);
        const refused = typeof answer === "string" && answer ? answer : null;
        set({
          progress: null,
          message: refused ? { owner, tone: "error", text: refused } : null,
          names: refused ? state.names : Object.freeze({ ...state.names, [`sha256:${dto.sha256}`]: dto.name ?? file.name }),
        });
      } catch (error) {
        if (!mine()) return;
        running = null;
        const mapped = logoUploadError(error);
        set({ progress: null, message: { owner, tone: mapped.cancelled ? "info" : "error", text: mapped.message } });
      }
    },
  };
}

export const logoUploads = createLogoUploads();

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^(?:sha256:)?([0-9a-f]{64})$/;

/** `GET /api/jobs/:id/assets/:sha` (plan §4.2), the normalised PNG; null for a bad id. */
export function assetThumbUrl(jobId, assetId) {
  const match = typeof assetId === "string" ? SHA.exec(assetId) : null;
  if (typeof jobId !== "string" || !JOB_ID.test(jobId) || !match) return null;
  return `/api/jobs/${jobId}/assets/${match[1]}`;
}
