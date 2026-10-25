// No fixed locale outside the i18n layer (rombak 07 §13.1, §14): Intl.*, toLocale*() and
// localeCompare() get the UI locale through lib/i18n/format.mjs, or the content language through
// lib/content-text.mjs. A justified exception is listed per call site, not per file.
import assert from "node:assert/strict";
import test from "node:test";

import { listSources, localeLiterals, parseSource, readParsed } from "./support/i18n-scan.mjs";

const LAYER = /^lib\/i18n\/|^lib\/content-text\.mjs$/;
// "<file>:<call>" → why it may keep its literal. Empty: every call site goes through the layer.
const ALLOWED = Object.freeze({});

test("the scanner sees literal locales in Intl, toLocale* and localeCompare, not variables", () => {
  const found = localeLiterals(parseSource(`
    new Intl.NumberFormat("id-ID");
    Intl.DateTimeFormat(["id"], {});
    new Intl.DisplayNames(["id"], { type: "language" });
    value.toLocaleString("id-ID");
    date.toLocaleDateString(\`en-US\`);
    text.toLocaleUpperCase("id");
    a.localeCompare(b, "id-ID");
    new Intl.NumberFormat(locale);
    new Intl.Collator(intlOf(locale));
    text.toLocaleLowerCase(lang);
    a.localeCompare(b);
    value.toLocaleString();
  `));
  assert.deepEqual(found.map((hit) => hit.call), [
    "Intl.NumberFormat", "Intl.DateTimeFormat", "Intl.DisplayNames", "toLocaleString", "toLocaleDateString", "toLocaleUpperCase", "localeCompare",
  ]);
});

test("no source outside lib/i18n and content-text hands Intl a fixed locale", async () => {
  const hits = [];
  for (const file of await listSources()) {
    if (LAYER.test(file)) continue;
    const { ast } = await readParsed(file);
    for (const hit of localeLiterals(ast)) {
      if (!Object.hasOwn(ALLOWED, `${file}:${hit.call}`)) hits.push(`${file}:${hit.line} ${hit.call}`);
    }
  }
  assert.deepEqual(hits, [], `fixed locales outside the i18n layer:\n${hits.join("\n")}`);
});
