// The locale registry (rombak 07 §3, §4, §14): one row per catalog folder, "id" first and always
// on, POTONGIN_LOCALES read at runtime, and only known codes in the deployment files.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { NAMESPACES } from "../lib/i18n/catalog.mjs";
import { DEFAULT_LOCALE, LOCALES, LOCALE_CODE, SOURCE_LOCALE, enabledLocales, isEnabled, localeEntry } from "../lib/i18n/locales.mjs";
import { WEB, catalogFiles, catalogLocales, parseSource, walk } from "./support/i18n-scan.mjs";

const repoFile = (name) => readFile(path.join(WEB, "..", name), "utf8");

test("the registry and the catalog folders name the same locales", async () => {
  assert.deepEqual(LOCALES.map((entry) => entry.code).sort(), await catalogLocales());
  for (const locale of await catalogLocales()) {
    assert.deepEqual(await catalogFiles(locale), NAMESPACES.map((name) => `${name}.json`).sort(), locale);
  }
});

test("Indonesian is the default and the source, and comes first", () => {
  assert.equal(DEFAULT_LOCALE, "id");
  assert.equal(SOURCE_LOCALE, "id");
  assert.equal(LOCALES[0].code, "id");
  assert.ok(Object.isFrozen(LOCALES) && LOCALES.every((entry) => Object.isFrozen(entry)));
});

test("every row has a valid code, a canonical Intl tag, its own name and a direction", () => {
  const codes = new Set();
  for (const entry of LOCALES) {
    assert.match(entry.code, LOCALE_CODE, entry.code);
    assert.ok(!codes.has(entry.code), `${entry.code} twice`);
    codes.add(entry.code);
    assert.deepEqual(Intl.getCanonicalLocales(entry.intl), [entry.intl], entry.intl);
    assert.equal(new Intl.Locale(entry.intl).language, entry.code.split("-")[0], entry.intl);
    assert.ok(typeof entry.label === "string" && entry.label.trim(), entry.code);
    assert.ok(entry.dir === "ltr" || entry.dir === "rtl", entry.code);
    assert.equal(localeEntry(entry.code), entry);
  }
  for (const bad of ["ID", "id-ID", "xx", "", null, undefined, 7, "__proto__", "toString"]) assert.equal(localeEntry(bad), null, String(bad));
});

test("POTONGIN_LOCALES enables known codes after id, and id cannot be switched off", () => {
  assert.deepEqual(enabledLocales({}), ["id"]);
  assert.deepEqual(enabledLocales({ POTONGIN_LOCALES: "" }), ["id"]);
  assert.deepEqual(enabledLocales({ POTONGIN_LOCALES: "id" }), ["id"]);
  assert.deepEqual(enabledLocales({ POTONGIN_LOCALES: "en" }), ["id", "en"]);
  assert.deepEqual(enabledLocales({ POTONGIN_LOCALES: " en , id ,xx,EN,qps" }), ["id", "en"]);
  assert.deepEqual(enabledLocales({ POTONGIN_LOCALES: "id,en" }), ["id", "en"]);
  assert.equal(isEnabled("en", { POTONGIN_LOCALES: "id" }), false);
  assert.equal(isEnabled("en", { POTONGIN_LOCALES: "id,en" }), true);
  assert.equal(isEnabled("id", { POTONGIN_LOCALES: "en" }), true);
  assert.equal(isEnabled("xx", { POTONGIN_LOCALES: "xx" }), false);
});

function dotenvValue(text, name) {
  return new RegExp(`^${name}=(.*)$`, "m").exec(text)?.[1];
}

test("the deployment files name only registered locales", async () => {
  const known = new Set(LOCALES.map((entry) => entry.code));
  const example = dotenvValue(await repoFile(".env.example"), "POTONGIN_LOCALES");
  assert.ok(example !== undefined, ".env.example sets POTONGIN_LOCALES");
  const compose = /POTONGIN_LOCALES: \$\{POTONGIN_LOCALES:-([^}]*)\}/.exec(await repoFile("compose.yaml"));
  assert.ok(compose, "compose.yaml passes POTONGIN_LOCALES with a default");
  for (const value of [example, compose[1]]) {
    for (const code of value.split(",").map((item) => item.trim())) assert.ok(known.has(code), `unknown locale ${code}`);
  }
});

test("global-error.jsx bundles only the Indonesian catalog; others load on demand", async () => {
  const source = await readFile(path.join(WEB, "app", "global-error.jsx"), "utf8");
  const ast = parseSource(source, "global-error.jsx");
  const statics = [];
  const dynamics = [];
  walk(ast.program, (node) => {
    if (node.type === "ImportDeclaration" && /messages\//.test(node.source.value)) statics.push(node.source.value);
    if (node.type === "ImportExpression" || (node.type === "CallExpression" && node.callee.type === "Import")) {
      const arg = node.source ?? node.arguments[0];
      dynamics.push(arg.type === "TemplateLiteral" ? arg.quasis.map((quasi) => quasi.value.cooked).join("${}") : arg.value);
    }
  });
  assert.deepEqual(statics, ["../messages/id/errors.json"]);
  assert.deepEqual(dynamics, ["../messages/${}/errors.json"]);
});
