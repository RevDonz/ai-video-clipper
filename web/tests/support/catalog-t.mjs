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
