// CI guards for the owner's UI rules (AGENTS.md, DESIGN.md): no version wording on screen,
// every colour from the tokens on :root, every text/background pair the UI uses at WCAG AA.
// Each guard is first shown to catch a planted violation, then run on the real sources.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DARK_BACKDROPS,
  contrastRatio,
  findContrastFailures,
  findCssColourLiterals,
  findJsColourLiterals,
  VERSION_WORDING,
  findKitViolations,
  findVersionWording,
  jsSegments,
  listFiles,
  readSources,
  rootColourTokens,
} from "./support/ui-guards.mjs";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const TOKEN_FILE = "app/globals.css";

// Pages, components, the view and job libraries and the worker scripts all write text a user
// can see (labels, messages, stage texts). Tests and comments never render.
const TEXT_DIRS = ["app", "components", "lib", "scripts"];
const UI_DIRS = ["app", "components"];

const jsFiles = (dirs) => listFiles(WEB, dirs, [".js", ".jsx", ".mjs"]);
const cssFiles = () => listFiles(WEB, UI_DIRS, [".css"]);
const tokens = async () => rootColourTokens(await readFile(path.join(WEB, TOKEN_FILE), "utf8"));
const where = (hits) => hits.map((hit) => `${hit.file}:${hit.line} ${hit.text ?? hit.literal ?? ""}`).join("\n");

// 1. No version wording

const PLANTED_PAGE = `
// A comment may say V2, Selection V3 or "mesin lama": comments never render.
/* Mode lama */
import view from "../lib/selection-v3-view.mjs";
const mode = "v2-shadow";
const isV3Job = mode === "v3";
const V2_OPTION_KEYS = [];
const pattern = /"V2" or 'V3'/;
export default function Page() {
  return (
    <section aria-label="Mode lama">
      {/* V1 in a JSX comment */}
      <h1>Klip V2</h1>
      <p>Don't miss V1</p>
      {\`Dibuat \${mode} dengan mesin baru\`}
      <small>{isV3Job ? "Selection V3" : "llm-select"}</small>
    </section>
  );
}
`;

test("the version guard catches labels in JSX text, strings and templates, not in code or comments", () => {
  const found = findVersionWording("planted.jsx", PLANTED_PAGE).map((hit) => [hit.line, hit.text]);
  assert.deepEqual(found.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1])), [
    [11, "Mode lama"],
    [13, "V2"],
    [14, "V1"],
    [15, "mesin baru"],
    [16, "llm-select"],
    [16, "Selection V"],
    [16, "V3"],
  ]);
});

// Mode Cepat spec §5.4 (AC14): two views of one editor, so neither may be called the old or the
// new editor (or view) on screen. Comments may still say it.
const PLANTED_VIEWS = `
// The editor lama and the tampilan baru may be named in a comment.
const views = { cepat: "Cepat", lengkap: "Lengkap" };
const legacy = /tampilan lama/;
export function ViewSwitch() {
  return (
    <div aria-label="Tampilan editor">
      <button title="Kembali ke Editor Lama">{views.lengkap}</button>
      {\`Coba tampilan baru\`}
      <p>Mode Lengkap adalah editor baru</p>
      <small>{"Tampilan Lama"}</small>
    </div>
  );
}
`;

test("the version guard catches 'editor lama/baru' and 'tampilan lama/baru' in strings and JSX text", () => {
  const found = findVersionWording("planted-views.jsx", PLANTED_VIEWS).map((hit) => [hit.line, hit.text]);
  assert.deepEqual(found.sort((a, b) => a[0] - b[0]), [
    [8, "Editor Lama"],
    [9, "tampilan baru"],
    [10, "editor baru"],
    [11, "Tampilan Lama"],
  ]);
  // "Tampilan editor" (the switch's name) and the view names themselves are not version wording.
  assert.deepEqual(findVersionWording("ok.jsx", 'const a = "Tampilan editor"; const b = <p>Tampilan Cepat</p>;'), []);
});

