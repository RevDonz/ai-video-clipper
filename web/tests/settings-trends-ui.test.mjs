// Pengaturan (/settings), Konteks Tren (/trends) and the small pages (404, error): the owner's
// "latest only" rule (no version or engine wording on screen), the dark design tokens
// (docs/design/TOKENS.md) and copy without em dashes (antislop R-02).
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { KEY_UNREADABLE_MESSAGE } from "../lib/llm-settings.mjs";
import { llmReasonText, readLlmStatus } from "../lib/llm-status.mjs";
import { notFoundLinks } from "../lib/not-found-view.mjs";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFile(path.join(WEB, relative), "utf8");

async function filesUnder(dir, pattern) {
  const out = [];
  for (const entry of await readdir(path.join(WEB, dir), { withFileTypes: true })) {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await filesUnder(relative, pattern));
    else if (pattern.test(entry.name)) out.push(relative);
  }
  return out;
}

// Comments and import paths may name the engine or the spec; only what can reach the screen
// is checked.
function withoutComments(source) {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1")
    .replace(/^import\b[^;]*;$/gm, "");
}

const SMALL_PAGES = ["app/not-found.jsx", "app/error.jsx", "app/global-error.jsx", "components/NotFoundActions.jsx"];

async function pageSources() {
  const files = [
    ...await filesUnder("app/settings", /\.(jsx?|mjs)$/),
    ...await filesUnder("app/trends", /\.(jsx?|mjs)$/),
    ...await filesUnder("components/trends", /\.(jsx?|mjs)$/),
    ...SMALL_PAGES,
  ];
  return Promise.all(files.map(async (file) => [file, withoutComments(await read(file))]));
}

// Libraries whose strings the two pages render (status labels, token rows, error messages).
const DISPLAY_LIBS = [
  "lib/llm-status.mjs", "lib/llm-settings.mjs", "lib/llm-settings-view.mjs", "lib/llm-settings-actions.mjs", "lib/llm-settings-http.mjs",
  "lib/llm-presets.mjs", "lib/trend-view.mjs", "lib/trend-context.mjs", "lib/ingest-tokens.mjs", "lib/not-found-view.mjs",
  "app/api/llm/status/route.js", "app/api/settings/llm/route.js", "app/api/settings/llm/test/route.js", "app/api/settings/llm/models/route.js",
  "app/api/settings/llm/import-env/route.js", "app/api/context/trends/route.js", "app/api/context/trends/[id]/route.js",
  "app/api/context/trends/settings/route.js", "app/api/context/tokens/route.js", "app/api/context/tokens/[id]/route.js",
];

// --- Latest only ----------------------------------------------------------------------------

test("Pengaturan, Konteks Tren and the error pages show no version or engine wording", async () => {
  // "/v1" in an API address the user types (OpenAI-compatible base URL) is not a version label.
  for (const [file, source] of await pageSources()) {
    assert.doesNotMatch(source, /(?<!\/)\b[Vv][1-3]\b|Selection V|\bversi\b|\bmesin\b|Mode lama|\blegacy\b/i, file);
  }
});

test("Konteks Tren says its switch applies to the next job, without naming an engine", async () => {
  const page = withoutComments(await read("app/trends/page.jsx"));
  assert.match(page, /Berlaku untuk job berikutnya\./);
});

// --- Copy -----------------------------------------------------------------------------------

test("no em dash reaches the screen from the two pages, the error pages or their helpers", async () => {
  for (const [file, source] of await pageSources()) assert.doesNotMatch(source, /—/, file);
  for (const file of DISPLAY_LIBS) assert.doesNotMatch(withoutComments(await read(file)), /—/, file);
});

