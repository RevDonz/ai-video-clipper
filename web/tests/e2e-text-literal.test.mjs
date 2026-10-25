// The light ratchet on UI text written into the browser specs (rombak 07 §14.1.4): a spec that
// looks for a name or a text takes it from the catalog through e2e/support/i18n.mjs, so the
// specs run in every UI language. Counted per spec: the string, template and regex literals with
// a letter given to getByText/getByLabel/getByPlaceholder/getByTitle/getByAltText, to the `name`
// of getByRole, and to toHaveText/toContainText/toHaveTitle/toHaveAccessibleName. A count may
// only go down and the baseline follows it. After moving a spec's text to L():
//   UPDATE_E2E_TEXT_BASELINE=1 node --test tests/e2e-text-literal.test.mjs
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { LIn, pageTitleIn } from "../e2e/support/i18n.mjs";
import { WEB, parseSource, walk } from "./support/i18n-scan.mjs";

const BASELINE = path.join(WEB, "tests", "e2e-text-literal.baseline.json");
const LETTER = /\p{L}/u;
const TEXT_ARGUMENT = new Set(["getByText", "getByLabel", "getByPlaceholder", "getByTitle", "getByAltText",
  "toHaveText", "toContainText", "toHaveTitle", "toHaveAccessibleName"]);

function literalText(node) {
  if (!node) return [];
  if (node.type === "StringLiteral") return [node.value];
  if (node.type === "TemplateLiteral") return [node.quasis.map((quasi) => quasi.value.cooked).join(" ")];
  if (node.type === "RegExpLiteral") return [node.pattern.replace(/\\[a-zA-Z]/g, " ")];
  if (node.type === "ArrayExpression") return node.elements.flatMap(literalText);
  if (node.type === "ConditionalExpression") return [...literalText(node.consequent), ...literalText(node.alternate)];
  return [];
}

/** UI text literals in one spec: `{ call, text, line }`. */
export function specTextLiterals(ast) {
  const found = [];
  walk(ast.program, (node) => {
    if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression" || node.callee.property.type !== "Identifier") return;
    const call = node.callee.property.name;
    let texts = [];
    if (TEXT_ARGUMENT.has(call)) texts = literalText(node.arguments[0]);
    else if (call === "getByRole" && node.arguments[1]?.type === "ObjectExpression") {
      const name = node.arguments[1].properties.find((property) => property.type === "ObjectProperty"
        && !property.computed && (property.key.name ?? property.key.value) === "name");
      texts = literalText(name?.value);
    }
    for (const text of texts) if (LETTER.test(text)) found.push({ call, text, line: node.loc.start.line });
  });
  return found;
}

async function counts() {
  const dir = path.join(WEB, "e2e");
  const out = {};
  for (const name of (await readdir(dir)).filter((file) => file.endsWith(".spec.mjs")).sort()) {
    const file = `e2e/${name}`;
    const found = specTextLiterals(parseSource(await readFile(path.join(WEB, file), "utf8"), file));
    if (found.length) out[file] = found.length;
  }
  return out;
}

test("the scanner counts text literals in locators and text assertions, not test ids or catalog text", () => {
  const hits = specTextLiterals(parseSource(`
    await page.getByRole("button", { name: "Simpan" }).click();
    await page.getByRole("link", { name: /Buka proyek/i }).click();
    await page.getByRole("button", { name: L("common.save") }).click();
    await page.getByRole("button", { exact: true, name: \`Hapus \${n}\` });
    await page.getByTestId("clip-card").click();
    await page.getByLabel(open ? "Tutup menu" : "Buka menu");
    await expect(page.locator("h1")).toHaveText("Buat klip");
    await expect(page).toHaveTitle(pageTitle("login"));
    await expect(page.locator("p")).toContainText(["Satu", "123"]);
    await expect(page.locator("x")).toHaveAttribute("lang", "id");
  `));
  assert.deepEqual(hits.map((hit) => [hit.call, hit.text]), [
    ["getByRole", "Simpan"],
    ["getByRole", "Buka proyek"],
    ["getByRole", "Hapus  "],
    ["getByLabel", "Tutup menu"],
    ["getByLabel", "Buka menu"],
    ["toHaveText", "Buat klip"],
    ["toContainText", "Satu"],
  ]);
});

test("text literals per spec never rise above the baseline, and the baseline follows them down", async () => {
  const now = await counts();
  if (process.env.UPDATE_E2E_TEXT_BASELINE === "1") {
    const sorted = Object.fromEntries(Object.entries(now).sort(([a], [b]) => a.localeCompare(b)));
    await writeFile(BASELINE, `${JSON.stringify(sorted, null, 2)}\n`);
  }
  const baseline = JSON.parse(await readFile(BASELINE, "utf8"));
  const problems = [];
  for (const [file, count] of Object.entries(now)) {
    const allowed = baseline[file] ?? 0;
    if (count > allowed) problems.push(`${file}: ${count} text literals, the baseline allows ${allowed}; take the text from L()`);
    if (count < allowed) problems.push(`${file}: down to ${count} from ${allowed}; lower it in tests/e2e-text-literal.baseline.json`);
  }
  for (const [file, count] of Object.entries(baseline)) {
    if (!Object.hasOwn(now, file)) problems.push(`${file}: no text literals left (or gone), remove it from the baseline (was ${count})`);
    assert.ok(Number.isSafeInteger(count) && count > 0, `${file}: a baseline count is a positive integer`);
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("the e2e helper reads the catalog of a language, falls back to id and formats values", () => {
  assert.equal(LIn("en", "meta.login.title"), "Sign in");
  assert.equal(LIn("id", "meta.login.title"), "Masuk");
  assert.equal(LIn("xx", "meta.login.title"), "Masuk");
  assert.equal(pageTitleIn("en", "help"), "Help · Potongin");
  assert.throws(() => LIn("id", "meta.nope.title"), /No message meta\.nope\.title/);
});
