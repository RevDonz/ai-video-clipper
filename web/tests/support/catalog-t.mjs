// A translator over the real catalogs for unit tests of view modules: descriptors
// ({ key, values }) are checked by their key and by the text they give in a locale. A missing key
// throws, so a descriptor that names no message fails the test.
import { createTranslator } from "use-intl/core";

import { NAMESPACES, loadNamespaces } from "../../lib/i18n/catalog.mjs";
import { msg } from "../../lib/i18n/descriptor.mjs";
import { localeEntry } from "../../lib/i18n/locales.mjs";

const cache = new Map();

export function catalogT(locale = "id") {
  if (!cache.has(locale)) {
    cache.set(locale, createTranslator({
      locale: localeEntry(locale).intl,
      messages: loadNamespaces(locale, NAMESPACES),
      timeZone: "Asia/Jakarta",
      onError(error) { throw error; },
    }));
  }
  return cache.get(locale);
}

/** The text of a descriptor in `locale` (id by default). */
export const textOf = (descriptor, locale = "id") => msg(catalogT(locale), descriptor);

const isDescriptorShape = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
  && typeof value.key === "string" && Object.keys(value).every((name) => name === "key" || name === "values");

/**
 * `value` with every descriptor in it turned into its text in `locale`: arrays and plain objects
 * are walked, so a view's whole result ({ tone, title, text }) compares with plain strings. Only
 * an object made of `key` (+ `values`) is a descriptor; a row with a `key` among other fields
 * stays a row.
 */
export function textsOf(value, locale = "id") {
  if (isDescriptorShape(value)) return textOf(value, locale);
  if (Array.isArray(value)) return value.map((entry) => textsOf(entry, locale));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, textsOf(entry, locale)]));
  }
  return value;
}
