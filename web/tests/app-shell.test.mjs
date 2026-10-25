// The dark design foundation (DESIGN.md): one shared sidebar for every signed-in page (a
// "Menu" drawer below 1024 px), the colour tokens in app/globals.css and their record in
// docs/design/TOKENS.md.
import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { APP_ICONS } from "../lib/app-icons.mjs";
import { MENU_BREAKPOINT_PX, MENU_QUERY } from "../lib/app-menu.mjs";
import { NAV_LINKS, navLinks } from "../lib/app-nav.mjs";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFile(path.join(WEB, relative), "utf8");

// --- Navigation data (the list itself: tests/app-nav.test.mjs) ------------------------------

test("every destination shown today is a real page and has an icon drawn for it", async () => {
  for (const entry of navLinks("/dashboard")) {
    await access(path.join(WEB, "app", entry.href.slice(1), "page.jsx"));
  }
  for (const entry of NAV_LINKS) assert.ok(APP_ICONS[entry.icon], `${entry.href}: icon ${entry.icon}`);
  for (const name of ["logout", "menu", "close", "chevron"]) assert.ok(APP_ICONS[name], name);
  assert.equal(APP_ICONS.history, undefined, "Proyek's icon replaced the Riwayat clock");
  for (const [name, parts] of Object.entries(APP_ICONS)) {
    assert.ok(parts.length > 0, name);
    for (const part of parts) assert.match(part.d, /^M[\d.\s,a-zA-Z-]+$/, `${name}: a path`);
  }
});

// --- The phone and tablet drawer ------------------------------------------------------------
// Opening, Escape, Tutup, the backdrop, focus back on Menu and the page inert behind it are
// checked in the browser (e2e/app-shell.spec.mjs, desktop and mobile projects): HeroUI's Drawer
// (React Aria) owns that state now, so the old menuReducer and its unit tests are gone (05 §4.1).

