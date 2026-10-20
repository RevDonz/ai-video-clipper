// The cookies.txt a person uploads in Pengaturan ("Cookies YouTube"), checked and rewritten into
// the file yt-dlp reads. No Node built-ins: the parsing works on bytes and strings only.
//
// Accepted: the Netscape format (seven tab-separated fields per cookie), with or without its
// "# Netscape HTTP Cookie File" header, a UTF-8 BOM, CRLF line ends, and "#HttpOnly_" lines,
// which are cookies, not comments. Safe fixes: a leading dot or a TRUE subdomain flag makes a
// domain cookie written with both (Python's cookie jar refuses the whole file when they
// disagree), a decimal expiry is truncated, and a line whose tabs became spaces is read as
// seven fields. Kept: cookies of youtube.com and
// google.com (where the login lives) that have not expired. Everything else is dropped and
// counted. JSON exports, UTF-16 files and binary files are refused with their own code.

export const MAX_COOKIES_FILE_BYTES = 1024 * 1024;
// The rewritten file the store seals; real YouTube and Google cookies stay far below this.
export const MAX_KEPT_COOKIES_BYTES = 256 * 1024;
export const COOKIES_FILE_HEADER = "# Netscape HTTP Cookie File";

export const COOKIES_FILE_CODES = Object.freeze([
  "cookies_empty",
  "cookies_too_large",
  "cookies_utf16",
  "cookies_not_text",
  "cookies_json",
  "cookies_not_netscape",
  "cookies_no_youtube",
  "cookies_expired",
]);

export class CookiesFileError extends Error {
  constructor(code) {
    super(code);
    this.name = "CookiesFileError";
    this.code = code;
  }
}

const HTTPONLY_PREFIX = "#HttpOnly_";
const HEADER = /^#( Netscape)? HTTP Cookie File/i;
const DOMAIN = /^\.?[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)+$/;
const FLAG = /^(?:TRUE|FALSE)$/i;
const COOKIE_PATH = /^\/[\x21-\x7e]*$/;
const EXPIRES = /^(?:\d{1,15})(?:\.\d+)?$/;
const NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const VALUE = /^[\x20-\x7e]*$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
// The cookies a signed-in YouTube session carries (on .youtube.com or .google.com).
const LOGIN_NAMES = new Set(["LOGIN_INFO", "SID", "SAPISID", "__Secure-1PSID", "__Secure-3PSID", "__Secure-1PAPISID", "__Secure-3PAPISID"]);
const KEPT_SITES = ["youtube.com", "google.com"];

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (typeof input === "string") return new TextEncoder().encode(input);
  throw new CookiesFileError("cookies_not_text");
}

// UTF-16 text of mostly ASCII has a zero byte in every other position.
function looksUtf16(bytes) {
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) return true;
  const pairs = Math.min(512, Math.floor(bytes.length / 2));
  if (pairs < 4) return false;
  let even = 0;
  let odd = 0;
  for (let index = 0; index < pairs * 2; index += 2) {
    if (bytes[index] === 0) even += 1;
    if (bytes[index + 1] === 0) odd += 1;
  }
  return Math.max(even, odd) >= pairs * 0.4;
}

function decode(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CookiesFileError("cookies_not_text");
  }
  while (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (CONTROL.test(text)) throw new CookiesFileError("cookies_not_text");
  return text;
}

function cookieFields(raw) {
  let fields = raw.split("\t");
  if (fields.length === 1) fields = raw.trim().split(/ +/);
  if (fields.length !== 7) return null;
  const [rawDomain, flag, cookiePath, secure, expires, name, value] = fields;
  const domain = rawDomain.trim().toLowerCase();
  if (!DOMAIN.test(domain) || !FLAG.test(flag) || !COOKIE_PATH.test(cookiePath) || !FLAG.test(secure)) return null;
  if (expires !== "" && !EXPIRES.test(expires)) return null;
  if (!NAME.test(name) || !VALUE.test(value)) return null;
  const subdomains = domain.startsWith(".") || flag.toUpperCase() === "TRUE";
  return {
    domain: subdomains && !domain.startsWith(".") ? `.${domain}` : domain,
    path: cookiePath,
    secure: secure.toUpperCase() === "TRUE",
    expires: expires === "" ? 0 : Math.trunc(Number(expires)),
    name,
    value,
  };
}

function keptSite(domain) {
  const host = domain.startsWith(".") ? domain.slice(1) : domain;
  return KEPT_SITES.some((site) => host === site || host.endsWith(`.${site}`));
}

function cookieLine(cookie) {
  const subdomains = cookie.domain.startsWith(".") ? "TRUE" : "FALSE";
  const fields = [cookie.domain, subdomains, cookie.path, cookie.secure ? "TRUE" : "FALSE", String(cookie.expires), cookie.name, cookie.value];
  return `${cookie.httpOnly ? HTTPONLY_PREFIX : ""}${fields.join("\t")}`;
}

/**
 * The checked file: `{text, count, signedIn, skipped: {otherSites, expired, invalid}}`, where
 * `text` is the Netscape file (header first) holding only the kept cookies. Throws
 * CookiesFileError with one of COOKIES_FILE_CODES. `now` is in milliseconds.
 */
export function parseCookiesFile(input, { now = Date.now() } = {}) {
  const bytes = toBytes(input);
  if (bytes.length > MAX_COOKIES_FILE_BYTES) throw new CookiesFileError("cookies_too_large");
  if (looksUtf16(bytes)) throw new CookiesFileError("cookies_utf16");
  const text = decode(bytes);
  const first = text.trimStart()[0];
  if (first === "[" || first === "{") throw new CookiesFileError("cookies_json");

  const nowSeconds = Math.floor(now / 1000);
  const kept = [];
  const skipped = { otherSites: 0, expired: 0, invalid: 0 };
  let header = false;
  let candidates = 0;
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    let raw = rawLine;
    let httpOnly = false;
    if (raw.startsWith(HTTPONLY_PREFIX)) {
      httpOnly = true;
      raw = raw.slice(HTTPONLY_PREFIX.length);
    } else if (raw.trimStart().startsWith("#")) {
      if (HEADER.test(raw.trimStart())) header = true;
      continue;
    }
    if (raw.trim() === "") continue;
    candidates += 1;
    const cookie = cookieFields(raw);
    if (!cookie) {
      skipped.invalid += 1;
      continue;
    }
    if (!keptSite(cookie.domain)) skipped.otherSites += 1;
    else if (cookie.expires > 0 && cookie.expires <= nowSeconds) skipped.expired += 1;
    else kept.push({ ...cookie, httpOnly });
  }

  if (candidates === 0) throw new CookiesFileError("cookies_empty");
  const valid = candidates - skipped.invalid;
  if (valid === 0 || (!header && skipped.invalid > 0)) throw new CookiesFileError("cookies_not_netscape");
  if (kept.length === 0) throw new CookiesFileError(skipped.expired > 0 ? "cookies_expired" : "cookies_no_youtube");

  const output = `${COOKIES_FILE_HEADER}\n${kept.map(cookieLine).join("\n")}\n`;
  if (new TextEncoder().encode(output).length > MAX_KEPT_COOKIES_BYTES) throw new CookiesFileError("cookies_too_large");
  return {
    text: output,
    count: kept.length,
    signedIn: kept.some((cookie) => LOGIN_NAMES.has(cookie.name)),
    skipped,
  };
}
