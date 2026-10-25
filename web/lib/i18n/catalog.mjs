// The message catalogs (rombak 07 §2.2, §7): one folder per locale, web/messages/<code>/, one
// JSON file per namespace. A locale other than "id" is deep-merged over "id", so a missing key
// shows the Indonesian text. Server only: the files are read from disk (next.config.mjs traces
// web/messages into the standalone build) and cached per (code, namespace) for the process.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SOURCE_LOCALE, localeEntry } from "./locales.mjs";

export const NAMESPACES = Object.freeze([
  "common", "shell", "status", "aria", "meta", "errors", "auth", "dashboard", "projects", "settings", "trends", "editor",
  "stage", "reason",
]);

// What every page gets from the root provider (07 §8.2).
export const CORE = Object.freeze(["common", "shell", "status", "aria", "errors.web", "errors.http"]);

const NAMESPACE_SET = new Set(NAMESPACES);
const cache = new Map();
let root = null;

// The folder next to this module when it runs unbundled (tests, scripts); the standalone server
// and next dev run with web/ (or the image's /app) as the working directory.
function messagesRoot() {
  if (root) return root;
  const candidates = [];
  try {
    // Built from parts so a bundler does not take it for an asset reference.
    candidates.push(fileURLToPath(new URL(["..", "..", "messages", ""].join("/"), import.meta.url)));
  } catch {}
  candidates.push(path.join(process.cwd(), "messages"), path.join(process.cwd(), "web", "messages"));
  root = candidates.find((dir) => existsSync(path.join(dir, SOURCE_LOCALE, "common.json")));
  if (!root) throw new Error("The message catalogs (web/messages) were not found");
  return root;
}

function checkedNamespace(namespace) {
  if (!NAMESPACE_SET.has(namespace)) throw new Error(`Unknown message namespace: ${namespace}`);
  return namespace;
}

/** One namespace file of one locale, exactly as written (no fallback). */
export function loadNamespace(code, namespace) {
  if (!localeEntry(code)) throw new Error(`Unknown locale: ${code}`);
  checkedNamespace(namespace);
  const key = `${code}/${namespace}`;
  if (!cache.has(key)) {
    const file = path.join(messagesRoot(), code, `${namespace}.json`);
    cache.set(key, existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
  }
  return cache.get(key);
}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** `over` merged into a copy of `base`; nested objects merge, anything else replaces. */
export function deepMerge(base, over) {
  const out = { ...base };
  for (const [key, value] of Object.entries(over ?? {})) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : value;
  }
  return out;
}

/** A namespace of `code` with the source locale underneath. */
export function namespaceWithFallback(code, namespace) {
  const source = loadNamespace(SOURCE_LOCALE, namespace);
  return code === SOURCE_LOCALE ? deepMerge({}, source) : deepMerge(source, loadNamespace(code, namespace));
}

/**
 * The messages of `namespaces` for `code`, keyed by namespace, each already falling back to "id".
 * A name may be a whole namespace ("common") or a subtree ("errors.web"), which lands at the same
 * path in the result.
 */
export function loadNamespaces(code, namespaces) {
  const messages = {};
  for (const name of namespaces) {
    const [namespace, ...rest] = String(name).split(".");
    let value = namespaceWithFallback(code, checkedNamespace(namespace));
    for (const part of rest) value = isPlainObject(value) ? value[part] : undefined;
    if (value === undefined) throw new Error(`Unknown message subtree: ${name}`);
    let target = messages;
    const pathParts = [namespace, ...rest];
    for (const part of pathParts.slice(0, -1)) target = target[part] ??= {};
    const last = pathParts.at(-1);
    target[last] = isPlainObject(value) && isPlainObject(target[last]) ? deepMerge(target[last], value) : value;
  }
  return messages;
}
