// A CSS module class is one name for one element kind. Two components that pick the same name in
// one module share its rules, and the later rule wins: the top bar's Urungkan/Ulangi group and the
// export dialog's history list both used `.history` in shell.module.css, so the list's
// `display: grid` stacked the two buttons out of the 64 px bar (Mode Cepat integration, spec §18).
// This reads the editor's CSS modules (never renders) and refuses a class whose top-level rules
// set `display` to two different values. Rules inside @media or @supports may override on purpose.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const EDITOR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "components", "editor");

function cssModules(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return cssModules(full);
    return entry.name.endsWith(".module.css") ? [full] : [];
  });
}

/** The top-level rules of a stylesheet (outside any at-rule block), as [selector, body]. */
export function topLevelRules(css) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [];
  let depth = 0;
  let start = 0;
  let selector = null;
  let atBlock = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === "{") {
      if (depth === 0) {
        selector = source.slice(start, i).trim();
        atBlock = selector.startsWith("@");
        start = i + 1;
      }
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        if (!atBlock && selector) rules.push([selector, source.slice(start, i)]);
        start = i + 1;
        selector = null;
      }
    }
  }
  return rules;
}

/** Classes whose plain top-level rules (`.name { … }`) set `display` to more than one value. */
export function displayCollisions(css) {
  const values = new Map();
  for (const [selector, body] of topLevelRules(css)) {
    for (const part of selector.split(",").map((item) => item.trim())) {
      const match = /^\.([A-Za-z_][\w-]*)$/.exec(part);
      if (!match) continue;
      const display = /(?:^|;)\s*display\s*:\s*([^;]+)/.exec(body)?.[1]?.trim();
      if (!display) continue;
      if (!values.has(match[1])) values.set(match[1], new Set());
      values.get(match[1]).add(display);
    }
  }
  return [...values].filter(([, set]) => set.size > 1).map(([name, set]) => `.${name}: ${[...set].join(" / ")}`);
}

test("the checker finds a class given two displays by two top-level rules, and only that", () => {
  const planted = ".history { display: flex; gap: 4px; }\n.list { display: grid; }\n.history { display: grid; }\n"
    + "@media (forced-colors: active) { .list { display: block; } }\n.menu { color: red; }\n.menu { display: flex; }\n";
  assert.deepEqual(displayCollisions(planted), [".history: flex / grid"]);
});

test("no editor CSS module gives one class two different displays", () => {
  const files = cssModules(EDITOR);
  assert.ok(files.length >= 15, "the editor's CSS modules are found");
  const found = files.flatMap((file) => displayCollisions(readFileSync(file, "utf8"))
    .map((item) => `${path.relative(EDITOR, file)} ${item}`));
  assert.deepEqual(found, []);
});

// --- the editor's HeroUI layer (rombak 06 §17 F0, amendment X10) -----------------------------------
// app/editor.css brings Tailwind's and HeroUI's theme and base onto the editor page, layered.
// A layered custom property loses to an unlayered one of the same name (globals.css :root), but
// it fills one the editor reads and nobody unlayered sets, which would change the editor quietly.
// HeroUI's base also colours every border it finds no colour for (`* { border-color }`).

const WEB = path.resolve(EDITOR, "..", "..");

function cssUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return cssUnder(full);
    return entry.name.endsWith(".css") ? [full] : [];
  });
}

const withoutComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const definedIn = (css) => new Set([...withoutComments(css).matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]));

test("no custom property the editor reads is newly set by editor.css's Tailwind or HeroUI layers", () => {
  const reads = new Set();
  const own = new Set();
  for (const file of cssUnder(EDITOR)) {
    const source = readFileSync(file, "utf8");
    for (const match of withoutComments(source).matchAll(/var\((--[\w-]+)/g)) reads.add(match[1]);
    for (const name of definedIn(source)) own.add(name);
  }
  assert.ok(reads.size > 50, `the scan reaches the editor's tokens (${reads.size})`);
  // Unlayered tokens (globals.css :root, the editor's own modules) always win.
  const unlayered = definedIn(readFileSync(path.join(WEB, "app", "globals.css"), "utf8"));
  const layered = new Set();
  const sheets = [
    ...cssUnder(path.join(WEB, "node_modules", "@heroui", "styles", "dist", "themes")),
    ...cssUnder(path.join(WEB, "node_modules", "@heroui", "styles", "dist", "base")),
    path.join(WEB, "node_modules", "tailwindcss", "theme.css"),
    path.join(WEB, "app", "editor.css"),
    path.join(WEB, "app", "ui-theme-reset.css"),
  ];
  for (const file of sheets) for (const name of definedIn(readFileSync(file, "utf8"))) layered.add(name);
  assert.ok(layered.has("--ease-out") && layered.has("--accent"), "the scan reads Tailwind's and HeroUI's themes");
  const filled = [...reads].filter((name) => layered.has(name) && !unlayered.has(name) && !own.has(name));
  assert.deepEqual(filled, []);
});

test("every border an editor stylesheet draws names its colour, so HeroUI's base cannot recolour it", () => {
  const found = [];
  for (const file of cssUnder(EDITOR)) {
    const source = withoutComments(readFileSync(file, "utf8"));
    for (const match of source.matchAll(/(?:^|[;{\s])(border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?)\s*:\s*([^;}]+)/g)) {
      const value = match[2].trim();
      // A width and a style without a colour take currentColor, unless a layered rule sets one.
      if (!/\b(?:solid|dashed|dotted|double|groove|ridge|inset|outset)\b/.test(value)) continue;
      if (/var\(|#|rgb|hsl|color-mix|currentColor|transparent|inherit|\b(?:Canvas|CanvasText|Highlight|HighlightText|ButtonText|ButtonFace|GrayText|LinkText|Field|FieldText|Mark|MarkText|AccentColor|AccentColorText|ButtonBorder)\b/.test(value)) continue;
      found.push(`${path.relative(EDITOR, file)} ${match[1]}: ${value}`);
    }
  }
  assert.deepEqual(found, []);
});
