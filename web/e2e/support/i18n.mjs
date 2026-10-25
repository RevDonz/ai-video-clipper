// The catalog text a spec expects (rombak 07 §14.1). L("meta.login.title", values?) reads
// web/messages/<locale>/<namespace>.json in the running project's UI language (`use.uiLocale`,
// id by default), falling back to id like the app does, and formats it with use-intl.
// LIn(locale, key, values?) and pageTitleIn(locale, route) name the language explicitly, for a
// request that does not carry the project's cookie.
import { readFileSync } from "node:fs";

import { test } from "@playwright/test";
import { createTranslator } from "use-intl/core";

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

/** The running project's UI language; id outside a test or without `use.uiLocale`. */
export function projectLocale() {
  try {
    return test.info().project.use.uiLocale || "id";
  } catch {
    return "id";
  }
}

export function LIn(locale, key, values) {
  const message = lookup(locale, key) ?? lookup("id", key);
  if (message === undefined) throw new Error(`No message ${key} in ${locale} or id`);
  if (!values) return message;
  const t = createTranslator({ locale: INTL[locale] ?? INTL.id, messages: { message } });
  return t("message", values);
}

export const L = (key, values) => LIn(projectLocale(), key, values);

/** The page title of a route: meta.<route>.title under the root template. */
export function pageTitleIn(locale, route) {
  return LIn(locale, "meta.root.titleTemplate").replace("%s", LIn(locale, `meta.${route}.title`));
}

export const pageTitle = (route) => pageTitleIn(projectLocale(), route);
