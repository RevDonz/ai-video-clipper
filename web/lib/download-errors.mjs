// yt-dlp failures as fixed codes, each with one Indonesian reason and one suggestion.
// Client-safe: the worker classifies, the dashboard and the project page show the text.
// The codes are stable: a help page will link to them as /bantuan#<code>.

const UPLOAD_INSTEAD = "Unggah file videonya langsung.";

const MESSAGES = Object.freeze({
  download_private: Object.freeze({ text: "Video ini privat.", hint: "Pakai video yang bisa ditonton tanpa login." }),
  download_unavailable: Object.freeze({ text: "Video ini sudah dihapus atau tidak tersedia.", hint: "Periksa link-nya di YouTube." }),
  download_age_restricted: Object.freeze({ text: "YouTube meminta login karena video ini dibatasi usia.", hint: UPLOAD_INSTEAD }),
  download_members_only: Object.freeze({ text: "Video ini khusus member atau berbayar.", hint: UPLOAD_INSTEAD }),
  download_geo_blocked: Object.freeze({ text: "Video ini tidak tersedia di wilayah server.", hint: UPLOAD_INSTEAD }),
  download_bot_check: Object.freeze({ text: "YouTube sedang menahan unduhan dari server ini.", hint: UPLOAD_INSTEAD }),
  download_ytdlp_outdated: Object.freeze({ text: "Pengunduh YouTube di server perlu diperbarui.", hint: "Sementara itu, unggah file videonya langsung." }),
  download_stalled: Object.freeze({ text: "Unduhan macet.", hint: "Buat ulang proyek ini beberapa menit lagi." }),
  download_failed: Object.freeze({ text: "Video YouTube gagal diunduh.", hint: "Periksa link-nya, lalu buat ulang proyek ini." }),
});

export const DOWNLOAD_ERROR_CODES = Object.freeze(Object.keys(MESSAGES));

export function isDownloadErrorCode(code) {
  return typeof code === "string" && Object.hasOwn(MESSAGES, code);
}

/** `{ text, hint }` for a download code, else null. */
export function downloadErrorMessage(code) {
  return isDownloadErrorCode(code) ? MESSAGES[code] : null;
}

/** A failed or stalled download: `code` is a download code, the message the technical line. */
export class DownloadError extends Error {
  constructor(code, message) {
    super(message || "Unduhan YouTube gagal");
    this.name = "DownloadError";
    this.code = isDownloadErrorCode(code) ? code : "download_failed";
  }
}

// First match wins, so the narrower reasons come before "unavailable": a geo block also starts
// with "Video unavailable", and YouTube's rate limit says "isn't available, try again later".
const PATTERNS = [
  ["download_private", /\bprivate video\b|\bvideo is private\b/i],
  ["download_age_restricted", /confirm your age|age[- ]restricted|inappropriate for some users/i],
  ["download_members_only", /members[- ]only|channel'?s members|join this channel|requires payment|premium members/i],
  ["download_geo_blocked", /geo[- ]?restrict|not made this video available in your country|not available (?:in|from) your (?:country|location)/i],
  ["download_bot_check", /not a bot|captcha|rate-limited|try again later|HTTP Error 429|too many requests/i],
  ["download_unavailable", /video unavailable|video is unavailable|no longer available|has been removed|been terminated|does not exist|incomplete youtube id|unsupported url/i],
  ["download_ytdlp_outdated", /requested format is not available|no video formats found|unable to extract|please report this issue|signature extraction failed|nsig extraction failed|challenge solving failed|HTTP Error 403/i],
];

// Colour codes and other control characters; a carriage return only moves the cursor.
const CONTROL = /\u001b\[[0-9;?]*[A-Za-z]|[\u0000-\u0008\u000b-\u001f\u007f]/g;

function plainLine(line) {
  return line.replace(CONTROL, "").trim();
}

const MAX_DETAIL = 240;

/**
 * One yt-dlp ERROR line as it may be stored and shown: no "ERROR:" prefix, no yt-dlp advice
 * about cookies or bug reports, no URL path or query, no secret-looking value, no server path.
 */
export function sanitizeDownloadLine(line) {
  let text = plainLine(String(line ?? "")).replace(/^ERROR:\s*/i, "");
  text = text
    .replace(/\s*\bUse --cookies.*$/i, "")
    .replace(/[;,]?\s*\bplease report this issue\b.*$/i, "")
    .replace(/\b(https?:\/\/[^\s/?#'"<>]+)([^\s'"<>]*)/gi, (url, origin, rest) => (rest.length > 1 ? `${origin}/…` : url))
    .replace(/\b(cookies?|token|po_token|pot|key|sig|signature|authorization|auth|password|passwd|session|sid|hsid|secret)(\s*[=:]\s*)(?:Bearer\s+)?[^\s;,&]+/gi, "$1$2…")
    .replace(/(^|[\s'"(])\/(?:[^\s'"/]+\/)+([^\s'"/]+)/g, "$1…/$2")
    .replace(/[A-Za-z0-9_\-+=]{32,}/g, "…")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL - 1).trimEnd()}…` : text;
}

/**
 * The download code for yt-dlp's stderr: the first ERROR line with a known reason, else
 * "download_failed". `detail` is that line (or the last ERROR line), sanitized, or null.
 * WARNING lines never decide: yt-dlp often warns about one thing and then fails on another.
 */
export function classifyDownloadError(stderr) {
  const errors = (typeof stderr === "string" ? stderr : "")
    .split("\n")
    .map(plainLine)
    .filter((line) => /^ERROR:/i.test(line));
  for (const line of errors) {
    const known = PATTERNS.find(([, pattern]) => pattern.test(line));
    if (known) return { code: known[0], detail: sanitizeDownloadLine(line) || null };
  }
  const last = errors.at(-1);
  return { code: "download_failed", detail: last ? sanitizeDownloadLine(last) || null : null };
}
