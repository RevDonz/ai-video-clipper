// The UI foundation of the app pages (docs/plans/2026-10-24-rombak/05-ui-dashboard.md §3):
// globals.css in cascade layers with its tokens outside them, HeroUI and Tailwind (no preflight)
// only through app/ui.css, which only the shell and the public card import, so the editor's CSS
// and bundle stay as they are. Navigation stays full-document (no RouterProvider).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { cssRules, jsSegments, listFiles, readSources } from "./support/ui-guards.mjs";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFile(path.join(WEB, relative), "utf8");
const LAYER_ORDER = "@layer theme, base, components, utilities;";
const REDUCED_MOTION = "@media (prefers-reduced-motion: reduce)";
const EDIT_ROUTE = "app/projects/[id]/clips/[clipId]/edit";
const UI_IMPORTERS = ["components/AppShell.jsx", "components/ui/PublicCard.jsx"];

// The component stylesheets ui.css takes from @heroui/styles (05 §3.3): importing one is using it.
const HEROUI_COMPONENTS = [
  "button", "close-button", "link", "toggle-button", "toggle-button-group", "tabs", "pagination",
  "popover", "dropdown", "menu", "menu-item", "menu-section", "drawer", "modal", "alert-dialog", "toast",
  "label", "description", "field-error", "input", "textfield", "textarea", "search-field", "number-field",
  "select", "combo-box", "list-box", "list-box-item", "list-box-section", "switch", "checkbox",
  "checkbox-group", "radio", "radio-group", "table", "chip", "tag", "tag-group", "avatar", "card",
  "progress-bar", "meter", "skeleton", "empty-state", "alert", "disclosure", "separator", "kbd",
];
const DATE_PICKER_COMPONENTS = ["date-picker", "date-field", "date-input-group", "calendar"];

const imports = (css) => [...css.matchAll(/^@import\s+"([^"]+)"([^;]*);/gm)].map((match) => ({ spec: match[1], rest: match[2].trim() }));

/** Resolves a CSS @import of a package the way the bundler does: package.json exports, "style" first. */
async function resolvePackageCss(spec) {
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const subpath = `.${spec.slice(name.length)}` || ".";
  const root = path.join(WEB, "node_modules", name);
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const pick = (target) => (typeof target === "string" ? target : target?.style ?? target?.default ?? null);
  const key = subpath === "." ? "." : subpath;
  if (pkg.exports) {
    if (pkg.exports[key] !== undefined) return path.join(root, pick(pkg.exports[key]));
    // Node's order for subpath patterns: the longest part before "*" first, then the longest key.
    const patterns = Object.entries(pkg.exports).filter(([pattern]) => pattern.includes("*"))
      .sort(([a], [b]) => b.indexOf("*") - a.indexOf("*") || b.length - a.length);
    for (const [pattern, target] of patterns) {
      const [head, tail] = pattern.split("*");
      if (key.startsWith(head) && key.endsWith(tail) && key.length >= head.length + tail.length) {
        const star = key.slice(head.length, key.length - tail.length);
        const resolved = pick(target);
        if (resolved) return path.join(root, resolved.replace("*", star));
      }
    }
    return null;
  }
  return path.join(root, key === "." ? pkg.style ?? pkg.main : key);
}