test("the version guard reads the real pages: JSX text and strings are seen, comments are not", async () => {
  const source = await readFile(path.join(WEB, "app/dashboard/page.jsx"), "utf8");
  const segments = jsSegments(source);
  assert.ok(segments.some((segment) => segment.kind === "code" && /Unduh MP4/.test(segment.text)), "JSX text");
  assert.ok(segments.some((segment) => segment.kind === "string" && segment.text === "use client"), "string literal");
  const stage = await readFile(path.join(WEB, "lib/stage-detail.mjs"), "utf8");
  assert.ok(!jsSegments(stage).some((segment) => /Kandidat bayangan/.test(segment.text)), "comments are dropped");
});

test("no page, component, library or worker script puts version wording on screen", async () => {
  const sources = await readSources(WEB, await jsFiles(TEXT_DIRS));
  assert.ok(sources.length > 40, "the scan reaches the sources");
  const found = sources.flatMap(({ file, source }) => findVersionWording(file, source));
  assert.deepEqual(found, [], `version wording on screen (AGENTS.md "Latest only"):\n${where(found)}`);
});

test("no message of any locale's catalog carries version wording or an engine fallback name", async () => {
  // The catalogs are UI copy too (rombak 07 §7.5, §14), in every language.
  const { catalogLocales, flatten, readCatalog } = await import("./support/i18n-scan.mjs");
  const patterns = [...VERSION_WORDING, /engine_fallback/];
  const found = [];
  const locales = await catalogLocales();
  assert.ok(locales.includes("id") && locales.includes("en"));
  for (const locale of locales) {
    for (const [key, value] of flatten(await readCatalog(locale))) {
      if (typeof value !== "string") continue;
      for (const pattern of patterns) if (pattern.test(value)) found.push(`${locale}: ${key} ${value}`);
    }
  }
  assert.deepEqual(found, [], found.join("\n"));
});

// 2. Colours only from the tokens

test("the colour guard catches hex, colour functions and named colours outside the :root tokens", () => {
  const planted = `
:root { --brand: #dfff58; }
.a { color: #fff; }
.b { background: rgb(0 0 0 / 50%); }
.c { border: 1px solid white; }
.d { box-shadow: 0 0 0 1px color-mix(in srgb, var(--text) 10%, transparent); }
@media (max-width: 600px) { .e { outline-color: #12345678; } }
@keyframes glow { to { background: hsl(80 100% 67%); } }
.ok { color: var(--text); background: transparent; border-color: currentColor; content: "#FYP white"; white-space: nowrap; }
`;
  const asToken = findCssColourLiterals(TOKEN_FILE, planted, { tokenFile: true }).map((hit) => hit.literal);
  assert.deepEqual(asToken, ["#fff", "rgb(", "white", "color-mix(", "#12345678", "hsl("]);
  const elsewhere = findCssColourLiterals("app/x.module.css", planted).map((hit) => hit.literal);
  assert.deepEqual(elsewhere, ["#dfff58", ...asToken], "a :root outside globals.css defines no tokens");

  const jsx = `const a = <i style={{ color: "#ff0000", background: "white" }} />; const tag = "#fyp"; const b = "rgba(0,0,0,.4)";`;
  assert.deepEqual(findJsColourLiterals("planted.jsx", jsx).map((hit) => hit.literal), ["#ff0000", "white", "rgba(0,0,0,.4)"]);
});

test("every stylesheet colour comes from a token on :root", async () => {
  const sources = await readSources(WEB, await cssFiles());
  assert.ok(sources.some(({ file }) => file === TOKEN_FILE));
  const found = sources.flatMap(({ file, source }) => findCssColourLiterals(file, source, { tokenFile: file === TOKEN_FILE }));
  assert.deepEqual(found, [], `colour literals outside the tokens (docs/design/TOKENS.md):\n${where(found)}`);
});