test("the AI status labels on Pengaturan name the fallback in a second sentence", () => {
  const secret = { APP_SESSION_SECRET: "s".repeat(40) };
  assert.equal(readLlmStatus({ ...secret, POTONGIN_LLM: "off" }).label, "LLM dimatikan (POTONGIN_LLM=off). Memakai heuristik lokal.");
  assert.equal(readLlmStatus({ POTONGIN_LLM_PROVIDERS: "gemini!" }).label, "Konfigurasi LLM tidak valid. Memakai heuristik lokal.");
  assert.equal(readLlmStatus({ POTONGIN_LLM_PROVIDER: "gemini" }).label, "LLM belum siap (gemini: API key belum diisi). Memakai heuristik lokal.");
  assert.equal(llmReasonText("key_unreadable"), "key tersimpan tidak bisa dibuka, isi ulang");
  assert.equal(KEY_UNREADABLE_MESSAGE, "Key tersimpan tidak bisa dibuka. Isi ulang.");
});

test("the pages say 'Anda', never 'kamu'", async () => {
  for (const [file, source] of await pageSources()) assert.doesNotMatch(source, /\bkamu\b/i, file);
});

// --- Tokens ---------------------------------------------------------------------------------

const OWN_STYLESHEETS = ["app/settings/settings.css", "app/trends/trends.css", "components/trends/TrendChips.module.css", "app/status-page.css"];

