// Every translator call names a key the source catalog has (rombak 07 §7.2, §14). The namespace
// comes from useTranslations("ns") or getT(locale, "ns"); a key that is not a literal is allowed
// only in the helpers of lib/i18n, whose code lists are tested on their own.
import assert from "node:assert/strict";
import test from "node:test";

import { SOURCE_LOCALE } from "../lib/i18n/locales.mjs";
import { flatten, listSources, parseSource, readCatalog, readParsed, translatorCalls } from "./support/i18n-scan.mjs";

const HELPER_FILES = /^lib\/i18n\//;

test("the scanner follows the namespace of useTranslations and getT, and sees dynamic keys", () => {
  const { calls } = translatorCalls(parseSource(`
    "use client";
    function A() {
      const t = useTranslations("shell");
      const all = useTranslations();
      return [t("nav.create"), t.rich("skip"), all("common.save"), t(key), t(\`x.\${y}\`)];
    }
    async function B() {
      const m = await getT(locale, "meta");
      return m("root.title");
    }
    function other() { return x("not.a.translator"); }
  `));
  assert.deepEqual(calls.map(({ key, dynamic, method }) => [key, dynamic, method]), [
    ["shell.nav.create", false, null],
    ["shell.skip", false, "rich"],
    ["common.save", false, null],
    [null, true, null],
    [null, true, null],
    ["meta.root.title", false, null],
  ]);
  const unknownNamespace = translatorCalls(parseSource("const t = useTranslations(ns); t(\"a\");")).calls;
  assert.deepEqual(unknownNamespace.map((call) => call.dynamic), [true]);
});

test("every literal key exists in the Indonesian catalog, and dynamic keys stay in the helpers", async () => {
  const keys = flatten(await readCatalog(SOURCE_LOCALE));
  const missing = [];
  const dynamic = [];
  let seen = 0;
  for (const file of await listSources()) {
    const { ast } = await readParsed(file);
    for (const call of translatorCalls(ast).calls) {
      seen += 1;
      if (call.dynamic) {
        if (!HELPER_FILES.test(file)) dynamic.push(`${file}:${call.line}`);
        continue;
      }
      if (call.method === "has") continue;
      if (typeof keys.get(call.key) !== "string") missing.push(`${file}:${call.line} ${call.key}`);
    }
  }
  assert.ok(seen >= 4, "the scan reaches the translator calls (root layout, route metadata)");
  assert.deepEqual(missing, [], `keys missing from messages/${SOURCE_LOCALE}:\n${missing.join("\n")}`);
  assert.deepEqual(dynamic, [], `dynamic keys outside lib/i18n:\n${dynamic.join("\n")}`);
});