test("pages and components carry no colour literal; the browser theme colour is the --bg token", async () => {
  const sources = await readSources(WEB, await jsFiles(UI_DIRS));
  const found = sources.flatMap(({ file, source }) => findJsColourLiterals(file, source));
  // Next's viewport.themeColor needs a literal, so it must equal --bg.
  const themeColor = found.filter((hit) => hit.file === "app/layout.jsx");
  assert.deepEqual(themeColor.map((hit) => hit.literal), [(await tokens()).bg]);
  const rest = found.filter((hit) => hit.file !== "app/layout.jsx");
  assert.deepEqual(rest, [], `colour literals in pages or components:\n${where(rest)}`);
});

// 3. WCAG AA for every pair the UI uses

test("the contrast formula is the WCAG one used by the antislop contrast checker", async () => {
  const skill = await readFile(path.join(WEB, "..", ".claude/skills/antislop-human/SKILL.md"), "utf8");
  const named = { white: "#ffffff", black: "#000000" };
  const rows = [...skill.matchAll(/^\| (\S+) on (\S+) \| ([\d.]+) \|/gm)];
  assert.ok(rows.length >= 6, "the reference table in antislop-human/SKILL.md");
  for (const [, text, background, ratio] of rows) {
    const hex = (value) => named[value.toLowerCase()] ?? value.toLowerCase();
    assert.equal(contrastRatio(hex(text), hex(background)).toFixed(2), ratio, `${text} on ${background}`);
  }
});

test("the contrast guard catches weak pairs, ink off its fill, a state on a new background and a named backdrop", async () => {
  const palette = await tokens();
  const planted = `
.weak { color: var(--border-strong); background: var(--surface); }
.lost { color: var(--accent-ink); }
.btn.primary { color: var(--accent-ink); background: var(--accent); }
.btn.primary:hover { background: var(--surface-3); }
.onLime { /* on: --accent */ color: var(--text); }
.unknown { color: var(--nope); background: var(--surface); }
.fine { color: var(--text-muted); background: var(--surface-2); }
.fine:hover { color: var(--text); }
.dot { background: var(--accent); }
`;
  const failures = findContrastFailures("planted.css", planted, palette);
  const summary = failures.map((failure) => `${failure.selector}: ${failure.text} on ${failure.background}`);
  assert.deepEqual(summary, [
    ".weak: border-strong on surface",
    ...DARK_BACKDROPS.map((backdrop) => `.lost: accent-ink on ${backdrop}`),
    ".btn.primary:hover: accent-ink on surface-3",
    ".onLime: text on accent",
    ".unknown: nope on surface",
  ]);
  assert.equal(failures[0].ratio, 3.57);
  assert.match(failures.at(-1).reason, /--nope is not a colour token/);

  // A token change that drops a used pair under AA fails the real stylesheets too.
  const dimmed = { ...palette, "text-muted": "#6b6d63" };
  const sources = await readSources(WEB, await cssFiles());
  assert.ok(sources.flatMap(({ file, source }) => findContrastFailures(file, source, dimmed)).some((failure) => failure.text === "text-muted"));
});

test("every text/background token pair the UI uses meets WCAG AA (4.5:1)", async () => {
  const palette = await tokens();
  const sources = await readSources(WEB, await cssFiles());
  // Every pair the stylesheets produce, so the check is known to reach the real rules.
  const used = new Set(sources.flatMap(({ file, source }) => findContrastFailures(file, source, palette, { minimum: Infinity })
    .map((pair) => `${pair.text} on ${pair.background}`)));
  for (const pair of ["text on bg", "text-muted on surface-2", "accent-ink on accent", "accent-ink on accent-hover", "danger-ink on danger", "info on surface"]) {
    assert.ok(used.has(pair), `the guard sees ${pair}`);
  }
  const failures = sources.flatMap(({ file, source }) => findContrastFailures(file, source, palette));
  assert.deepEqual(failures, [], `pairs under AA:\n${failures.map((f) => `${f.file}:${f.line} ${f.selector}: --${f.text} on --${f.background} ${f.ratio ?? f.reason}`).join("\n")}`);
});