test("the pages' stylesheets use the design tokens, never literal colours", async () => {
  for (const file of OWN_STYLESHEETS) {
    const css = (await read(file)).replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, `${file}: hex colour`);
    assert.doesNotMatch(css, /\b(rgba?|hsla?|oklch|lab|lch)\(/i, `${file}: colour function`);
    assert.doesNotMatch(css, /:\s*[^;{}]*\b(white|black|red|blue|green|grey|gray)\b/i, `${file}: named colour`);
    assert.match(css, /var\(--/, `${file} reads the tokens`);
  }
});

test("the pages' stand-alone links and chips are 44 px tap targets on a phone", async () => {
  const rule = (css, selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return [...css.matchAll(new RegExp(`(?:^|[},])\\s*${escaped}\\s*\\{([^}]*)\\}`, "gm"))].map((match) => match[1]).join(";");
  };
  const settings = (await read("app/settings/settings.css")).replace(/\/\*[\s\S]*?\*\//g, "");
  const trends = (await read("app/trends/trends.css")).replace(/\/\*[\s\S]*?\*\//g, "");
  // "Dokumentasi ↗" / "Ambil API key ↗" on the provider cards and the Hermes guide link.
  assert.match(rule(settings, ".presetActions a"), /min-height:\s*44px/);
  assert.match(rule(trends, ".trGuideLink"), /min-height:\s*44px/);
  // A one-letter platform chip ("X") is still a full target.
  assert.match(rule(trends, ".trPlatforms label"), /min-width:\s*44px/);
});

test("the pages keep the global focus ring: no outline removal, no private ring colour", async () => {
  for (const file of OWN_STYLESHEETS) {
    const css = await read(file);
    assert.doesNotMatch(css, /outline\s*:\s*(none|0)\b/i, file);
    assert.doesNotMatch(css, /outline\s*:[^;]*#/i, file);
  }
});

test("the pages do not restyle the shared building blocks globally", async () => {
  for (const file of ["app/settings/settings.css", "app/trends/trends.css"]) {
    const css = (await read(file)).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const selector of ["chip", "btn", "panel", "notice", "segmented"]) {
      // A selector that starts with the block restyles it everywhere; ".inlineRow .btn" does not.
      assert.doesNotMatch(css, new RegExp(`(^|[},])\\s*\\.${selector}\\b[^{]*\\{`, "m"), `${file} overrides .${selector}`);
    }
  }
});

test("no bare tone class in globals.css leaks onto .chip.error, .notice.error or a page's own tones", async () => {
  const css = (await read("app/globals.css")).replace(/\/\*[\s\S]*?\*\//g, "");
  for (const tone of ["error", "ok", "warning", "info", "muted", "success", "danger"]) {
    assert.doesNotMatch(css, new RegExp(`(^|[},])\\s*\\.${tone}\\s*[{,]`, "m"), `a bare .${tone} rule restyles every element with that tone`);
  }
});

test("both pages hang their buttons on the shared .btn and lime only on the main action", async () => {
  const settings = await read("app/settings/page.jsx");
  const trends = [
    await read("app/trends/page.jsx"),
    ...await Promise.all((await filesUnder("components/trends", /\.jsx$/)).map(read)),
  ].join("\n");
  for (const [name, source] of [["settings", settings], ["trends", trends]]) {
    assert.doesNotMatch(source, /className="(primaryAction|secondaryAction|trPrimary|trSecondary|iconButton|confirmDelete|saveEditor|discard)\b/, name);
    assert.match(source, /className="btn primary"/, `${name} has a primary action`);
  }
  assert.equal(settings.match(/btn primary/g).length, 3, "Simpan, the retry after a failed load, and the .env import");
});

// --- Small pages ----------------------------------------------------------------------------

const JOB = "0f8fad5b-d9cb-469f-a165-70867728950e";

test("a missing page inside a project links back to that project", () => {
  assert.deepEqual(notFoundLinks(`/projects/${JOB}/candidates/abc/edit`), [
    { href: `/projects/${JOB}`, label: "Buka proyek ini", primary: true },
    { href: "/projects", label: "Buka Riwayat", primary: false },
  ]);
  assert.deepEqual(notFoundLinks(`/projects/${JOB.toUpperCase()}/x`)[0].href, `/projects/${JOB.toUpperCase()}`);
});

test("any other missing page offers Riwayat first and a new clip second", () => {
  const fallback = [
    { href: "/projects", label: "Buka Riwayat", primary: true },
    { href: "/dashboard", label: "Buat klip", primary: false },
  ];
  for (const pathname of ["/nope", "/projects/not-a-job/x", `/projects/${JOB}`, "/projects//x", `/projects/${JOB}x/y`, "", null, undefined, 7]) {
    assert.deepEqual(notFoundLinks(pathname), fallback, String(pathname));
  }
});

test("the 404 page is Indonesian, carries the shared header and its own title", async () => {
  const page = await read("app/not-found.jsx");
  assert.match(page, /<AppHeader \/>/);
  assert.match(page, /title: "Halaman tidak ditemukan"/);
  assert.match(page, /<h1[^>]*>Halaman tidak ditemukan<\/h1>/);
  assert.match(page, /<NotFoundActions \/>/);
  // The 404 HTML is prerendered without the requested path: the first render must match it
  // (no path), and the project link appears once the browser knows where it is.
  const actions = await read("components/NotFoundActions.jsx");
  assert.match(actions, /^"use client";/);
  assert.doesNotMatch(actions, /usePathname/);
  assert.match(actions, /useState\(null\)/);
  assert.match(actions, /useEffect\(\(\) => \{\s*setPathname\(window\.location\.pathname\);\s*\}, \[\]\);/);
  assert.match(actions, /notFoundLinks\(pathname\)/);
});

test("the error page is a client boundary that retries and keeps the header", async () => {
  const page = await read("app/error.jsx");
  assert.match(page, /^"use client";/);
  assert.match(page, /export default function \w+\(\{ reset \}\)/);
  assert.match(page, /onClick=\{\(\) => reset\(\)\}/);
  assert.match(page, /<AppHeader current=\{pathname\} \/>/);
  assert.match(page, />Coba lagi</);
  assert.doesNotMatch(page, /error\.(message|stack|digest)/, "technical detail stays in the server log");
});

test("the root error page renders its own Indonesian document", async () => {
  const page = await read("app/global-error.jsx");
  assert.match(page, /^"use client";/);
  assert.match(page, /<html lang="id"/);
  assert.match(page, /import "\.\/globals\.css";/);
  assert.match(page, /onClick=\{\(\) => reset\(\)\}/);
  assert.doesNotMatch(page, /error\.(message|stack|digest)/);
});
