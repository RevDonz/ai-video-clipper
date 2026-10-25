// The UI languages (rombak 07 §3). Adding one is a catalog folder web/messages/<code>/ plus one
// row here; `label` is the language's own name and is never translated.
export const LOCALES = Object.freeze([
  Object.freeze({ code: "id", intl: "id-ID", label: "Bahasa Indonesia", dir: "ltr" }),
  Object.freeze({ code: "en", intl: "en-US", label: "English", dir: "ltr" }),
]);

// The source of every string; it cannot be switched off.
export const DEFAULT_LOCALE = "id";
export const SOURCE_LOCALE = "id";

export const LOCALE_CODE = /^[a-z]{2,3}(-[a-z0-9]+)?$/;

const BY_CODE = new Map(LOCALES.map((entry) => [entry.code, entry]));

export function localeEntry(code) {
  return (typeof code === "string" && BY_CODE.get(code)) || null;
}

/**
 * POTONGIN_LOCALES ("id", "id,en", ...), read at runtime, not at build time. Unknown codes are
 * dropped and "id" always comes first.
 */
export function enabledLocales(env = process.env) {
  const raw = typeof env?.POTONGIN_LOCALES === "string" ? env.POTONGIN_LOCALES : "";
  const codes = raw.split(",").map((code) => code.trim().toLowerCase()).filter((code) => BY_CODE.has(code));
  return [...new Set([DEFAULT_LOCALE, ...codes])];
}

export function isEnabled(code, env = process.env) {
  return enabledLocales(env).includes(code);
}