// 4. The UI kit conventions (docs/plans/2026-10-24-rombak/05-ui-dashboard.md §2 P1/P2/P9/P11, §3.8)

test("the version guard also catches engine codes and 'Latest only' shown as copy", () => {
  const planted = `
// engine_fallback and Latest only in a comment never render.
const CODES = ["no_face", "engine_fallback"];
const TEXT = { engine_fallback: "Dirender dengan cara cadangan" };
const pick = (reasons) => reasons.engine_fallback ?? reasons?.engine_fallback;
export function Note() {
  return (
    <div>
      <p>engine_fallback</p>
      <small>{"Gagal: engine_fallback"}</small>
      <b>Latest only</b>
    </div>
  );
}
`;
  const found = findVersionWording("planted-codes.jsx", planted).map((hit) => [hit.line, hit.text]);
  assert.deepEqual(found.sort((a, b) => a[0] - b[0]), [
    [9, "engine_fallback"],
    [10, "engine_fallback"],
    [11, "Latest only"],
  ]);
});

const PLANTED_KIT = `
import { Alert, Button, Chip } from "@heroui/react";
export default function Page() {
  return (
    <section>
      <PageHead title="Proyek">
        <p>Semua proyek Anda.</p>
      </PageHead>
      <div className="flex gap-4 bg-red-500 text-[#ff0000]">
        <span className={\`p-2 \${on ? "border-slate-200" : "md:hover:text-zinc-950/50"}\`} />
        <span className="gap-red-ish rounded-lg text-muted" />
      </div>
      <Button onPress={go}>Tanpa varian</Button>
      <Button variant="primary">Satu</Button>
      <Button
        size="sm"
        variant="primary"
      >Dua</Button>
      <Button variant="outline">Garis</Button>
      <Button variant={"danger-soft"}>Merah lembut</Button>
      <Button variant="ghost" onPress={() => set({ a: 1 })}>Ghost</Button>
      <Chip color="accent">Lime</Chip>
      <Alert status="accent" />
    </section>
  );
}
`;

test("the kit guard catches palette classes, a Button without variant, banned variants, two primaries and <p> in PageHead", () => {
  const hits = findKitViolations("app/planted/page.jsx", PLANTED_KIT).map((hit) => `${hit.line} ${hit.rule}: ${hit.text}`);
  assert.deepEqual(hits, [
    "7 pagehead-sentence: <p>",
    "9 palette-class: bg-red-500",
    "9 arbitrary-colour: text-[#",
    "10 palette-class: border-slate-200",
    "10 palette-class: md:hover:text-zinc-950/50",
    "13 button-variant: <Button onPress={go}>",
    "19 button-variant-banned: outline",
    "20 button-variant-banned: danger-soft",
    "22 accent-status: <Chip color=\"accent\">",
    "23 accent-status: <Alert status=\"accent\" />",
    "15 primary-count: 2 primary buttons in one file",
  ]);
  // Layout utilities, semantic HeroUI names and tokens are fine.
  assert.deepEqual(findKitViolations("components/ok.jsx", `
import { Button } from "@heroui/react";
const a = <div className="flex gap-4 p-2 text-muted bg-surface"><Button variant="secondary">Ok</Button></div>;`), []);
  // A Button that is not HeroUI's (no import from @heroui/react or components/ui) is left alone.
  assert.deepEqual(findKitViolations("components/editor/x.jsx", `const a = <Button onClick={go}>Ok</Button>;`), []);
});

test("pages and components follow the UI kit conventions", async () => {
  const sources = await readSources(WEB, await jsFiles(UI_DIRS));
  const found = sources.flatMap(({ file, source }) => findKitViolations(file, source));
  assert.deepEqual(found, [], `UI kit rules (05-ui-dashboard.md §3.8):\n${found.map((hit) => `${hit.file}:${hit.line} ${hit.rule}: ${hit.text}`).join("\n")}`);
});
