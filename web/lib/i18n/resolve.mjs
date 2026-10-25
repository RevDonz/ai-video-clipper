// Which UI language a request gets (rombak 07 §5): the user's saved choice, then the
// potongin_locale cookie, then Accept-Language, then "id". A candidate that is not enabled is
// skipped, never an error.
import { DEFAULT_LOCALE, localeEntry } from "./locales.mjs";

const MAX_HEADER = 512;
const MAX_ENTRIES = 32;
// Language tags that mean the same UI language.
const ALIASES = Object.freeze({ in: "id" });

function primarySubtag(tag) {
  const primary = tag.trim().toLowerCase().split("-")[0];
  return ALIASES[primary] ?? primary;
}

function quality(params) {
  for (const param of params) {
    const match = /^\s*q\s*=\s*(.*)$/i.exec(param);
    if (!match) continue;
    const value = match[1].trim();
    if (!/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value)) return 1;
    return Number(value);
  }
  return 1;
}

/** The first enabled language of an Accept-Language header, by q-value, or null. */
export function parseAcceptLanguage(header, enabled) {
  if (typeof header !== "string" || !header || header.length > MAX_HEADER) return null;
  const allowed = new Set(enabled);
  const entries = header.split(",").slice(0, MAX_ENTRIES).map((part, order) => {
    const [tag = "", ...params] = part.split(";");
    return { tag: tag.trim(), q: quality(params), order };
  }).filter((entry) => entry.tag && entry.tag !== "*" && entry.q > 0);
  entries.sort((a, b) => b.q - a.q || a.order - b.order);
  for (const entry of entries) {
    const code = primarySubtag(entry.tag);
    if (allowed.has(code)) return code;
  }
  return null;
}

/** user.locale > cookie > Accept-Language > "id", each only when it is enabled. */
export function resolveLocale({ user, cookie, acceptLanguage, enabled }) {
  const allowed = new Set(enabled);
  const usable = (code) => typeof code === "string" && localeEntry(code) !== null && allowed.has(code);
  if (usable(user?.locale)) return user.locale;
  if (usable(cookie)) return cookie;
  return parseAcceptLanguage(acceptLanguage, enabled) ?? DEFAULT_LOCALE;
}
