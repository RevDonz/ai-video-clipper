// The dark design foundation (DESIGN.md): one shared sidebar for every signed-in page (a
// "Menu" drawer below 1024 px), the colour tokens in app/globals.css and their record in
// docs/design/TOKENS.md.
import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { APP_ICONS } from "../lib/app-icons.mjs";
import { INITIAL_MENU, MENU_BREAKPOINT_PX, MENU_QUERY, menuButtonView, menuReducer } from "../lib/app-menu.mjs";
import { APP_LINKS, NAV_GROUPS, PRIMARY_LINK, navGroups, navItems } from "../lib/app-nav.mjs";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFile(path.join(WEB, relative), "utf8");

// --- Navigation data ------------------------------------------------------------------------

test("the sidebar starts with Buat klip, then groups the work pages and the system pages", () => {
  assert.deepEqual([PRIMARY_LINK.href, PRIMARY_LINK.label], ["/dashboard", "Buat klip"]);
  assert.deepEqual(NAV_GROUPS.map((group) => [group.label, group.links.map((entry) => [entry.href, entry.label])]), [
    ["Kerja", [["/projects", "Riwayat"], ["/trends", "Konteks Tren"]]],
    ["Sistem", [["/settings", "Pengaturan"], ["/bantuan", "Bantuan"]]],
  ]);
  assert.deepEqual(APP_LINKS.map((entry) => entry.href), ["/dashboard", "/projects", "/trends", "/settings", "/bantuan"]);
});

test("every destination is a real page and has an icon drawn for it", async () => {
  for (const entry of APP_LINKS) {
    await access(path.join(WEB, "app", entry.href.slice(1), "page.jsx"));
    assert.ok(APP_ICONS[entry.icon], `${entry.href}: icon ${entry.icon}`);
  }
  for (const name of ["logout", "menu", "close"]) assert.ok(APP_ICONS[name], name);
  for (const [name, parts] of Object.entries(APP_ICONS)) {
    assert.ok(parts.length > 0, name);
    for (const part of parts) assert.match(part.d, /^M[\d.\s,a-zA-Z-]+$/, `${name}: a path`);
  }
});

test("navItems and navGroups mark exactly the page the user is on, including pages under it", () => {
  const current = (pathname) => navItems(pathname).filter((item) => item.current).map((item) => item.href);
  assert.deepEqual(current("/dashboard"), ["/dashboard"]);
  assert.deepEqual(current("/trends"), ["/trends"]);
  assert.deepEqual(current("/bantuan"), ["/bantuan"]);
  assert.deepEqual(current("/projects/job-123"), ["/projects"]);
  assert.deepEqual(current("/projectsx"), []);
  assert.deepEqual(current("/login"), []);
  assert.deepEqual(current(undefined), []);
  assert.equal(navItems("/settings").length, APP_LINKS.length);
  const drawn = navGroups("/projects/job-123");
  assert.equal(drawn.primary.current, false);
  assert.deepEqual(drawn.groups.flatMap((group) => group.links.filter((entry) => entry.current).map((entry) => entry.href)), ["/projects"]);
  assert.equal(navGroups("/dashboard").primary.current, true);
  assert.equal(navGroups(null).groups.flatMap((group) => group.links).some((entry) => entry.current), false);
});

// --- The phone and tablet drawer ------------------------------------------------------------

test("the Menu button opens the drawer and closes it again, giving focus back", () => {
  const open = menuReducer(INITIAL_MENU, { type: "toggle" });
  assert.deepEqual(open, { open: true, returnFocus: false });
  assert.deepEqual(menuReducer(open, { type: "toggle" }), { open: false, returnFocus: true });
  assert.deepEqual(INITIAL_MENU, { open: false, returnFocus: false }, "the start state is never changed");
});

test("Escape, the close button and the dimmed page close it with focus back on Menu", () => {
  const open = menuReducer(INITIAL_MENU, { type: "toggle" });
  for (const type of ["escape", "close"]) {
    assert.deepEqual(menuReducer(open, { type }), { open: false, returnFocus: true }, type);
    assert.equal(menuReducer(INITIAL_MENU, { type }), INITIAL_MENU, `${type} on a closed menu changes nothing`);
  }
});

test("following a link or widening the window closes it without moving focus", () => {
  const open = menuReducer(INITIAL_MENU, { type: "toggle" });
  for (const type of ["navigate", "wide"]) {
    assert.deepEqual(menuReducer(open, { type }), { open: false, returnFocus: false }, type);
    assert.equal(menuReducer(INITIAL_MENU, { type }), INITIAL_MENU);
  }
  assert.equal(menuReducer(open, { type: "nope" }), open);
  assert.equal(menuReducer(open, undefined), open);
});

