// The ratchet on UI copy written in the code (rombak 07 §14): JSX text, copy attributes
// (aria-label, placeholder, title, alt, label) with literal values, toast("…") and sentences in
// view modules, counted per file. The count of a file may only go down, and the baseline must
// follow it down, so a file once cleaned stays clean. After moving copy into the catalog:
//   UPDATE_I18N_BASELINE=1 node --test tests/i18n-hardcoded.test.mjs
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { WEB, hardcodedCopy, listSources, parseSource, readParsed } from "./support/i18n-scan.mjs";

const BASELINE = path.join(WEB, "tests", "i18n-hardcoded.baseline.json");
const SCANNED_DIRS = ["app", "components", "lib"];
// Developer pages, the editor's dev fixtures and the licence notices (names and licence texts).
const EXEMPT = [/^app\/parity-harness\//, /^components\/editor\/(?:.*\/)?__dev__\//, /^app\/licenses\/notices\.mjs$/];
const VIEW_MODULE = /^lib\/[^/]+-view\.mjs$/;
const UI_FILE = /\.jsx$/;
// Files whose copy lives in the catalog already: they must stay at zero.
const ZERO = Object.freeze([
  "app/layout.jsx",
  "app/global-error.jsx",
  "app/dashboard/layout.jsx",
  "app/projects/layout.jsx",
  "app/settings/layout.jsx",
  "app/trends/layout.jsx",
  "app/projects/[id]/clips/[clipId]/edit/layout.jsx",
  "components/SegmentI18n.jsx",
  "lib/i18n/client.jsx",
]);

async function counts() {
  const out = {};
  for (const file of await listSources(SCANNED_DIRS)) {
    if (EXEMPT.some((pattern) => pattern.test(file))) continue;
    const viewModule = VIEW_MODULE.test(file);
    if (!viewModule && !UI_FILE.test(file)) continue;
    const { ast } = await readParsed(file);
    const found = hardcodedCopy(ast, { viewModule });
    if (found.length) out[file] = found.length;
  }
  return out;
}

test("the scanner counts JSX text, copy attributes, toasts and view sentences, not code or the brand", () => {
  const page = hardcodedCopy(parseSource(`
    export default function A({ t, n }) {
      return (
        <section aria-label="Daftar klip" className="panel" data-x="Tidak dihitung">
          <h1>Buat klip</h1>
          <p>{"Teks literal"}</p>
          <span>{t("ok")}</span>
          <b>Potongin</b>
          <i>{n} · 12</i>
          <input placeholder={\`Cari klip\`} title={t("x")} alt="" />
          {toast("Tersimpan")}
        </section>
      );
    }
  `));
  assert.deepEqual(page.map((hit) => [hit.kind, hit.text]), [
    ["attr:aria-label", "Daftar klip"],
    ["jsx-text", "Buat klip"],
    ["jsx-text", "Teks literal"],
    ["attr:placeholder", "Cari klip"],
    ["toast", "Tersimpan"],
  ]);
  const view = hardcodedCopy(parseSource(`
    import x from "./Some Path.mjs";
    const MIME = "application/json";
    const KEY = "status.process.queued";
    export const A = "Klip belum siap. Coba lagi.";
    export const B = (n) => \`Diunggah \${n} klip\`;
  `), { viewModule: true });
  assert.deepEqual(view.map((hit) => hit.text), ["Klip belum siap. Coba lagi.", "Diunggah {} klip"]);
});

test("hard-coded copy per file never rises above the baseline, and the baseline follows it down", async () => {
  const now = await counts();
  if (process.env.UPDATE_I18N_BASELINE === "1") {
    const sorted = Object.fromEntries(Object.entries(now).sort(([a], [b]) => a.localeCompare(b)));
    await writeFile(BASELINE, `${JSON.stringify(sorted, null, 2)}\n`);
  }
  const baseline = JSON.parse(await readFile(BASELINE, "utf8"));
  const problems = [];
  for (const [file, count] of Object.entries(now)) {
    const allowed = baseline[file] ?? 0;
    if (count > allowed) problems.push(`${file}: ${count} hard-coded strings, the baseline allows ${allowed}`);
    if (count < allowed) problems.push(`${file}: down to ${count} from ${allowed}; lower it in tests/i18n-hardcoded.baseline.json`);
  }
  for (const [file, count] of Object.entries(baseline)) {
    if (!Object.hasOwn(now, file)) problems.push(`${file}: no hard-coded strings left (or gone), remove it from the baseline (was ${count})`);
    assert.ok(Number.isSafeInteger(count) && count > 0, `${file}: a baseline count is a positive integer`);
  }
  assert.deepEqual(problems, [], problems.join("\n"));
  assert.ok(Object.keys(now).length > 20, "the scan reaches the pages and components");
});

test("the files already on the catalog stay at zero", async () => {
  const now = await counts();
  const baseline = JSON.parse(await readFile(BASELINE, "utf8"));
  for (const file of ZERO) {
    assert.equal(now[file] ?? 0, 0, file);
    assert.equal(Object.hasOwn(baseline, file), false, file);
  }
});
