// The message catalogs (rombak 07 §7, §14): the same files and keys in every locale, no empty
// message, valid ICU with the same arguments everywhere, plural categories of each language, key
// shapes use-intl can address, no unused key, and the deep-merge fallback onto "id".
import assert from "node:assert/strict";
import test from "node:test";

import { IntlMessageFormat } from "intl-messageformat";

import { CORE, NAMESPACES, deepMerge, loadNamespace, loadNamespaces, namespaceWithFallback } from "../lib/i18n/catalog.mjs";
import { LOCALES, SOURCE_LOCALE } from "../lib/i18n/locales.mjs";
import { catalogFiles, catalogLocales, flatten, keyPaths, listSources, readCatalog, readParsed, translatorCalls } from "./support/i18n-scan.mjs";

// Subtrees filled through helpers that map codes to keys (07 §7.2): no literal t("…") names them.
const HELPER_SUBTREES = ["errors", "hints", "stage", "reason", "status", "aria", "meta",
  // The help page's entries, groups, guide, shortcuts and links: read per code by lib/help-view.mjs;
  // help-catalog.test.mjs holds every one of them to the code lists, in both directions.
  "help.entries", "help.groups", "help.guide", "help.shortcuts", "help.actions"];
// Keys the i18n glue itself reads, with where.
const GLUE_KEYS = Object.freeze({
  "common.unavailable": "lib/i18n/handlers.mjs fallback text, read by lib/i18n/client.jsx and server.mjs",
});

const AST = Object.freeze({ literal: 0, argument: 1, number: 2, date: 3, time: 4, select: 5, plural: 6, pound: 7, tag: 8 });

function argumentsOf(elements, out = new Set()) {
  for (const element of elements) {
    if ([AST.argument, AST.number, AST.date, AST.time, AST.select, AST.plural].includes(element.type)) out.add(element.value);
    if (element.type === AST.tag) {
      out.add(`<${element.value}>`);
      argumentsOf(element.children, out);
    }
    if (element.type === AST.select || element.type === AST.plural) {
      for (const option of Object.values(element.options)) argumentsOf(option.value, out);
    }
  }
  return out;
}

function pluralsOf(elements, out = []) {
  for (const element of elements) {
    if (element.type === AST.plural) out.push(element);
    if (element.type === AST.tag) pluralsOf(element.children, out);
    if (element.type === AST.select || element.type === AST.plural) {
      for (const option of Object.values(element.options)) pluralsOf(option.value, out);
    }
  }
  return out;
}

const catalogs = async () => Object.fromEntries(await Promise.all((await catalogLocales()).map(async (locale) => [locale, await readCatalog(locale)])));

test("every locale has the same files and the same keys as the source", async () => {
  const all = await catalogs();
  const sourceFiles = await catalogFiles(SOURCE_LOCALE);
  const sourceKeys = [...flatten(all[SOURCE_LOCALE]).keys()].sort();
  for (const locale of Object.keys(all)) {
    assert.deepEqual(await catalogFiles(locale), sourceFiles, `${locale}: files`);
    assert.deepEqual([...flatten(all[locale]).keys()].sort(), sourceKeys, `${locale}: keys`);
  }
});

test("every message is a non-empty string", async () => {
  for (const [locale, catalog] of Object.entries(await catalogs())) {
    for (const [key, value] of flatten(catalog)) {
      // An empty namespace file ({}) flattens to its own name with an empty object: allowed.
      if (value !== null && typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length) continue;
      assert.equal(typeof value, "string", `${locale}: ${key} is not a string`);
      assert.ok(value.trim(), `${locale}: ${key} is empty`);
    }
  }
});

test("keys are plain segments: no dot inside a segment, letters, digits and _ only", async () => {
  for (const [locale, catalog] of Object.entries(await catalogs())) {
    for (const { path, key } of keyPaths(catalog)) {
      assert.match(key, /^[A-Za-z0-9_]+$/, `${locale}: ${path}`);
    }
  }
});

