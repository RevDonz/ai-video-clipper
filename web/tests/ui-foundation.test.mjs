// The UI foundation of the app pages (docs/plans/2026-10-24-rombak/05-ui-dashboard.md §3):
// globals.css in cascade layers with its tokens outside them, HeroUI and Tailwind (no preflight)
// through app/ui.css, which only the shell and the public card import, and, for the editor,
// through its own app/editor.css, which only the editor's layout imports (amendment X10,
// 06-editor.md §17 F0). Navigation stays full-document everywhere (no RouterProvider).
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
    // A sub-layer of base: HeroUI's `* { border-color }` loads after globals.css, so in base
    // itself it would beat Potongin's equally specific :where(input…) border (seen in the
    // main-vs-branch screenshots). Rules directly in base outrank its sub-layers.
    "@heroui/styles/base layer(base.heroui)",
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
  for (const target of [".button", ".tabs__tab", ".menu-item", ".list-box-item", ".close-button", ".toggle-button", ".pagination__link", ".tag__remove-button", ".switch", ".checkbox", ".radio"]) {
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
  // React Aria keeps an unselected Tabs.Panel with shouldForceMount mounted but only marks it inert.
  assert.ok(find(".tabs__panel[data-inert=\"true\"]").some((rule) => rule.decls.some((decl) => decl.prop === "display" && decl.value === "none")));
  // Every class the overrides name is one HeroUI 3.2.6 ships, so a rename on upgrade fails here.
  const shipped = (await Promise.all(HEROUI_COMPONENTS.map((name) => read(`node_modules/@heroui/styles/dist/components/${name}.css`)))).join("\n");
  // The @import lines name files and layers (`base.heroui`), not classes.
  const ruleText = css.replace(/^@import[^\n]*$/gm, "");
  const names = new Set([...ruleText.matchAll(/\.([a-z][a-z0-9-]*(?:__[a-z0-9-]+)?(?:--[a-z0-9-]+)?)/g)].map((match) => match[1]));
  for (const name of names) {
    if (["statusPill"].includes(name)) continue;
    assert.ok(new RegExp(`\\.${name.replace(/[-_]/g, "[-_]")}\\b|&${name.slice(name.search(/__|--/))}\\b`).test(shipped), `.${name} is a HeroUI 3.2.6 class`);
  }
});

/** Every name @heroui/react exports, with the component folder it comes from. */
async function heroFolders() {
  const index = await read("node_modules/@heroui/react/dist/index.js");
  const folders = {};
  for (const match of index.matchAll(/export \{([^}]*)\} from '\.\/components\/([a-z-]+)\//g)) {
    for (const part of match[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).at(-1);
      if (name) folders[name] = match[2];
    }
  }
  return folders;
}

