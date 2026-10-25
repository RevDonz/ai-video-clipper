// The catalog text a spec expects (rombak 07 §14.1): L(locale, "meta.login.title", values?)
// reads web/messages/<locale>/<namespace>.json, falling back to id like the app does.
import { readFileSync } from "node:fs";

import { IntlMessageFormat } from "intl-messageformat";

const INTL = Object.freeze({ id: "id-ID", en: "en-US" });
const cache = new Map();

function namespace(locale, name) {
  const key = `${locale}/${name}`;
  if (!cache.has(key)) {
    let value = {};
    try {
      value = JSON.parse(readFileSync(new URL(`../../messages/${locale}/${name}.json`, import.meta.url), "utf8"));
    } catch {}
    cache.set(key, value);
  }
  return cache.get(key);
}

function lookup(locale, key) {
  const [name, ...rest] = key.split(".");
  let value = namespace(locale, name);
  for (const part of rest) value = value?.[part];
  return typeof value === "string" ? value : undefined;
}

export function L(locale, key, values) {
  const message = lookup(locale, key) ?? lookup("id", key);
  if (message === undefined) throw new Error(`No message ${key} in ${locale} or id`);
  return values ? String(new IntlMessageFormat(message, INTL[locale] ?? INTL.id).format(values)) : message;
}

/** The page title of a route: meta.<route>.title under the root template. */
export function pageTitle(locale, route) {
  return L(locale, "meta.root.titleTemplate").replace("%s", L(locale, `meta.${route}.title`));
}
