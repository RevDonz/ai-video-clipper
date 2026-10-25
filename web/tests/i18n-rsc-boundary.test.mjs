// use-intl has no server-component integration (rombak 07 §2.1, §8.3): its hooks run only in
// "use client" files under <I18n>, and the server glue (lib/i18n/server.mjs, catalog.mjs, which
// read cookies and the disk) is never imported by a client file.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { hasUseClient, listSources, parseSource, readParsed, walk } from "./support/i18n-scan.mjs";

const HOOKS = new Set(["useTranslations", "useFormatter", "useLocale", "useNow", "useTimeZone", "useMessages"]);
const SERVER_ONLY = new Set(["lib/i18n/server.mjs", "lib/i18n/catalog.mjs"]);

function hookCalls(ast) {
  const imported = new Set();
  walk(ast.program, (node) => {
    if (node.type === "ImportDeclaration" && node.source.value === "use-intl") {
      for (const specifier of node.specifiers) {
        if (specifier.type === "ImportSpecifier" && HOOKS.has(specifier.imported.name)) imported.add(specifier.local.name);
      }
    }
  });
  const calls = [];
  walk(ast.program, (node) => {
    if (node.type === "CallExpression" && node.callee.type === "Identifier" && imported.has(node.callee.name)) {
      calls.push({ hook: node.callee.name, line: node.loc.start.line });
    }
  });
  return calls;
}

function relativeImports(ast, file) {
  const out = [];
  walk(ast.program, (node) => {
    if (node.type === "ImportDeclaration" && node.source.value.startsWith(".")) {
      out.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), node.source.value)));
    }
  });
  return out;
}

test("the scanner finds use-intl hooks by their imported name", () => {
  const ast = parseSource(`
    import { useTranslations as useT, useFormatter, IntlProvider } from "use-intl";
    export default function A() { const t = useT("x"); const f = useFormatter(); return <IntlProvider />; }
  `);
  assert.deepEqual(hookCalls(ast).map((call) => call.hook), ["useT", "useFormatter"]);
  assert.equal(hasUseClient(ast), false);
  assert.equal(hasUseClient(parseSource(`"use client";\nexport const x = 1;`)), true);
});

test("every file that calls a use-intl hook is a client component", async () => {
  const offenders = [];
  for (const file of await listSources()) {
    const { ast } = await readParsed(file);
    const calls = hookCalls(ast);
    if (calls.length && !hasUseClient(ast)) offenders.push(...calls.map((call) => `${file}:${call.line} ${call.hook}`));
  }
  assert.deepEqual(offenders, [], `hooks outside "use client" files:\n${offenders.join("\n")}`);
});

test("the provider is a client component and the server glue never reaches a client file", async () => {
  assert.ok(hasUseClient((await readParsed("lib/i18n/client.jsx")).ast));
  for (const file of SERVER_ONLY) assert.equal(hasUseClient((await readParsed(file)).ast), false, file);
  const offenders = [];
  for (const file of await listSources()) {
    const { ast } = await readParsed(file);
    if (!hasUseClient(ast)) continue;
    for (const target of relativeImports(ast, file)) if (SERVER_ONLY.has(target)) offenders.push(`${file} imports ${target}`);
  }
  assert.deepEqual(offenders, []);
});
