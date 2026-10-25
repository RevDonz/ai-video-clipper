// The words of a settings view descriptor (`{ key, values? }` under the "settings" namespace, or
// `{ text }`), rendered from the catalog the way app/settings/view-text.jsx renders them, so a view
// test can check the descriptor and one snapshot of its Indonesian text (rombak 07 §8.3).
import { createTranslator } from "use-intl";

import { loadNamespaces } from "../../lib/i18n/catalog.mjs";
import { localeEntry } from "../../lib/i18n/locales.mjs";

export function settingsTranslator(code = "id") {
  return createTranslator({ locale: localeEntry(code).intl, messages: loadNamespaces(code, ["settings"]), namespace: "settings", timeZone: "Asia/Jakarta" });
}

const translators = new Map();

/** The text of a descriptor in `code` (default Indonesian). */
export function settingsText(descriptor, code = "id") {
  if (descriptor === null || descriptor === undefined) return "";
  if (typeof descriptor === "string") return descriptor;
  if (typeof descriptor.text === "string") return descriptor.text;
  if (!translators.has(code)) translators.set(code, settingsTranslator(code));
  return translators.get(code)(descriptor.key, descriptor.values ?? {});
}
