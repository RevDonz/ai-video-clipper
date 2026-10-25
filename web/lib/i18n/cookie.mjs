// The UI language cookie (rombak 07 §5.2). Not HttpOnly: global-error.jsx reads it from
// document.cookie because it cannot ask the server. The value is not a secret; it is always
// checked against the registry when read, and a foreign value is ignored.
import { localeEntry } from "./locales.mjs";

export const LOCALE_COOKIE = "potongin_locale";
export const LOCALE_COOKIE_MAX_AGE = 31_536_000;

export function localeCookie(code) {
  if (!localeEntry(code)) throw new Error(`Unknown locale: ${code}`);
  return `${LOCALE_COOKIE}=${code}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax; Secure`;
}

/** The locale named by a Cookie header (or document.cookie), or null. */
export function readLocaleCookie(cookieHeader) {
  if (typeof cookieHeader !== "string" || !cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== LOCALE_COOKIE) continue;
    const value = part.slice(index + 1).trim();
    return localeEntry(value) ? value : null;
  }
  return null;
}
