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