test("globals.css opens with the layer order, keeps tokens and reduced motion unlayered, the rest in base", async () => {
  const css = await read("app/globals.css");
  assert.equal(css.split("\n")[0], LAYER_ORDER);
  assert.doesNotMatch(css, /@import\b/, "globals.css imports neither Tailwind nor HeroUI");
  const rules = cssRules(css);
  const root = rules.filter((rule) => rule.selector === ":root");
  assert.ok(root.some((rule) => rule.at.length === 0), ":root tokens outside any layer");
  assert.ok(rules.some((rule) => rule.at.length === 1 && rule.at[0] === REDUCED_MOTION), "reduced motion outside any layer");
  for (const rule of rules) {
    if (rule.at.some((at) => at.startsWith("@keyframes"))) continue;
    if (rule.at.length === 0 && rule.selector === ":root") continue;
    if (rule.at[0] === REDUCED_MOTION) continue;
    assert.equal(rule.at[0], "@layer base", `${rule.selector} (line ${rule.line}) is in @layer base`);
  }
  // Retired blocks (05 §3.2 step 5): the unused table styles, and chip, now statusPill.
  assert.doesNotMatch(css, /\.tableWrap\b|\.table\b/);
  assert.doesNotMatch(css, /\.chip\b/);
  assert.match(css, /\.statusPill \{/);
});

test("ui.css brings Tailwind without preflight and HeroUI per component, every import a real file", async () => {
  const css = await read("app/ui.css");
  const list = imports(css);
  assert.ok(list.length > 10);
  assert.deepEqual(list.slice(0, 5).map((entry) => `${entry.spec} ${entry.rest}`.trim()), [
    "tailwindcss/theme.css layer(theme)",
    "./ui-theme-reset.css layer(theme)",
    "tailwindcss/utilities.css layer(utilities)",
    "tw-animate-css",
    "@heroui/styles/base layer(base)",
  ]);
  assert.ok(!list.some((entry) => entry.spec === "tailwindcss" || /preflight/.test(entry.spec)), "no preflight");
  const components = list.filter((entry) => entry.spec.startsWith("@heroui/styles/components/"));
  assert.deepEqual(components.map((entry) => entry.spec.replace("@heroui/styles/components/", "").replace(/\.css$/, "")), HEROUI_COMPONENTS);
  for (const entry of components) assert.equal(entry.rest, "layer(components)", entry.spec);
  assert.ok(list.some((entry) => entry.spec === "@heroui/styles/themes/default" && entry.rest === "layer(theme)"));
  for (const entry of list) {
    const file = entry.spec.startsWith("./") ? path.join(WEB, "app", entry.spec) : await resolvePackageCss(entry.spec);
    assert.ok(file && existsSync(file), `${entry.spec} resolves to a file (${file})`);
  }
  assert.match(css, /@source not "\.\.\/components\/editor";/);
  assert.match(css, /@source not "\.\/parity-harness";/);
  assert.match(css, /@theme \{[^}]*--font-sans: var\(--font\);/);
  // The default palette goes before HeroUI's theme names its colours, so bg-red-500 never exists.
  // White and black stay for HeroUI's switch thumb, pointed at its primitives (aliased to tokens).
  const reset = (await read("app/ui-theme-reset.css")).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(reset, /@theme \{\s*--color-\*: initial;\s*--color-white: var\(--white\);\s*--color-black: var\(--black\);\s*\}/);
});

test("the date picker's stylesheets live apart, for the lazily loaded DatePicker only", async () => {
  const css = await read("components/ui/date-picker.css");
  const list = imports(css);
  assert.deepEqual(list.map((entry) => entry.spec.replace("@heroui/styles/components/", "").replace(/\.css$/, "")), DATE_PICKER_COMPONENTS);
  for (const entry of list) {
    assert.equal(entry.rest, "layer(components)");
    assert.ok(existsSync(await resolvePackageCss(entry.spec)), entry.spec);
  }
  const ui = await read("app/ui.css");
  for (const name of DATE_PICKER_COMPONENTS) assert.doesNotMatch(ui, new RegExp(`components/${name}\\.css`));
  const importers = (await readSources(WEB, await listFiles(WEB, ["app", "components"], [".js", ".jsx", ".mjs"])))
    .filter(({ source }) => /date-picker\.css/.test(source)).map(({ file }) => file);
  assert.deepEqual(importers, ["components/ui/DatePicker.jsx"]);
});

test("the component overrides keep 44 px targets, Potongin's radius and selection without lime", async () => {
  const css = (await read("app/ui.css")).replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = cssRules(css);
  const layered = rules.filter((rule) => rule.at.includes("@layer components"));
  const find = (part) => layered.filter((rule) => rule.selector.split(",").map((s) => s.trim()).includes(part));
  for (const target of [".button", ".tabs__tab", ".menu-item", ".list-box-item", ".close-button", ".toggle-button", ".pagination__link", ".tag__remove-button"]) {
    const decls = find(target).flatMap((rule) => rule.decls);
    assert.ok(decls.some((decl) => decl.prop === "min-height" && decl.value === "44px"), `${target} min-height`);
    assert.ok(decls.some((decl) => decl.prop === "min-width" && decl.value === "44px"), `${target} min-width`);
  }
  assert.ok(find(".button").some((rule) => rule.decls.some((decl) => decl.prop === "border-radius" && decl.value === "var(--radius-m)")));
  const selected = layered.filter((rule) => /\[data-selected\]/.test(rule.selector));
  assert.ok(selected.length >= 2);
  for (const rule of selected) {
    for (const decl of rule.decls) assert.doesNotMatch(decl.value, /--accent\b/, `${rule.selector} uses no lime`);
  }
  assert.ok(rules.some((rule) => rule.at.includes("@media (forced-colors: active)")), "a forced-colors block");
  // Every class the overrides name is one HeroUI 3.2.6 ships, so a rename on upgrade fails here.
  const shipped = (await Promise.all(HEROUI_COMPONENTS.map((name) => read(`node_modules/@heroui/styles/dist/components/${name}.css`)))).join("\n");
  const names = new Set([...css.matchAll(/\.([a-z][a-z0-9-]*(?:__[a-z0-9-]+)?(?:--[a-z0-9-]+)?)/g)].map((match) => match[1]));
  for (const name of names) {
    if (["statusPill"].includes(name)) continue;
    assert.ok(new RegExp(`\\.${name.replace(/[-_]/g, "[-_]")}\\b|&${name.slice(name.search(/__|--/))}\\b`).test(shipped), `.${name} is a HeroUI 3.2.6 class`);
  }
});

test("only the shell and the public card import ui.css; the editor reaches neither ui.css nor HeroUI", async () => {
  const sources = await readSources(WEB, await listFiles(WEB, ["app", "components"], [".js", ".jsx", ".mjs", ".css"]));
  // An import (JS or CSS) emits ui.css; date-picker.css only @reference-s it for its @apply rules.
  const importers = sources.filter(({ source }) => /(?:^|\s)@?import\s+["'][./]*(?:app\/)?ui\.css["']/m.test(source)).map(({ file }) => file);
  const references = sources.filter(({ source }) => /ui\.css["']/.test(source)).map(({ file }) => file);
  assert.deepEqual(references.sort(), [...UI_IMPORTERS, "components/ui/date-picker.css"].sort());
  assert.match(sources.find((entry) => entry.file === "components/ui/date-picker.css").source, /^@reference "\.\.\/\.\.\/app\/ui\.css";$/m);
  assert.deepEqual(importers.sort(), [...UI_IMPORTERS].sort());
  for (const file of UI_IMPORTERS) assert.match(sources.find((entry) => entry.file === file).source, /^import "(?:\.\.\/)+app\/ui\.css";$/m, file);
  const editorSide = sources.filter(({ file }) => file.startsWith("components/editor/") || file.startsWith(EDIT_ROUTE) || file.startsWith("app/parity-harness/"));
  assert.ok(editorSide.length > 20, "the scan reaches the editor");
  for (const { file, source } of editorSide) {
    assert.doesNotMatch(source, /ui\.css|@heroui\/|react-aria-components|tailwindcss/, file);
    for (const match of source.matchAll(/(?:from|import)\s+["'](\.[^"']+)["']/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
      assert.ok(!target.startsWith("components/ui/") && target !== "app/ui.css", `${file} imports ${target}`);
    }
  }
  const editorLayouts = sources.filter(({ file }) => file.startsWith(EDIT_ROUTE));
  for (const { file, source } of editorLayouts) assert.doesNotMatch(source, /AppShell|PublicCard|Providers/, file);
});

test("no RouterProvider anywhere, and every editor link outside the editor is a plain <a href>", async () => {
  const sources = await readSources(WEB, await listFiles(WEB, ["app", "components"], [".js", ".jsx", ".mjs"]));
  for (const { file, source } of sources) {
    const code = jsSegments(source).map((segment) => segment.text).join("\n");
    assert.doesNotMatch(code, /RouterProvider/, file);
  }
  for (const { file, source } of sources) {
    if (file.startsWith("components/editor/") || file.startsWith(EDIT_ROUTE)) continue;
    for (const match of source.matchAll(/editorHref\(/g)) {
      const before = source.slice(Math.max(0, match.index - 200), match.index);
      assert.match(before, /(?:<a\b[^>]*|<Dropdown\.Item\b[^>]*)\shref=\{\s*$/, `${file}: editorHref ends in an <a href> or Dropdown.Item href`);
    }
  }
});

test("the root html is dark for HeroUI, and Providers carries the React Aria locale without routing", async () => {
  const layout = await read("app/layout.jsx");
  assert.match(layout, /<html lang="id" className=\{dmSans\.variable\} data-theme="dark">/);
  assert.doesNotMatch(layout, /@heroui|react-aria|Providers|ui\.css/, "the root layout stays free of the kit (the editor renders under it)");
  const providers = await read("components/ui/Providers.jsx");
  assert.match(providers, /^"use client";/);
  assert.match(providers, /import \{ I18nProvider \} from "react-aria-components";/);
  assert.match(providers, /<I18nProvider locale=\{locale\}>/);
  for (const file of UI_IMPORTERS) assert.match(await read(file), /<Providers\b/, `${file} renders Providers`);
  const card = await read("components/ui/PublicCard.jsx");
  assert.match(card, /import Providers from "\.\/Providers\.jsx";/);
  const login = await read("app/login/page.jsx");
  assert.match(login, /import PublicCard from "\.\.\/\.\.\/components\/ui\/PublicCard\.jsx";/);
  assert.doesNotMatch(login, /ui\.css/, "/login takes ui.css through PublicCard");
});

test("postcss runs Tailwind's plugin and nothing else", async () => {
  const config = await read("postcss.config.mjs");
  assert.equal(config.trim(), 'export default { plugins: { "@tailwindcss/postcss": {} } };');
});
