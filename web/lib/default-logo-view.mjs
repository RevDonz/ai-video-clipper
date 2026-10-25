// The Pengaturan "Logo" card (tab Tampilan), DOM-free: the state from GET /api/settings/logo and
// its messages as descriptors `{ key, values? }` under the "settings" namespace (rombak 07 §8.3).
// A refusal named by the editor's logo upload keeps its `message` until the editor moves to the
// catalog (Fase 11). web/lib/default-logo.mjs is the server side.
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

/** The facts under the card. `autoClips`: the automatic clips render with the editor's engine. */
export function defaultLogoCopy({ autoClips = false } = {}) {
  return {
    reach: { key: autoClips ? "appearance.logoReach.auto" : "appearance.logoReach.editor" },
    perClip: { key: "appearance.logoPerClip" },
    hint: { key: "appearance.logoHint" },
  };
}

/** A failed upload: `{ code, cancelled, key }` from the catalog, or the upload's own `message`. */
export function defaultLogoUploadError(error) {
  if (error?.code === "settings_unavailable") {
    return { code: error.code, cancelled: false, key: "common.error.settingsUnavailable" };
  }
  if (error?.code === "unauthorized" || error?.status === 401) {
    return { code: "unauthorized", cancelled: false, key: "common.error.session" };
  }
  return logoUploadError(error);
}

/** "300 × 100 px". */
export function logoSize(logo) {
  return { key: "appearance.logoSize", values: { w: logo.w, h: logo.h } };
}

/** Every key this module can name, for the catalog test and the card's lookup. */
export const DEFAULT_LOGO_VIEW_KEYS = Object.freeze([
  "appearance.logoReach.auto",
  "appearance.logoReach.editor",
  "appearance.logoPerClip",
  "appearance.logoHint",
  "appearance.logoSize",
  "common.error.settingsUnavailable",
  "common.error.session",
]);