test("every message parses as ICU, with the same arguments in every locale", async () => {
  const all = await catalogs();
  const intlOf = Object.fromEntries(LOCALES.map((entry) => [entry.code, entry.intl]));
  const source = flatten(all[SOURCE_LOCALE]);
  for (const [locale, catalog] of Object.entries(all)) {
    for (const [key, value] of flatten(catalog)) {
      if (typeof value !== "string") continue;
      let ast;
      assert.doesNotThrow(() => { ast = new IntlMessageFormat(value, intlOf[locale]).getAst(); }, `${locale}: ${key}`);
      const expected = new IntlMessageFormat(source.get(key), intlOf[SOURCE_LOCALE]).getAst();
      assert.deepEqual([...argumentsOf(ast)].sort(), [...argumentsOf(expected)].sort(), `${locale}: ${key} arguments`);
    }
  }
});

test("plural messages use exactly the categories of their language", async () => {
  const all = await catalogs();
  for (const entry of LOCALES) {
    const categories = new Set(new Intl.PluralRules(entry.intl).resolvedOptions().pluralCategories);
    for (const [key, value] of flatten(all[entry.code])) {
      if (typeof value !== "string") continue;
      for (const plural of pluralsOf(new IntlMessageFormat(value, entry.intl).getAst())) {
        const named = Object.keys(plural.options).filter((option) => !/^=\d+$/.test(option));
        assert.deepEqual(new Set(named), categories, `${entry.code}: ${key} plural {${plural.value}}`);
      }
    }
  }
  // The rule itself: Indonesian has only "other", English "one" and "other".
  assert.deepEqual(new Intl.PluralRules("id-ID").resolvedOptions().pluralCategories, ["other"]);
  assert.deepEqual(new Set(new Intl.PluralRules("en-US").resolvedOptions().pluralCategories), new Set(["one", "other"]));
});

test("no key is unused outside the helper subtrees", async () => {
  const used = new Set();
  for (const file of await listSources()) {
    const { ast } = await readParsed(file);
    for (const call of translatorCalls(ast).calls) if (call.key) used.add(call.key);
  }
  const helper = (key) => HELPER_SUBTREES.some((root) => key === root || key.startsWith(`${root}.`));
  const orphans = [...flatten((await catalogs())[SOURCE_LOCALE])]
    .filter(([key, value]) => typeof value === "string" && !helper(key) && !used.has(key) && !Object.hasOwn(GLUE_KEYS, key))
    .map(([key]) => key);
  assert.deepEqual(orphans, [], `unused keys:\n${orphans.join("\n")}`);
  // The glue keys exist and the glue reads them.
  for (const key of Object.keys(GLUE_KEYS)) assert.ok(flatten((await catalogs())[SOURCE_LOCALE]).has(key), key);
  for (const file of ["lib/i18n/client.jsx", "lib/i18n/server.mjs"]) {
    assert.match((await readParsed(file)).source, /\.common\?\.unavailable/, file);
  }
});

test("a locale is merged over Indonesian, so a missing key shows the Indonesian text", () => {
  assert.deepEqual(deepMerge({ a: { b: "id-b", c: "id-c" }, d: "id-d" }, { a: { b: "en-b" } }), { a: { b: "en-b", c: "id-c" }, d: "id-d" });
  const base = { a: { b: "x" } };
  deepMerge(base, { a: { b: "y" } });
  assert.deepEqual(base, { a: { b: "x" } }, "the source is not changed");
  const en = namespaceWithFallback("en", "errors");
  assert.equal(en.web.unknown, loadNamespace("en", "errors").web.unknown);
  assert.notEqual(en.web.unknown, loadNamespace("id", "errors").web.unknown);
});

test("loadNamespaces returns whole namespaces and subtrees at their own paths", () => {
  const messages = loadNamespaces("en", CORE);
  assert.deepEqual(Object.keys(messages).sort(), ["aria", "common", "errors", "shell", "status"]);
  assert.deepEqual(Object.keys(messages.errors).sort(), ["http", "web"], "only the core error subtrees");
  assert.equal(messages.errors.http.s404, loadNamespace("en", "errors").http.s404);
  assert.throws(() => loadNamespaces("en", ["nope"]), /Unknown message namespace/);
  assert.throws(() => loadNamespaces("en", ["errors.nope"]), /Unknown message subtree/);
  assert.throws(() => loadNamespaces("xx", ["common"]), /Unknown locale/);
  assert.throws(() => loadNamespace("en", "../../package"), /Unknown message namespace/);
  for (const namespace of NAMESPACES) assert.ok(loadNamespace(SOURCE_LOCALE, namespace), namespace);
});
