// The Pengaturan "YouTube" tab, DOM-free: the state from GET /api/settings/youtube-cookies and the
// tab's messages as descriptors `{ key, values? }` under the "settings" namespace (rombak 07 §8.3).
// The words are in web/messages/<locale>/settings.json; web/lib/youtube-cookies.mjs is the server.

// Equal to MAX_COOKIES_FILE_BYTES on the server (by test); checked before a file goes out.
export const MAX_COOKIES_UPLOAD_BYTES = 1024 * 1024;
export const COOKIES_ACCEPT = ".txt,text/plain";

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PROBLEMS = new Set(["unreadable", "corrupt", "secret_missing"]);

function validCookies(cookies) {
  return Boolean(cookies) && typeof cookies === "object" && Number.isSafeInteger(cookies.count) && cookies.count >= 1
    && typeof cookies.signedIn === "boolean" && typeof cookies.uploadedAt === "string" && ISO_TIME.test(cookies.uploadedAt);
}

/** `{cookies: {count, signedIn, uploadedAt} | null, problem, secretConfigured}` from an answer. */
export function youtubeCookiesState(payload) {
  const cookies = validCookies(payload?.cookies)
    ? { count: payload.cookies.count, signedIn: payload.cookies.signedIn, uploadedAt: payload.cookies.uploadedAt }
    : null;
  return {
    cookies,
    problem: PROBLEMS.has(payload?.problem) ? payload.problem : null,
    secretConfigured: payload?.secretConfigured === true,
  };
}

/** "42 cookie tersimpan". */
export function cookiesCountText(cookies) {
  return { key: "youtube.count", values: { count: cookies.count } };
}

/** "Diunggah 21 Okt 2026, 15.00" (the date formatted by the page), or null for an unreadable date. */
export function cookiesUploadedText(cookies) {
  const date = new Date(cookies?.uploadedAt ?? "");
  if (Number.isNaN(date.getTime())) return null;
  return { key: "youtube.uploaded", values: { at: date } };
}

const ERRORS = Object.freeze({
  cookies_json: "youtube.error.json",
  cookies_utf16: "youtube.error.utf16",
  cookies_not_text: "youtube.error.notText",
  cookies_not_netscape: "youtube.error.notNetscape",
  cookies_empty: "youtube.error.empty",
  cookies_no_youtube: "youtube.error.noYoutube",
  cookies_expired: "youtube.error.expired",
  cookies_too_large: "youtube.error.tooLarge",
  unsupported_media_type: "youtube.error.mediaType",
  secret_missing: "common.error.secretMissing",
  settings_unavailable: "common.error.settingsUnavailable",
  csrf_rejected: "common.error.csrf",
});

/** The message of a refused upload or removal: `{status, code}` from the answer (status 0: offline). */
export function cookiesErrorMessage({ status, code } = {}) {
  if (status === 401) return { key: "common.error.session" };
  if (status === 0) return { key: "common.error.offline" };
  return { key: Object.hasOwn(ERRORS, code) ? ERRORS[code] : "youtube.error.failed" };
}

/** "42 cookie YouTube tersimpan." plus what the check dropped: one descriptor per sentence part. */
export function cookiesSavedMessage({ cookies, skipped }) {
  const dropped = [
    skipped?.otherSites > 0 ? { key: "youtube.dropped.otherSites", values: { count: skipped.otherSites } } : null,
    skipped?.expired > 0 ? { key: "youtube.dropped.expired", values: { count: skipped.expired } } : null,
    skipped?.invalid > 0 ? { key: "youtube.dropped.invalid", values: { count: skipped.invalid } } : null,
  ].filter(Boolean);
  return { saved: { key: "youtube.saved", values: { count: cookies.count } }, dropped };
}

/** Every key this module can name, for the catalog test and the tab's lookup. */
export const YOUTUBE_COOKIES_VIEW_KEYS = Object.freeze([
  "youtube.count",
  "youtube.uploaded",
  "youtube.saved",
  "youtube.dropped.otherSites",
  "youtube.dropped.expired",
  "youtube.dropped.invalid",
  "youtube.error.failed",
  "common.error.session",
  "common.error.offline",
  ...new Set(Object.values(ERRORS)),
]);
