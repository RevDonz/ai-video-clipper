// Formatters per UI locale (rombak 07 §13.1): numbers, the editor's seconds, file sizes and
// dates. Every Intl object is built once per (locale, options) and kept. `locale` is a registry
// code ("id") or its Intl tag ("id-ID"); anything else falls back to the source locale, which
// is what modules that do not know the viewer's language yet get by default. Clock times are
// 24-hour in every locale (Q8).
import { DEFAULT_LOCALE, LOCALES, localeEntry } from "./locales.mjs";

// The separator of short lists of values ("Ukuran 64 · Posisi bawah").
export const LIST_SEPARATOR = " · ";

const BY_INTL = new Map(LOCALES.map((entry) => [entry.intl, entry]));

/** The Intl tag of a locale code or tag. */
export function intlOf(locale = DEFAULT_LOCALE) {
  return (localeEntry(locale) ?? BY_INTL.get(locale) ?? localeEntry(DEFAULT_LOCALE)).intl;
}

const cache = new Map();

function cached(kind, locale, options, make) {
  const intl = intlOf(locale);
  const key = `${kind}\u0000${intl}\u0000${JSON.stringify(options ?? {})}`;
  if (!cache.has(key)) cache.set(key, make(intl, options ?? {}));
  return cache.get(key);
}

const TIME_FIELDS = ["timeStyle", "hour", "minute", "second"];

function withClock(options) {
  const clock = TIME_FIELDS.some((field) => options[field] !== undefined);
  return clock && options.hourCycle === undefined && options.hour12 === undefined ? { ...options, hourCycle: "h23" } : options;
}

export function numberFormat(locale, options) {
  return cached("number", locale, options, (intl, opts) => new Intl.NumberFormat(intl, opts));
}

export function dateTimeFormat(locale, options) {
  return cached("date", locale, options, (intl, opts) => new Intl.DateTimeFormat(intl, withClock(opts)));
}

export function displayNames(locale, options) {
  return cached("names", locale, options, (intl, opts) => new Intl.DisplayNames([intl], opts));
}

export function formatNumber(value, locale, options) {
  return numberFormat(locale, options).format(value);
}

const ONE_DECIMAL = Object.freeze({ minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Seconds with one decimal, as the editor shows them ("12,5" in id). */
export function secondsFormat(locale) {
  return numberFormat(locale, ONE_DECIMAL);
}

export function formatDateTime(value, locale, options) {
  return dateTimeFormat(locale, options).format(value);
}

/** The name of a language code in the UI language ("Inggris" in id), or null. */
export function languageName(code, locale) {
  try {
    return displayNames(locale, { type: "language" }).of(code) ?? null;
  } catch {
    return null;
  }
}
