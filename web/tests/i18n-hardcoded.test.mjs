// The ratchet on UI copy written in the code (rombak 07 §14): JSX text, copy attributes
// (aria-label, placeholder, title, alt, label) with literal values, toast("…"), the string
// branches of ?: and &&/||/?? in those places, and sentences in view modules, counted per file. The count of a file may only go down, and the baseline must
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
// View modules of 07 §8.3: lib/*-view.mjs plus the named ones that build UI text.
const VIEW_MODULE = /^lib\/(?:[^/]+-view|dashboard-choices|stage-summary|clip-text|llm-presets|source-language)\.mjs$/;
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
  // The one-layout editor's transcript parts (rombak 06 §6, Editor F2).
  "components/editor/transcript/LinesView.jsx",
  "components/editor/transcript/ReviewDrawer.jsx",
  "components/editor/transcript/TranscriptHead.jsx",
  "lib/i18n/client.jsx",
  // The shell (Dashboard F1, 08 Fase 1: ratchet 0 for AppShell).
  "components/AppShell.jsx",
  "components/NavList.jsx",
  "components/AccountMenu.jsx",
  "components/ShellData.jsx",
  "components/ui/UiPrefs.jsx",
  "components/ui/Providers.jsx",
  // i18n M1 (08 Fase 1: ratchet 0 for login, not-found, error) and the language picker.
  "app/login/page.jsx",
  "app/login/layout.jsx",
  "lib/login-view.mjs",
  "app/not-found.jsx",
  "app/error.jsx",
  "components/NotFoundActions.jsx",
  "lib/not-found-view.mjs",
  "components/LanguageSwitcher.jsx",
  "components/ui/PublicCard.jsx",
  // Buat klip and the project page (Dashboard F2/F3, i18n M3 part, 08 Fase 2: ratchet 0 per file touched).
  "app/dashboard/page.jsx",
  "app/dashboard/FocusField.jsx",
  "app/dashboard/RecentProjects.jsx",
  "app/dashboard/LookPreview.jsx",
  "lib/dashboard-view.mjs",
  "lib/dashboard-choices.mjs",
  "lib/selection-v3-view.mjs",
  "lib/trend-view.mjs",
  "app/projects/[id]/layout.jsx",
  "app/projects/[id]/page.jsx",
  "app/projects/[id]/ClipsSection.jsx",
  "app/projects/[id]/DeleteProject.jsx",
  "components/ChoiceChip.jsx",
  "components/ClipViewer.jsx",
  "components/ProjectProgress.jsx",
  "components/ProcessStatus.jsx",
  "components/CancelJob.jsx",
  "components/layout-names.jsx",
  "components/ui/AlertDialog.jsx",
  // The landing (i18n M3 with Dashboard F3).
  "app/page.jsx",
  "components/LandingClip.jsx",
  "components/ClipText.jsx",
  "components/HookSwitch.jsx",
  "components/StageSummary.jsx",
  // Dashboard F4 (08 Fase 3): Proyek and its Klip tab.
  "app/projects/page.jsx",
  "components/ClipLibrary.jsx",
  "lib/clip-library-view.mjs",
  "lib/projects-list-view.mjs",
  // Dashboard F6 (08 Fase 3): Tren.
  "app/trends/page.jsx",
  "components/trends/CopyButton.jsx",
  "components/trends/TokenModal.jsx",
  "components/trends/TrendAgentPanel.jsx",
  "components/trends/TrendFormModal.jsx",
  "components/trends/TrendList.jsx",
  // Pengaturan (Dashboard F5, 08 Fase 3: ratchet 0 for every dashboard route) and its view modules.
  "app/settings/page.jsx",
  "app/settings/AiSettings.jsx",
  "app/settings/AddProviderModal.jsx",
  "app/settings/CardState.jsx",
  "app/settings/DefaultLogoCard.jsx",
  "app/settings/DefaultWatermarkCard.jsx",
  "app/settings/SettingsSave.jsx",
  "app/settings/SystemCard.jsx",
  "app/settings/TranscriptionCard.jsx",
  "app/settings/YoutubeCookiesCard.jsx",
  "app/settings/view-text.jsx",
  "lib/llm-settings-view.mjs",
  "lib/transcription-settings-view.mjs",
  "lib/default-logo-view.mjs",
  "lib/default-watermark-view.mjs",
  "lib/youtube-cookies-view.mjs",
  "lib/system-info-view.mjs",
  // Bantuan (Dashboard F10, i18n M4; 08 Fase 3).
  "app/bantuan/page.jsx",
  "app/bantuan/HelpSearch.jsx",
  "app/bantuan/HelpGuide.jsx",
  "lib/help-view.mjs",
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
  const branches = hardcodedCopy(parseSource(`
    export function B({ busy, err, x, open, t, mode }) {
      return (
        <>
          <button>{busy ? "Menyimpan…" : "Simpan"}</button>
          {err && "Gagal memuat"}
          {mode === "full" ? t("a") : null}
          <p>{x || "Belum ada"}{x ?? \`Kosong\`}</p>
          <input placeholder={x ? "Tambah kata kunci…" : (open ? "contoh: podcast" : "")} />
          <a aria-label={open ? "Tutup menu" : "Buka menu"} className={open ? "is open" : "is closed"} />
          {toast(busy ? "Tersimpan" : t("b"))}
        </>
      );
    }
  `));
  assert.deepEqual(branches.map((hit) => [hit.kind, hit.text]), [
    ["jsx-text", "Menyimpan…"],
    ["jsx-text", "Simpan"],
    ["jsx-text", "Gagal memuat"],
    ["jsx-text", "Belum ada"],
    ["jsx-text", "Kosong"],
    ["attr:placeholder", "Tambah kata kunci…"],
    ["attr:placeholder", "contoh: podcast"],
    ["attr:aria-label", "Tutup menu"],
    ["attr:aria-label", "Buka menu"],
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

test("the named view modules of 07 §8.3 are scanned as view modules", () => {
  for (const file of ["lib/dashboard-view.mjs", "lib/dashboard-choices.mjs", "lib/stage-summary.mjs", "lib/clip-text.mjs", "lib/llm-presets.mjs", "lib/source-language.mjs", "lib/selection-v3-view.mjs"]) {
    assert.ok(VIEW_MODULE.test(file), file);
  }
  assert.equal(VIEW_MODULE.test("lib/jobs.mjs"), false);
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

// 08 Fase 3: every existing dashboard route (Buat klip, Proyek and one project, Pengaturan, Tren,
// Bantuan) and the shared components those pages draw hold no copy of their own.
const DASHBOARD_ROUTES = /^app\/(?:dashboard|projects|settings|trends|bantuan)\//;
const DASHBOARD_SHARED = Object.freeze(["components/ClipPoster.jsx", "components/trends/TrendChips.jsx"]);

test("every file of the dashboard routes stays at zero", async () => {
  const now = await counts();
  const baseline = JSON.parse(await readFile(BASELINE, "utf8"));
  const files = (await listSources(["app"])).filter((file) => DASHBOARD_ROUTES.test(file) && UI_FILE.test(file));
  assert.ok(files.length >= 25, `the dashboard routes are scanned (${files.length})`);
  for (const file of [...files, ...DASHBOARD_SHARED]) {
    assert.equal(now[file] ?? 0, 0, file);
    assert.equal(Object.hasOwn(baseline, file), false, file);
  }
});
