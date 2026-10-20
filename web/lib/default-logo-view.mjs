// The Pengaturan "Logo bawaan" card, DOM-free: the state from GET /api/settings/logo, its copy
// and its messages (web/lib/default-logo.mjs is the server side).
import { LOGO_ACCEPT, logoUploadError } from "../components/editor/gizmos/logo-upload.mjs";

// What the editor's Logo panel accepts, so a logo that works there works here.
export const DEFAULT_LOGO_ACCEPT = LOGO_ACCEPT;

const SHA = /^[0-9a-f]{64}$/;
const side = (value) => Number.isSafeInteger(value) && value >= 1 && value <= 1024;

function validLogo(logo) {
  return Boolean(logo) && typeof logo === "object" && SHA.test(logo.sha256 ?? "") && side(logo.w) && side(logo.h)
    && logo.url === `/api/settings/logo/${logo.sha256}` && (logo.name === null || typeof logo.name === "string");
}

/** `{logo, enabled, autoClips}` from the GET answer; anything malformed reads as no logo. */
export function defaultLogoState(payload) {
  return {
    logo: validLogo(payload?.logo) ? payload.logo : null,
    enabled: payload?.enabled === true,
    autoClips: payload?.autoClips === true,
  };
}

/** The card's text. `autoClips`: the automatic clips render with the editor's engine. */
export function defaultLogoCopy({ autoClips = false } = {}) {
  return {
    where: "Dipasang otomatis di setiap klip baru, di pojok kanan atas. Klip yang sudah ada tidak berubah.",
    reach: autoClips
      ? "Ikut di file klip otomatis dan saat klip dibuka di editor."
      : "Dipakai saat klip dibuka di editor dan ikut di hasil ekspornya. File klip otomatis tetap tanpa logo.",
    perClip: "Per klip bisa diganti atau dihapus di panel Logo editor.",
    hint: "PNG, JPEG, atau WebP, maksimal 10 MB. PNG berlatar transparan hasilnya paling rapi.",
  };
}

/** The message of a failed upload (`cancelled`: the person stopped it, not an error). */
export function defaultLogoUploadError(error) {
  if (error?.code === "settings_unavailable") {
    return { code: error.code, cancelled: false, message: "Folder pengaturan di server belum bisa dipakai." };
  }
  if (error?.code === "unauthorized" || error?.status === 401) {
    return { code: "unauthorized", cancelled: false, message: "Sesi login berakhir. Muat ulang halaman untuk masuk lagi." };
  }
  return logoUploadError(error);
}

/** "300 × 100 px". */
export function logoSize(logo) {
  return `${logo.w} × ${logo.h} px`;
}