/** A HeroUI component folder with every component folder it renders (Dropdown renders Menu …). */
async function heroClosure(folders) {
  const seen = new Set();
  const visit = async (folder) => {
    if (seen.has(folder)) return;
    seen.add(folder);
    const dir = path.join(WEB, "node_modules", "@heroui", "react", "dist", "components", folder);
    for (const file of (await listFiles(dir, ["."], [".js"]))) {
      const source = await readFile(path.join(dir, file), "utf8");
      for (const match of source.matchAll(/from '\.\.\/([a-z-]+)\//g)) await visit(match[1]);
      for (const match of source.matchAll(/import '\.\.\/([a-z-]+)\//g)) await visit(match[1]);
    }
  };
  for (const folder of folders) await visit(folder);
  // A folder without a stylesheet (a context, the RAC re-exports) needs nothing in the CSS.
  return [...seen].filter((folder) => existsSync(path.join(WEB, "node_modules", "@heroui", "styles", "dist", "components", `${folder}.css`))).sort();
}

const EDITOR_LAYOUT = `${EDIT_ROUTE}/layout.jsx`;
const isEditorSide = (file) => file.startsWith("components/editor/") || file.startsWith(EDIT_ROUTE);

test("editor.css: ui.css's Tailwind and HeroUI prelude, utilities from the editor only, one stylesheet per HeroUI component the editor imports", async () => {
  const css = await read("app/editor.css");
  assert.equal(css.split("\n")[0], LAYER_ORDER);
  const list = imports(css);
  assert.deepEqual(list.slice(0, 6).map((entry) => `${entry.spec} ${entry.rest}`.trim()), [
    "tailwindcss/theme.css layer(theme)",
    "./ui-theme-reset.css layer(theme)",
    // Automatic source detection off: the utilities come from the editor's files alone.
    "tailwindcss/utilities.css layer(utilities) source(none)",
    "tw-animate-css",
    "@heroui/styles/base layer(base.heroui)",
    "@heroui/styles/themes/default layer(theme)",
  ]);
  assert.ok(!list.some((entry) => entry.spec === "tailwindcss" || /preflight/.test(entry.spec)), "no preflight");
  assert.deepEqual(list.slice(-2).map((entry) => entry.spec), ["@heroui/styles/utilities", "@heroui/styles/variants"]);
  for (const entry of list) {
    const file = entry.spec.startsWith("./") ? path.join(WEB, "app", entry.spec) : await resolvePackageCss(entry.spec);
    assert.ok(file && existsSync(file), `${entry.spec} resolves to a file (${file})`);
  }
  // Importing a component's stylesheet is using it, both ways: what the editor imports from
  // @heroui/react (with what those components render) is exactly what editor.css loads.
  const folders = await heroFolders();
  const sources = await readSources(WEB, (await listFiles(WEB, ["app", "components"], [".js", ".jsx", ".mjs"])).filter(isEditorSide));
  const used = new Set();
  for (const { file, source } of sources) {
    for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']@heroui\/react["']/g)) {
      for (const part of match[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/)[0];
        if (!name) continue;
        assert.ok(folders[name], `${file}: ${name} is a HeroUI 3.2.6 component`);
        used.add(folders[name]);
      }
    }
    assert.doesNotMatch(source, /import\s+\*\s+as\s+\w+\s+from\s+["']@heroui\/react["']/, `${file}: no namespace import of @heroui/react`);
  }
  assert.ok(used.size >= 1, "the editor kit takes at least one HeroUI component");
  const components = list.filter((entry) => entry.spec.startsWith("@heroui/styles/components/"));
  for (const entry of components) assert.equal(entry.rest, "layer(components)", entry.spec);
  assert.deepEqual(components.map((entry) => entry.spec.replace("@heroui/styles/components/", "").replace(/\.css$/, "")).sort(), await heroClosure([...used]));
  assert.match(css, /^@source "\.\.\/components\/editor";$/m);
  assert.doesNotMatch(css, /@source not/);
  assert.match(css, /@theme \{[^}]*--font-sans: var\(--font\);/);
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ""), /--accent\b/, "no lime in the editor's kit layer");
});

test("editor.css sits wholly in layers, so every editor CSS Module wins over it; its rules name HeroUI classes only", async () => {
  const css = (await read("app/editor.css")).replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = cssRules(css).filter((rule) => rule.selector !== "@theme");
  assert.ok(rules.length >= 3);
  for (const rule of rules) assert.ok(rule.at.some((at) => at.startsWith("@layer ")), `${rule.selector} (line ${rule.line}) is layered`);
  const layered = rules.filter((rule) => rule.at.includes("@layer components") && !rule.at.some((at) => /forced-colors/.test(at)));
  const imported = imports(css).filter((entry) => entry.spec.startsWith("@heroui/styles/components/")).map((entry) => entry.spec.replace("@heroui/styles/components/", ""));
  const shipped = (await Promise.all(imported.map((name) => read(`node_modules/@heroui/styles/dist/components/${name}`)))).join("\n");
  for (const rule of layered) {
    for (const match of rule.selector.matchAll(/\.([a-z][a-z0-9-]*(?:__[a-z0-9-]+)?(?:--[a-z0-9-]+)?)/g)) {
      assert.match(shipped, new RegExp(`\\.${match[1]}\\b`), `.${match[1]} is a class of a stylesheet editor.css imports`);
    }
    for (const decl of rule.decls) {
      if (decl.prop === "min-height" || decl.prop === "min-width") assert.equal(decl.value, "44px", rule.selector);
    }
  }
  // The forced-colours port (06 §17 F0, kit ui.module.css): a chosen React Aria control
  // underlines its text and a focused one draws a system-coloured outline.
  const forced = rules.filter((rule) => rule.at.some((at) => /forced-colors:\s*active/.test(at)));
  const chosen = forced.find((rule) => rule.selector === "[data-rac][data-selected]");
  assert.ok(chosen, "a chosen React Aria control keeps a mark");
  assert.ok(chosen.decls.some((decl) => decl.prop === "text-decoration" && /underline/.test(decl.value)));
  const focused = forced.find((rule) => rule.selector === "[data-rac][data-focus-visible]");
  assert.ok(focused && focused.decls.some((decl) => decl.prop === "outline" && /Highlight/.test(decl.value)), "focus keeps a system-coloured outline");
});

test("react-aria-components is a pinned dependency of its own, the very copy HeroUI 3.2.6 runs on", async () => {
  const pkg = JSON.parse(await read("package.json"));
  const hero = JSON.parse(await read("node_modules/@heroui/react/package.json"));
  assert.equal(hero.version, "3.2.6");
  for (const name of ["react-aria-components", "react-aria"]) {
    const pinned = pkg.dependencies[name];
    assert.match(pinned ?? "", /^\d+\.\d+\.\d+$/, `${name} is pinned exactly in web/package.json`);
    const installed = JSON.parse(await read(`node_modules/${name}/package.json`)).version;
    assert.equal(installed, pinned, `${name}: the installed copy is the pinned one`);
    // HeroUI takes React Aria as a peer, so its range must accept that same top-level copy: one
    // React Aria in the bundle.
    const range = hero.peerDependencies[name];
    assert.match(range, /^\^\d+\.\d+\.\d+$/);
    const [major, minor, patch] = range.slice(1).split(".").map(Number);
    const [imajor, iminor, ipatch] = installed.split(".").map(Number);
    assert.ok(imajor === major && (iminor > minor || (iminor === minor && ipatch >= patch)), `${name} ${installed} satisfies HeroUI's ${range}`);
    assert.ok(!existsSync(path.join(WEB, "node_modules", "@heroui", "react", "node_modules", name)), `HeroUI has no nested ${name}`);
  }
  const lock = JSON.parse(await read("package-lock.json"));
  assert.equal(lock.packages["node_modules/react-aria-components"]?.version, pkg.dependencies["react-aria-components"]);
});

test("only the shell and the public card import ui.css; only the editor's layout imports editor.css", async () => {
  const sources = await readSources(WEB, await listFiles(WEB, ["app", "components"], [".js", ".jsx", ".mjs", ".css"]));
  // An import (JS or CSS) emits ui.css; date-picker.css only @reference-s it for its @apply rules.
  const importers = sources.filter(({ source }) => /(?:^|\s)@?import\s+["'][./]*(?:app\/)?ui\.css["']/m.test(source)).map(({ file }) => file);
  const references = sources.filter(({ source }) => /(?<![\w-])ui\.css["']/.test(source)).map(({ file }) => file);
  assert.deepEqual(references.sort(), [...UI_IMPORTERS, "components/ui/date-picker.css"].sort());
  assert.match(sources.find((entry) => entry.file === "components/ui/date-picker.css").source, /^@reference "\.\.\/\.\.\/app\/ui\.css";$/m);
  assert.deepEqual(importers.sort(), [...UI_IMPORTERS].sort());
  for (const file of UI_IMPORTERS) assert.match(sources.find((entry) => entry.file === file).source, /^import "(?:\.\.\/)+app\/ui\.css";$/m, file);
  // The editor's own entry (amendment X10, 06 §17 F0): one importer, its route's layout.
  const editorCss = sources.filter(({ source }) => /editor\.css["']/.test(source)).map(({ file }) => file);
  assert.deepEqual(editorCss, [EDITOR_LAYOUT]);
  assert.match(sources.find((entry) => entry.file === EDITOR_LAYOUT).source, /^import "\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/editor\.css";$/m);
  const editorSide = sources.filter(({ file }) => isEditorSide(file));
  assert.ok(editorSide.length > 20, "the scan reaches the editor");
  for (const { file, source } of editorSide) {
    // HeroUI and React Aria reach the editor (X10), Tailwind only through editor.css, the app
    // pages' kit never.
    assert.doesNotMatch(source, /(?<![\w-])ui\.css|tailwindcss/, file);
    if (file.endsWith(".css")) {
      // The editor's stylesheets stay plain CSS Modules: no Tailwind directive, no imported layer.
      assert.doesNotMatch(source.replace(/\/\*[\s\S]*?\*\//g, ""), /@(?:import|apply|reference|tailwind|theme|source|layer)\b/, file);
    }
    for (const match of source.matchAll(/(?:from|import)\s+["'](\.[^"']+)["']/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
      assert.ok(!target.startsWith("components/ui/") && target !== "app/ui.css", `${file} imports ${target}`);
    }
  }
  // The parity harness renders JASSUB alone: no kit of either kind.
  const harness = sources.filter(({ file }) => file.startsWith("app/parity-harness/"));
  assert.ok(harness.length >= 2);
  for (const { file, source } of harness) assert.doesNotMatch(source, /ui\.css|editor\.css|@heroui\/|react-aria-components|tailwindcss/, file);
  // The root 404 and error boundaries sit above every route, the editor's too, and Next ships a
  // boundary's CSS and JS with every page (next/dynamic included). They take the shell through
  // LazyAppShell, whose plain import() fetches it only once the boundary has mounted.
  for (const file of ["app/not-found.jsx", "app/error.jsx"]) {
    const source = sources.find((entry) => entry.file === file).source;
    assert.doesNotMatch(source, /(?<!Lazy)AppShell\.jsx|next\/dynamic/, `${file} reaches AppShell only lazily`);
    assert.match(source, /^import LazyAppShell from "\.\.\/components\/LazyAppShell\.jsx";$/m, file);
  }
  const lazy = sources.find((entry) => entry.file === "components/LazyAppShell.jsx").source.replace(/\/\/.*$/gm, "");
  assert.match(lazy, /import\("\.\/AppShell\.jsx"\)/);
  assert.doesNotMatch(lazy, /^import .*AppShell\.jsx|next\/dynamic|ui\.css|@heroui/m);
  const editorLayouts = sources.filter(({ file }) => file.startsWith(EDIT_ROUTE));
  for (const { file, source } of editorLayouts) assert.doesNotMatch(source, /AppShell|PublicCard|Providers/, file);
});

test("React Aria's locale reaches the editor through its own kit provider, from the UI language (KA7)", async () => {
  const sources = await readSources(WEB, await listFiles(WEB, ["app", "components"], [".js", ".jsx", ".mjs"]));
  const renders = sources.filter(({ source }) => /<I18nProvider\b/.test(source)).map(({ file }) => file).sort();
  assert.deepEqual(renders, ["components/editor/ui/KitProvider.jsx", "components/ui/Providers.jsx"]);
  const kit = await read("components/editor/ui/KitProvider.jsx");
  assert.match(kit, /^"use client";/);
  assert.match(kit, /import \{ I18nProvider \} from "react-aria-components";/);
  assert.match(kit, /import \{ useLocale \} from "use-intl";/);
  assert.match(kit, /const locale = useLocale\(\);/);
  assert.match(kit, /<I18nProvider locale=\{locale\}>/);
  assert.doesNotMatch(kit.replace(/^\/\/.*$/gm, ""), /"id-ID"|RouterProvider/);
  // Inside the editor's IntlProvider, so useLocale() is the editor's UI language.
  const layout = await read(EDITOR_LAYOUT);
  assert.match(layout, /<SegmentI18n namespaces=\{\["editor"\]\}>\s*<KitProvider>\{children\}<\/KitProvider>\s*<\/SegmentI18n>/);
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
  // lang and dir follow the request's UI language (rombak 07 §8.1); the theme stays dark.
  assert.match(layout, /<html lang=\{locale\} dir=\{entry\.dir\} className=\{dmSans\.variable\} data-theme="dark">/);
  assert.doesNotMatch(layout, /@heroui|react-aria|Providers|ui\.css/, "the root layout stays free of the kit (the editor renders under it)");
  const providers = await read("components/ui/Providers.jsx");
  assert.match(providers, /^"use client";/);
  assert.match(providers, /import \{ I18nProvider \} from "react-aria-components";/);
  assert.match(providers, /<I18nProvider locale=\{locale\}>/);
  // React Aria's locale is the UI language's Intl locale from the root IntlProvider (rombak 07
  // §12), never a fixed one, so dates and numbers in the kit follow the chosen language.
  assert.match(providers, /import \{ useLocale \} from "use-intl";/);
  assert.match(providers, /const locale = useLocale\(\);/);
  assert.doesNotMatch(providers, /"id-ID"/);
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
