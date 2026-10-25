// Every HeroUI theme variable points at a Potongin token (05-ui-dashboard.md §3.4). The aliases
// sit on the unlayered :root of globals.css, so they win over HeroUI's own light and dark blocks
// (both in @layer base). Reading the installed variables.css catches a variable a HeroUI upgrade
// adds before it can show HeroUI's default colours.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { contrastRatio, cssRules, rootColourTokens } from "./support/ui-guards.mjs";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFile(path.join(WEB, relative), "utf8");
const VARIABLES = "node_modules/@heroui/styles/dist/themes/default/variables.css";

const heroNames = (css) => [...new Set([...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1]))].sort();

function rootDeclarations(css) {
  const root = cssRules(css).find((rule) => rule.selector === ":root" && rule.at.length === 0);
  return Object.fromEntries(root.decls.filter((decl) => decl.prop.startsWith("--")).map((decl) => [decl.prop, decl.value]));
}

test("HeroUI 3.2.6 declares the 89 theme variables the alias table covers", async () => {
  const names = heroNames(await read(VARIABLES));
  assert.equal(names.length, 89, names.join(" "));
  const pkg = JSON.parse(await read("node_modules/@heroui/styles/package.json"));
  assert.equal(pkg.version, "3.2.6");
});

test("every HeroUI variable has an alias on the unlayered :root of globals.css", async () => {
  const names = heroNames(await read(VARIABLES));
  const root = rootDeclarations(await read("app/globals.css"));
  const missing = names.filter((name) => root[name] === undefined);
  assert.deepEqual(missing, [], `HeroUI variables without a Potongin alias: ${missing.join(", ")}`);
});

test("the aliases bring no new colour: each colour alias is a var() of a Potongin token", async () => {
  const css = await read("app/globals.css");
  const root = rootDeclarations(css);
  const tokens = rootColourTokens(css);
  const names = heroNames(await read(VARIABLES));
  // Non-colour variables: sizes, timings, cursors, keywords and composites.
  const literal = {
    "--border-width": "1px", "--field-border-width": "1px", "--ring-offset-width": "2px", "--spacing": "0.25rem",
    "--cursor-interactive": "pointer", "--cursor-disabled": "not-allowed", "--skeleton-animation": "pulse",
    "--tooltip-delay": "600ms", "--tooltip-close-delay": "200ms", "--scrollbar-track": "transparent",
    "--scrollbar-gutter": "auto", "--scrollbar-width": "thin", "--surface-shadow": "none", "--field-shadow": "none",
  };
  for (const name of names) {
    const value = root[name];
    if (literal[name] !== undefined) { assert.equal(value, literal[name], name); continue; }
    if (["--overlay-shadow", "--scrollbar-color", "--disabled-opacity", "--radius", "--field-radius"].includes(name)) continue;
    if (["--surface", "--border", "--accent", "--danger", "--success", "--warning", "--focus", "--muted", "--accent-hover"].includes(name)) {
      assert.ok(value, `${name} is a Potongin token already`);
      continue;
    }
    const alias = /^var\(--([a-z0-9-]+)\)$/.exec(value);
    assert.ok(alias, `${name}: ${value} is a var() alias`);
    assert.ok(tokens[alias[1]] || root[`--${alias[1]}`], `${name} points at --${alias[1]}, a Potongin token`);
  }
  assert.equal(root["--radius"], "var(--radius-m)");
  assert.equal(root["--field-radius"], "var(--radius-s)");
  assert.equal(root["--scrollbar-color"], "var(--scrollbar-thumb) var(--scrollbar-track)");
  // A 1 px --border-strong ring (3:1 on every surface) and one soft shadow (G5, TOKENS.md).
  assert.equal(root["--overlay-shadow"], "0 0 0 1px var(--border-strong), 0 16px 48px var(--shadow)");
  assert.match(root["--disabled-opacity"], /^0\.\d+$/);
});

test("selection, soft and field colours stay neutral: lime only on --accent itself", async () => {
  const root = rootDeclarations(await read("app/globals.css"));
  for (const name of ["--accent-soft", "--accent-soft-hover", "--segment", "--default", "--default-soft", "--field-background", "--overlay"]) {
    assert.doesNotMatch(root[name], /--accent\b|--lime\b/, name);
  }
  assert.equal(root["--field-border"], "var(--border-strong)", "field edges at 3:1, not the decorative --border");
  assert.equal(root["--accent-foreground"], "var(--accent-ink)");
});

test("the new text-on-fill pairs meet WCAG AA and disabled text stays readable as a shape", async () => {
  const css = await read("app/globals.css");
  const tokens = rootColourTokens(css);
  const root = rootDeclarations(css);
  for (const [text, fill] of [["accent-ink", "accent"], ["accent-ink", "success"], ["accent-ink", "warning"], ["danger-ink", "danger"]]) {
    assert.ok(contrastRatio(tokens[text], tokens[fill]) >= 4.5, `--${text} on --${fill}`);
  }
  // Disabled controls are exempt from AA (WCAG 1.4.3), but the faded label must still stand off
  // its surface: --text faded by --disabled-opacity over --surface-2 keeps at least 3:1.
  const opacity = Number(root["--disabled-opacity"]);
  const mix = (a, b, alpha) => `#${[0, 2, 4].map((i) => Math.round(Number.parseInt(a.slice(1 + i, 3 + i), 16) * alpha + Number.parseInt(b.slice(1 + i, 3 + i), 16) * (1 - alpha)).toString(16).padStart(2, "0")).join("")}`;
  for (const surface of ["surface", "surface-2", "surface-3"]) {
    const faded = mix(tokens.text, tokens[surface], opacity);
    assert.ok(contrastRatio(faded, tokens[surface]) >= 3, `disabled --text on --${surface}: ${contrastRatio(faded, tokens[surface]).toFixed(2)}`);
  }
});
