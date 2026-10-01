// The dark design foundation (DESIGN.md): one shared header for every signed-in page,
// the colour tokens in app/globals.css and their record in docs/design/TOKENS.md.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { APP_LINKS, navItems } from "../lib/app-nav.mjs";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFile(path.join(WEB, relative), "utf8");

// --- Navigation data ------------------------------------------------------------------------

test("the header offers the four signed-in destinations in a fixed order", () => {
  assert.deepEqual(APP_LINKS.map((link) => [link.href, link.label]), [
    ["/dashboard", "Buat Klip"],
    ["/projects", "Riwayat"],
    ["/trends", "Konteks Tren"],
    ["/settings", "Pengaturan"],
  ]);
});

test("navItems marks exactly the page the user is on, including pages under it", () => {
  const current = (pathname) => navItems(pathname).filter((item) => item.current).map((item) => item.href);
  assert.deepEqual(current("/dashboard"), ["/dashboard"]);
  assert.deepEqual(current("/trends"), ["/trends"]);
  assert.deepEqual(current("/projects/job-123"), ["/projects"]);
  assert.deepEqual(current("/projectsx"), []);
  assert.deepEqual(current("/login"), []);
  assert.deepEqual(current(undefined), []);
  assert.equal(navItems("/settings").length, APP_LINKS.length);
});

// --- Shared header markup -------------------------------------------------------------------

const SIGNED_IN_PAGES = [
  ["app/dashboard/page.jsx", "/dashboard"],
  ["app/projects/page.jsx", "/projects"],
  ["app/projects/[id]/page.jsx", "/projects"],
  ["app/trends/page.jsx", "/trends"],
  ["app/settings/page.jsx", "/settings"],
];

test("every signed-in page renders the shared header instead of its own nav", async () => {
  for (const [file, current] of SIGNED_IN_PAGES) {
    const source = await read(file);
    assert.match(source, new RegExp(`<AppHeader current="${current}" />`), file);
    assert.doesNotMatch(source, /className="nav[ "]|className="navLinks"|className="navActions"/, file);
    assert.doesNotMatch(source, /action="\/api\/auth\/logout"/, `${file} keeps its own logout form`);
  }
});

test("the shared header has one labelled nav, marks the current page and keeps logout", async () => {
  const header = await read("components/AppHeader.jsx");
  assert.match(header, /navItems\(current\)/);
  assert.equal(header.match(/<nav\b/g)?.length, 1, "exactly one navigation landmark");
  assert.match(header, /<nav [^>]*aria-label="[^"]+"/);
  assert.match(header, /aria-current=\{item\.current \? "page" : undefined\}/);
  assert.match(header, /<form [^>]*method="post" action="\/api\/auth\/logout"/);
  assert.match(header, /<Brand \/>/);
});

test("the shared header and brand carry no version wording and no invented status", async () => {
  const sources = await Promise.all(["components/AppHeader.jsx", "components/Brand.jsx", "lib/app-nav.mjs"].map(read));
  for (const source of sources) {
    assert.doesNotMatch(source, /\bV[1-3]\b|Selection V|\bversi\b|mesin (lama|baru)|Mode lama/i);
    assert.doesNotMatch(source, /Worker lokal siap/);
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
  assert.match(layout, /<html lang="id" className=\{dmSans\.variable\}>/);
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