test("the drawer's breakpoint is the one the stylesheet folds the sidebar at", async () => {
  assert.equal(MENU_BREAKPOINT_PX, 1024);
  assert.equal(MENU_QUERY, "(max-width: 1023px)");
  const css = await read("app/globals.css");
  assert.match(css, /@media \(max-width: 1023px\) \{\n  \.appFrame/);
  assert.match(css, /@media \(min-width: 1024px\) \{\n  \.appFrame/);
  const shell = await read("components/app-shell.css");
  assert.match(shell, /@media \(max-width: 1023px\) \{/);
  assert.match(shell, /@media \(min-width: 1024px\) \{/);
  const module = await read("lib/app-menu.mjs");
  assert.doesNotMatch(module, /menuReducer|menuButtonView|INITIAL_MENU/, "the hand-made drawer state is gone");
});

// --- Shared sidebar markup ------------------------------------------------------------------

const SIGNED_IN_PAGES = [
  ["app/dashboard/page.jsx", "/dashboard"],
  ["app/projects/page.jsx", "/projects"],
  ["app/projects/[id]/page.jsx", "/projects"],
  ["app/trends/page.jsx", "/trends"],
  ["app/settings/page.jsx", "/settings"],
  ["app/bantuan/page.jsx", "/bantuan"],
];

test("every signed-in page renders inside the shared shell instead of its own nav", async () => {
  for (const [file, current] of SIGNED_IN_PAGES) {
    const source = await read(file);
    assert.match(source, new RegExp(`<AppShell current="${current}"`), file);
    assert.match(source, /import AppShell from "(\.\.\/)+components\/AppShell\.jsx";/, file);
    assert.doesNotMatch(source, /<main\b/, `${file}: the shell owns <main>`);
    assert.doesNotMatch(source, /className="nav[ "]|className="navLinks"|className="navActions"|AppHeader/, file);
    assert.doesNotMatch(source, /action="\/api\/auth\/logout"/, `${file} keeps its own logout form`);
  }
  await assert.rejects(access(path.join(WEB, "components", "AppHeader.jsx")), "the old top header is gone");
});

test("the shell has one labelled nav, marks the current page and keeps a hidden logout form", async () => {
  const shell = await read("components/AppShell.jsx");
  const list = await read("components/NavList.jsx");
  assert.match(shell, /^"use client";/);
  assert.match(list, /^"use client";/);
  // One <nav> in the source, drawn by NavList; the shell draws NavList in the sidebar and in the
  // drawer, and the sidebar's copy is not rendered while the drawer is open (05 §4.2).
  assert.doesNotMatch(shell, /<nav\b/);
  assert.equal(list.match(/<nav\b/g)?.length, 1, "exactly one navigation landmark");
  assert.match(list, /<nav [^>]*aria-label=\{tAria\("mainMenu"\)\}/);
  assert.match(list, /navLinks\(current, \{ role, features \}\)/);
  assert.equal(list.match(/aria-current=\{(?:primary|link)\.current \? "page" : undefined\}/g)?.length, 2);
  assert.equal(shell.match(/<NavList current=\{current\} role=\{role\} features=\{features\} \/>/g)?.length, 2);
  assert.match(shell, /\{!open && \(\s*<div className="appSideBody">\s*<NavList/);
  // Keluar is a menu item now (05 §4.2): it submits the hidden form, so logout stays a POST.
  assert.match(shell, /<form ref=\{logoutFormRef\} method="post" action="\/api\/auth\/logout" hidden \/>/);
  assert.match(shell, /logoutFormRef\.current\?\.requestSubmit\(\)/);
  assert.equal(shell.match(/<form\b/g)?.length, 1);
  assert.match(shell, /<Brand \/>\s*<JobBadge \/>/, "the badge sits right after the brand");
  // Landmarks: the sidebar is the banner, the page is <main id="konten"> with a skip link to it.
  assert.match(shell, /<a className="skipLink" href="#konten">\{t\("skip"\)\}<\/a>/);
  assert.match(shell, /<main id="konten"/);
});

test("the Menu drawer is HeroUI's Drawer from the left: labelled, closed past 1024 px, the page inert", async () => {
  const shell = await read("components/AppShell.jsx");
  assert.match(shell, /import Drawer from "\.\/ui\/Drawer\.jsx";/, "through the wrapper that names its close button");
  assert.match(shell, /<Drawer isOpen=\{open\} onOpenChange=\{setOpen\}>/);
  assert.match(shell, /<Drawer\.Trigger className="appMenuToggle">\s*<AppIcon name="menu" \/>\s*<span>\{t\("menu"\)\}<\/span>/,
    "the button shows its word, not only an icon");
  assert.match(shell, /<Drawer\.Content placement="left"/);
  assert.match(shell, /<Drawer\.Heading[^>]*>\{t\("menu"\)\}<\/Drawer\.Heading>/);
  assert.match(shell, /<Drawer\.CloseTrigger [^>]*aria-label=\{tAria\("close"\)\}/);
  assert.match(shell, /matchMedia\(MENU_QUERY\)/);
  assert.match(shell, /if \(!event\.matches\) setOpen\(false\)/);
  // While open the page behind it takes no focus or clicks (React Aria also hides the rest).
  assert.match(shell, /<main id="konten" className=\{className\} inert=\{open \|\| undefined\}>/);
  assert.doesNotMatch(shell, /outline:\s*none|RouterProvider/);
});

test("the account menu: initials and name, Pintasan satu tombol as a checked item, Keluar last", async () => {
  const menu = await read("components/AccountMenu.jsx");
  assert.match(menu, /<Dropdown\.Trigger className="appAccount" aria-label=\{label\}>/);
  assert.match(menu, /t\("account\.named", \{ name \}\)/, "the visible name is part of the accessible name");
  assert.match(menu, /<Dropdown\.Section\s+selectionMode="multiple"\s+selectedKeys=\{shortcuts \? \[SHORTCUTS_ITEM\] : \[\]\}/);
  assert.match(menu, /useShortcutPref\(\)/);
  assert.match(menu, /<Dropdown\.Item id=\{LOGOUT_ITEM\} variant="danger"/);
  assert.match(menu, /if \(key === LOGOUT_ITEM\) onLogout\?\.\(\)/);
  assert.ok(menu.indexOf("id={SHORTCUTS_ITEM}") < menu.indexOf("id={LOGOUT_ITEM}"), "Keluar comes last");
  // The next milestone's language picker has its place, first in the menu (05 §4.2).
  assert.ok(menu.indexOf("i18n M1 adds the Bahasa section here") < menu.indexOf('selectionMode="multiple"'));
  const prefs = await read("components/ui/UiPrefs.jsx");
  assert.match(prefs, /readShortcutPref\(document\.cookie\)/);
  assert.match(prefs, /writeShortcutPref\(on\)/);
  assert.match(await read("components/ui/Providers.jsx"), /<UiPrefsProvider>/);
});

test("the shell, sidebar data and brand carry no version wording and no invented status", async () => {
  const files = ["components/AppShell.jsx", "components/NavList.jsx", "components/AccountMenu.jsx", "components/Brand.jsx",
    "lib/app-nav.mjs", "lib/app-menu.mjs", "lib/app-shortcuts.mjs", "lib/ui-prefs.mjs", "messages/id/shell.json", "messages/en/shell.json"];
  for (const source of await Promise.all(files.map(read))) {
    assert.doesNotMatch(source, /\bV[1-3]\b|Selection V|\bversi\b|mesin (lama|baru)|Mode lama/i);
    assert.doesNotMatch(source, /Worker lokal siap|—/);
  }
});

test("login and landing use the shared brand mark", async () => {
  for (const file of ["app/login/page.jsx", "app/page.jsx"]) {
    const source = await read(file);
    assert.match(source, /import Brand from "\.\.?\/(\.\.\/)*components\/Brand\.jsx";/, file);
    assert.match(source, /<Brand\b/, file);
  }
  const brand = await read("components/Brand.jsx");
  assert.match(brand, /<span aria-hidden="true">P<\/span>/, "the letter mark is decoration for screen readers");
});

test("the root layout declares the dark colour scheme and a title template without em dashes", async () => {
  const layout = await read("app/layout.jsx");
  assert.match(layout, /colorScheme: "dark"/);
  assert.match(layout, /themeColor: "#080907"/);
  // The title and its template come from the visitor's language's catalog (rombak 07 §8.4).
  assert.match(layout, /template: t\("root\.titleTemplate"\)/);
  assert.doesNotMatch(layout, /—/);
  for (const locale of ["id", "en"]) {
    const meta = JSON.parse(await read(`messages/${locale}/meta.json`));
    assert.equal(meta.root.titleTemplate, "%s · Potongin", locale);
    assert.doesNotMatch(JSON.stringify(meta), /—/, locale);
  }
});

// --- Tokens ---------------------------------------------------------------------------------

function rootTokens(css) {
  const root = /:root\s*\{([^}]*)\}/.exec(css);
  assert.ok(root, ":root block");
  return Object.fromEntries([...root[1].matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));
}

function luminance(hex) {
  const channels = hex.replace("#", "").match(/../g).map((part) => {
    const value = Number.parseInt(part, 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

test("globals.css defines DESIGN.md's dark palette on :root", async () => {
  const tokens = rootTokens(await read("app/globals.css"));
  const expected = { bg: "#080907", surface: "#11120f", border: "#292b25", text: "#f7f5ed", "text-muted": "#a5a69d", accent: "#dfff58" };
  for (const [name, hex] of Object.entries(expected)) assert.equal(tokens[name], hex, `--${name}`);
  for (const name of ["surface-2", "surface-3", "border-strong", "accent-ink", "focus", "info", "info-bg", "danger", "danger-bg", "success", "success-bg", "warning", "warning-bg"]) {
    assert.match(tokens[name] || "", /^#[0-9a-f]{6}$/, `--${name} is a hex colour`);
  }
});

test("the old light token names now point at the dark tokens", async () => {
  const tokens = rootTokens(await read("app/globals.css"));
  const legacy = { paper: "bg", card: "surface", line: "border", ink: "text", muted: "text-muted", lime: "accent", blue: "info", red: "danger" };
  for (const [old, next] of Object.entries(legacy)) assert.equal(tokens[old], `var(--${next})`, `--${old}`);
});

test("every text token meets WCAG AA on every surface it can sit on", async () => {
  const tokens = rootTokens(await read("app/globals.css"));
  const surfaces = ["bg", "surface", "surface-2", "surface-3"];
  for (const text of ["text", "text-muted", "info", "danger", "success", "warning", "accent"]) {
    for (const surface of surfaces) {
      const ratio = contrast(tokens[text], tokens[surface]);
      assert.ok(ratio >= 4.5, `--${text} on --${surface}: ${ratio.toFixed(2)}`);
    }
  }
  for (const tone of ["info", "danger", "success", "warning"]) {
    for (const text of [tone, "text", "text-muted"]) {
      const ratio = contrast(tokens[text], tokens[`${tone}-bg`]);
      assert.ok(ratio >= 4.5, `--${text} on --${tone}-bg: ${ratio.toFixed(2)}`);
    }
  }
  assert.ok(contrast(tokens["accent-ink"], tokens.accent) >= 4.5, "text on the lime button");
  assert.ok(contrast(tokens["accent-ink"], tokens["accent-hover"]) >= 4.5, "text on the hovered lime button");
  assert.ok(contrast(tokens["danger-ink"], tokens.danger) >= 4.5, "text on the danger button");
});

test("focus rings and control edges keep 3:1 against what surrounds them", async () => {
  const tokens = rootTokens(await read("app/globals.css"));
  for (const surface of ["bg", "surface", "surface-2"]) {
    assert.ok(contrast(tokens.focus, tokens[surface]) >= 3, `--focus on --${surface}`);
  }
  for (const surface of ["bg", "surface", "surface-2"]) {
    assert.ok(contrast(tokens["border-strong"], tokens[surface]) >= 3, `--border-strong on --${surface}`);
  }
});

test("date inputs show the focus ring too: their inner field holds the focus, not the input", async () => {
  // Chromium focuses the day/month segment inside the shadow tree, so the input itself matches
  // only :focus-within and the global :focus-visible ring never appears on it.
  const css = await read("app/globals.css");
  const rule = /([^{}]*input\[type="date"\][^{}]*:focus-within[^{}]*)\{([^}]*)\}/.exec(css);
  assert.ok(rule, "a :focus-within ring for date inputs");
  assert.match(rule[2], /outline:\s*2px solid var\(--focus\)/);
  for (const type of ["date", "time", "datetime-local", "month", "week"]) assert.match(rule[1], new RegExp(`input\\[type="${type}"\\]`), type);
});

test("DM Sans is self-hosted through next/font and every stylesheet reaches it through --font", async () => {
  // A remote @import in globals.css is dropped by the build, so the font never loaded.
  const layout = await read("app/layout.jsx");
  assert.match(layout, /import \{ DM_Sans \} from "next\/font\/google";/);
  assert.match(layout, /variable: "--font-dm-sans"/);
  // lang is the request's UI language (rombak 07 §8.1), not a fixed "id"; data-theme="dark" picks
  // HeroUI's dark block too (05-ui-dashboard.md §3.6); the aliases on :root decide its colours.
  assert.match(layout, /<html lang=\{locale\} dir=\{entry\.dir\} className=\{dmSans\.variable\} data-theme="dark">/);
  assert.match(layout, /const locale = i18n\.locale;/);
  const css = await read("app/globals.css");
  assert.doesNotMatch(css, /@import\s+url\(/);
  assert.equal(rootTokens(css).font, "var(--font-dm-sans), system-ui, sans-serif");
});

test("DM Sans is the only typeface and motion stops for reduced-motion users", async () => {
  const css = await read("app/globals.css");
  assert.match(css, /color-scheme:\s*dark/);
  const cssFiles = [];
  const walk = async (dir) => {
    for (const entry of await readdir(path.join(WEB, dir), { withFileTypes: true })) {
      const relative = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(relative);
      else if (entry.name.endsWith(".css")) cssFiles.push(relative);
    }
  };
  await walk("app");
  await walk("components");
  // A literal family name skips the fallback stack and the next/font name: serif if it fails.
  for (const file of cssFiles) assert.doesNotMatch(await read(file), /Manrope|'DM Sans'|"DM Sans"/, file);

  const tokens = rootTokens(css);
  for (const name of ["dur-1", "dur-2", "dur-3"]) assert.match(tokens[name] || "", /^\d+ms$/, `--${name}`);
  assert.match(tokens["ease-out"] || "", /^cubic-bezier\(/);
  const reduced = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(reduced, "a reduced-motion block");
  for (const name of ["dur-1", "dur-2", "dur-3"]) assert.match(reduced[1], new RegExp(`--${name}:\\s*0ms`));
  assert.match(reduced[1], /animation-duration:\s*0\.01ms\s*!important/);
  assert.match(reduced[1], /animation-iteration-count:\s*1\s*!important/);
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus\)/);
});

test("docs/design/TOKENS.md records every colour token with the same hex", async () => {
  const tokens = rootTokens(await read("app/globals.css"));
  const doc = await readFile(path.join(WEB, "..", "docs", "design", "TOKENS.md"), "utf8");
  const documented = Object.fromEntries([...doc.matchAll(/^\|\s*`--([a-z0-9-]+)`\s*\|[^|]*\|\s*`(#[0-9a-f]{6})`/gm)].map((match) => [match[1], match[2]]));
  const colours = Object.entries(tokens).filter(([, value]) => /^#[0-9a-f]{6}$/.test(value));
  assert.ok(colours.length >= 20, "the palette is defined");
  for (const [name, hex] of colours) assert.equal(documented[name], hex, `TOKENS.md row for --${name}`);
  for (const name of Object.keys(documented)) assert.ok(tokens[name], `TOKENS.md documents --${name}, which globals.css does not define`);
});

// Phone checks (360-390 px): the top bar keeps every target at 44 px and the drawer's links too.
const cssRule = (css, selector) => {
  const at = css.indexOf(`${selector} {`);
  assert.ok(at >= 0, `a rule for ${selector}`);
  return css.slice(at, css.indexOf("}", at));
};

test("the brand link is a 44 px target even when only its letter mark shows", async () => {
  const css = (await read("app/globals.css")).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(cssRule(css, ".brand"), /min-width:\s*44px/);
  assert.match(cssRule(css, ".brand"), /min-height:\s*44px/);
});

test("the sidebar's links, Buat klip, the account button and the Menu button are 44 px targets", async () => {
  const css = (await read("app/globals.css")).replace(/\/\*[\s\S]*?\*\//g, "");
  for (const selector of [".appNavLink", ".appCreate", ".appMenuToggle"]) {
    assert.match(cssRule(css, selector), /min-height:\s*44px/, selector);
  }
  assert.match(cssRule(css, ".appNavLink"), /white-space:\s*nowrap/, "a label never wraps under its icon");
  assert.match(cssRule(css, ".skipLink:focus"), /clip:\s*auto|position:\s*fixed/);
  const shell = (await read("components/app-shell.css")).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(cssRule(shell, ".appAccount"), /min-height:\s*44px/);
  assert.match(cssRule(shell, ".appDrawerHead"), /min-height:\s*44px/);
  // The drawer's close button and the menu items get HeroUI's 44 px override (app/ui.css).
  const ui = await read("app/ui.css");
  assert.match(ui, /\.menu-item, \.list-box-item, \.close-button,[^{]*\{ min-height: 44px; min-width: 44px; \}/);
  // HeroUI's trigger class is inline-block: the Menu button keeps its flex row, and is gone past
  // the breakpoint; the sidebar body is gone below it (the drawer holds the list there).
  assert.match(cssRule(shell, ".appMenuToggle"), /display:\s*inline-flex/);
  const wide = /@media \(min-width: 1024px\) \{([\s\S]*?)\n\}/.exec(shell)?.[1] ?? "";
  assert.match(wide, /\.appMenuToggle \{ display: none; \}/);
  const narrow = /@media \(max-width: 1023px\) \{([\s\S]*?)\n\}/.exec(shell)?.[1] ?? "";
  assert.match(narrow, /\.appSideBody \{ display: none; \}/);
  assert.doesNotMatch(shell, /@layer|outline:\s*none/, "unlayered, so it wins over HeroUI's component layer");
});

test("the editor's state page links back to the project with a 44 px target", async () => {
  const css = (await read("components/editor/shell.module.css")).replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = cssRule(css, ".state a");
  assert.match(rule, /min-height:\s*44px/);
  assert.match(rule, /display:\s*inline-flex/);
});

// Every page asks for /favicon.ico; without one each page load logged a 404. The icon is the
// brand mark (lime square, dark "P") and stays outside the sign-in proxy, so the login page
// gets it too.
test("the app has a favicon.ico the browser can load without a session", async () => {
  const icon = await readFile(path.join(WEB, "app", "favicon.ico"));
  assert.deepEqual([...icon.subarray(0, 4)], [0, 0, 1, 0], "an ICO file");
  assert.ok(icon.readUInt16LE(4) >= 2, "at least two sizes (16 and 32 px)");
  assert.match(await read("proxy.js"), /\|favicon\.ico\)/);
});