test("the Menu button names what it does next", () => {
  assert.deepEqual(menuButtonView(INITIAL_MENU), { label: "Menu", icon: "menu", expanded: false });
  assert.deepEqual(menuButtonView({ open: true }), { label: "Tutup", icon: "close", expanded: true });
  for (const view of [menuButtonView(INITIAL_MENU), menuButtonView({ open: true })]) assert.ok(APP_ICONS[view.icon]);
});

test("the drawer's breakpoint is the one the stylesheet folds the sidebar at", async () => {
  assert.equal(MENU_BREAKPOINT_PX, 1024);
  assert.equal(MENU_QUERY, "(max-width: 1023px)");
  const css = await read("app/globals.css");
  assert.match(css, /@media \(max-width: 1023px\) \{\n  \.appFrame/);
  assert.match(css, /@media \(min-width: 1024px\) \{\n  \.appFrame/);
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

test("the shell has one labelled nav, marks the current page and keeps logout", async () => {
  const shell = await read("components/AppShell.jsx");
  assert.match(shell, /^"use client";/);
  assert.match(shell, /navGroups\(current\)/);
  assert.equal(shell.match(/<nav\b/g)?.length, 1, "exactly one navigation landmark");
  assert.match(shell, /<nav [^>]*aria-label="Menu utama"/);
  assert.match(shell, /aria-current=\{(entry|item|link)\.current \? "page" : undefined\}/);
  assert.match(shell, /<form [^>]*method="post" action="\/api\/auth\/logout"/);
  assert.match(shell, /<Brand \/>\s*<JobBadge \/>/, "the badge sits right after the brand");
  // Landmarks: the sidebar is the banner, the page is <main id="konten"> with a skip link to it.
  assert.match(shell, /<a className="skipLink" href="#konten">/);
  assert.match(shell, /<main id="konten"/);
});

test("the Menu drawer is a labelled toggle that Escape closes and that gives focus back", async () => {
  const shell = await read("components/AppShell.jsx");
  assert.match(shell, /aria-controls="app-menu"/);
  assert.match(shell, /aria-expanded=\{button\.expanded\}/);
  assert.match(shell, /id="app-menu"/);
  assert.match(shell, /\{button\.label\}/, "the button shows its word, not only an icon");
  assert.match(shell, /event\.key === "Escape"/);
  assert.match(shell, /matchMedia\(MENU_QUERY\)/);
  assert.match(shell, /type: "wide"/);
  assert.match(shell, /toggleRef\.current\?\.focus\(\)/);
  // While open the page behind it takes no focus or clicks.
  assert.match(shell, /inert=\{menu\.open \|\| undefined\}/);
  assert.doesNotMatch(shell, /outline:\s*none/);
});

test("the shell, sidebar data and brand carry no version wording and no invented status", async () => {
  const sources = await Promise.all(["components/AppShell.jsx", "components/Brand.jsx", "lib/app-nav.mjs", "lib/app-menu.mjs"].map(read));
  for (const source of sources) {
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
  assert.match(layout, /template: "%s · Potongin"/);
  assert.doesNotMatch(layout, /—/);
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
  // data-theme="dark" picks HeroUI's dark block too (05-ui-dashboard.md §3.6); the aliases on :root decide its colours.
  assert.match(layout, /<html lang="id" className=\{dmSans\.variable\} data-theme="dark">/);
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

test("the sidebar's links, Buat klip, Keluar and the Menu button are 44 px targets", async () => {
  const css = (await read("app/globals.css")).replace(/\/\*[\s\S]*?\*\//g, "");
  for (const selector of [".appNavLink", ".appCreate", ".appLogout button", ".appMenuToggle"]) {
    assert.match(cssRule(css, selector), /min-height:\s*44px/, selector);
  }
  assert.match(cssRule(css, ".appNavLink"), /white-space:\s*nowrap/, "a label never wraps under its icon");
  assert.match(cssRule(css, ".skipLink:focus"), /clip:\s*auto|position:\s*fixed/);
  // The closed drawer is gone for everyone (not only visually) until Menu opens it.
  const narrow = /@media \(max-width: 1023px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  assert.match(narrow, /\.appFrame:not\(\[data-menu-open\]\) \.appMenu \{ display: none; \}/);
  assert.match(narrow, /\.appMenu \{[^}]*overflow-y: auto/);
  assert.match(narrow, /\.appScrim \{/);
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
