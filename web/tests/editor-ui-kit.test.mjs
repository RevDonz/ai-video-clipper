// The editor's shared controls (docs/plans/2026-10-02-editor-mode-cepat.md §8.2, §8.4): the
// icon set, the menu and accordion rules, and the kit's CSS (motion tokens only, no lime, 44 px
// targets). Reads modules and CSS only, never renders. Z0 lands these; task B adds the panel
// checks (§9.2) when it adopts the kit.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ICONS, ICON_NAMES } from "../components/editor/ui/icon-paths.mjs";
import { accordionIds, menuItemRole, menuMove } from "../components/editor/ui/kit-model.mjs";
import { cssRules } from "./support/ui-guards.mjs";

const editorDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "components", "editor");
const KIT_DIRS = ["ui", "quick", "rail", "scrubber"];
// Lime off the editor screen but Ekspor (§8.1): the transient progress fills of B's directories
// are the only rules that may name an --accent token.
const LIME_DIRS = [...KIT_DIRS, "panels", "suggestions"];
const LIME_ALLOWED = Object.freeze({
  "suggestions/suggestions.module.css": [".fill"],
  "panels/layout.module.css": [".cardFill"],
  "panels/logo.module.css": [".bar"],
});

function cssFiles(dirs) {
  return dirs.flatMap((dir) => {
    const full = path.join(editorDir, dir);
    if (!existsSync(full)) return [];
    return readdirSync(full).filter((name) => name.endsWith(".css")).map((name) => path.join(dir, name));
  });
}

/** The word toolbar's stylesheets (task D), when they exist on this branch. */
function wordToolbarCss() {
  const dir = path.join(editorDir, "transcript");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => /^WordToolbar.*\.css$/.test(name)).map((name) => path.join("transcript", name));
}

/** Every rule of a stylesheet as `{ selectors, body }`, the rules inside @media included. */
function rulesOf(source) {
  const rules = [];
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const prelude = match[1].trim();
    if (prelude.startsWith("@")) continue;
    rules.push({ selectors: prelude.split(",").map((item) => item.trim().replace(/\s+/g, " ")), body: match[2] });
  }
  return rules;
}

const css = (file) => readFileSync(path.join(editorDir, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the rule whose selector list contains exactly `selector`. */
function ruleOf(source, selector) {
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(",").map((item) => item.trim());
    if (selectors.includes(selector)) return match[2];
  }
  return null;
}

test("the icon set has the spec's names, each a path on the 24 px grid", () => {
  assert.deepEqual(ICON_NAMES, [
    "back", "undo", "redo", "more", "play", "pause", "chevron", "transcript", "text", "coldopen", "layout", "logo",
    "music", "safezone", "help",
  ]);
  for (const name of ICON_NAMES) {
    assert.ok(ICONS[name].length > 0, name);
    for (const part of ICONS[name]) assert.match(part.d, /^M[\d.]/, name);
  }
  assert.ok(Object.isFrozen(ICONS));
});

test("menu keys: ↓ and ↑ wrap, Home and End go to the ends, other keys are not the menu's", () => {
  assert.equal(menuMove(0, "ArrowDown", 3), 1);
  assert.equal(menuMove(2, "ArrowDown", 3), 0);
  assert.equal(menuMove(0, "ArrowUp", 3), 2);
  assert.equal(menuMove(1, "ArrowUp", 3), 0);
  assert.equal(menuMove(1, "Home", 3), 0);
  assert.equal(menuMove(0, "End", 3), 2);
  assert.equal(menuMove(0, "Enter", 3), null);
  assert.equal(menuMove(0, "k", 3), null);
  assert.equal(menuMove(0, "ArrowDown", 0), null);
});

test("a menu item with a checked state is a menuitemcheckbox", () => {
  assert.equal(menuItemRole({ id: "a", label: "Edit kata" }), "menuitem");
  assert.equal(menuItemRole({ id: "b", label: "Sembunyikan dari caption", checked: false }), "menuitemcheckbox");
  assert.equal(menuItemRole({ id: "c", label: "Sembunyikan dari caption", checked: true }), "menuitemcheckbox");
});

test("an accordion's header controls its region, and the region is named by the header's label alone", () => {
  assert.deepEqual(accordionIds("card-hook"), { button: "card-hook-button", label: "card-hook-label", region: "card-hook-region" });
  const source = readFileSync(path.join(editorDir, "ui", "AccordionCard.jsx"), "utf8");
  assert.match(source, /aria-controls=\{ids\.region\}/);
  assert.match(source, /<span id=\{ids\.label\}/);
  assert.match(source, /role="region" aria-labelledby=\{ids\.label\}/);
});

test("the kit's stylesheets exist where the components import them", () => {
  assert.ok(cssFiles(["ui"]).includes(path.join("ui", "ui.module.css")));
  for (const file of ["ui/PillGroup.jsx", "ui/PillToggle.jsx", "ui/PillButton.jsx", "ui/AccordionCard.jsx", "ui/Switch.jsx",
    "ui/Swatches.jsx", "ui/MenuButton.jsx", "ui/icons.jsx"]) {
    const source = readFileSync(path.join(editorDir, file), "utf8");
    assert.match(source, /^"use client";/, file);
    assert.match(source, /export default function [A-Z]\w*\(/, file);
  }
});

test("motion in the kit comes from the duration tokens only (reduced motion sets them to 0 ms)", () => {
  const files = [...cssFiles(KIT_DIRS), ...wordToolbarCss()];
  assert.ok(files.length >= 2, "the scan reaches the kit's stylesheets");
  for (const file of files) {
    for (const [, prop, value] of css(file).matchAll(/(transition[\w-]*|animation[\w-]*)\s*:\s*([^;}]+)/g)) {
      assert.doesNotMatch(value, /(?<![\w-])\d*\.?\d+m?s\b/, `${file}: ${prop}: ${value.trim()}`);
    }
  }
});

test("lime stays off the kit: no --accent token in ui/, quick/, rail/ or scrubber/ stylesheets", () => {
  for (const file of cssFiles(KIT_DIRS)) assert.doesNotMatch(css(file), /--accent/, file);
});

// var(--ed-target) itself, or a calc() that adds to it (the 56 px card header).
const AT_LEAST_TARGET = String.raw`(?:var\(--ed-target\b|calc\(var\(--ed-target\b[^;]*\+)`;

test("every control of the kit is at least var(--ed-target) (44 px) tall", () => {
  const source = css("ui/ui.module.css");
  for (const selector of [".pill", ".pillButton", ".toggle", ".switch", ".swatch", ".menuButton", ".menuItem", ".cardHeader"]) {
    const rule = ruleOf(source, selector);
    assert.ok(rule, `${selector} has its own rule`);
    assert.match(rule, new RegExp(String.raw`min-height:\s*${AT_LEAST_TARGET}`), `${selector} min-height`);
  }
  for (const selector of [".swatch", ".menuButton[data-icon]"]) {
    assert.match(ruleOf(source, selector) ?? "", new RegExp(String.raw`min-width:\s*${AT_LEAST_TARGET}`), `${selector} min-width`);
  }
});

test("the accordion animates its rows over --dur-2 and hides a closed body after the transition", () => {
  const source = css("ui/ui.module.css");
  const body = ruleOf(source, ".cardBody");
  assert.match(body, /grid-template-rows:\s*0fr/);
  assert.match(body, /visibility:\s*hidden/);
  // visibility is discrete: it stays visible while the rows close and turns visible at once on open.
  assert.match(body, /transition:[^;]*grid-template-rows var\(--dur-2\) var\(--ease-out\)[^;]*visibility var\(--dur-2\)/);
  const open = ruleOf(source, '.cardBody[data-open="true"]');
  assert.match(open, /grid-template-rows:\s*1fr/);
  assert.match(open, /visibility:\s*visible/);
});

// --- task B: the cards, the panels' lime and the card-sized controls (§8.1, §8.4, §9.2) -------------

test("--accent appears only on the allow-listed progress fills, and nowhere in ui/, quick/, rail/ or scrubber/", () => {
  const files = cssFiles(LIME_DIRS);
  assert.ok(files.includes(path.join("panels", "panels.module.css")) && files.includes(path.join("suggestions", "suggestions.module.css")),
    "the scan reaches the panels and the suggestions");
  const seen = [];
  for (const file of files) {
    const key = file.split(path.sep).join("/");
    for (const rule of rulesOf(css(file))) {
      if (!/--accent/.test(rule.body)) continue;
      for (const selector of rule.selectors) {
        seen.push(`${key} ${selector}`);
        assert.ok((LIME_ALLOWED[key] ?? []).includes(selector), `${key} ${selector} uses an --accent token`);
      }
    }
  }
  assert.deepEqual(seen.sort(), ["panels/layout.module.css .cardFill", "panels/logo.module.css .bar", "suggestions/suggestions.module.css .fill"]);
});

test("a panel's main action stays neutral on hover: no .primary:hover with --accent in panels/", () => {
  let checked = 0;
  for (const file of cssFiles(["panels"])) {
    for (const rule of rulesOf(css(file))) {
      if (!rule.selectors.some((selector) => /\.primary:hover/.test(selector))) continue;
      checked += 1;
      assert.doesNotMatch(rule.body, /--accent/, `${file}: ${rule.selectors.join(", ")}`);
      assert.match(rule.body, /background:\s*var\(--text-muted\)/, `${file}: the neutral hover fill`);
      assert.match(rule.body, /(?:^|[;\s])color:\s*var\(--bg\)/, `${file}: the neutral hover text`);
    }
  }
  assert.equal(checked, 2, "panels.module.css and logo.module.css keep a hover for their main action");
});

test("every control of the cards is at least var(--ed-target) (44 px) tall", () => {
  const quick = css("quick/quick.module.css");
  for (const selector of [".textInput", ".tile", ".addButton"]) {
    const rule = ruleOf(quick, selector);
    assert.ok(rule, `quick ${selector} has its own rule`);
    assert.match(rule, new RegExp(String.raw`min-height:\s*${AT_LEAST_TARGET}`), `quick ${selector} min-height`);
  }
  const suggestions = css("suggestions/suggestions.module.css");
  assert.match(ruleOf(suggestions, ".compactButton") ?? "", new RegExp(String.raw`min-height:\s*${AT_LEAST_TARGET}`), "a compact suggestion");
  // The panel parts the Cold open card renders (TransitionSection, ColdOpenSuggestions) grow to the
  // card's targets under data-touch; the Lengkap panel keeps its own sizes.
  const panels = css("panels/panels.module.css");
  for (const selector of ["[data-touch] .button", "[data-touch] .switch"]) {
    assert.match(ruleOf(panels, selector) ?? "", new RegExp(String.raw`min-height:\s*${AT_LEAST_TARGET}`), `panels ${selector}`);
  }
  const coldOpen = css("panels/ColdOpenPanel.module.css");
  assert.match(ruleOf(coldOpen, "[data-touch] .preset") ?? "", new RegExp(String.raw`min-height:\s*${AT_LEAST_TARGET}`), "a transition style in the card");
});

// --- forced colours (§8.4; fixer, findings 5 and 6) ------------------------------------------------
// Forced colours (Windows high contrast) replace every colour with the user's palette and drop
// box-shadow. A control whose focus or chosen state is drawn only with colours or a shadow loses it.

/** Every stylesheet under components/editor, as paths relative to it. */
function editorCss(dir = "") {
  return readdirSync(path.join(editorDir, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) return editorCss(relative);
    return entry.name.endsWith(".css") ? [relative] : [];
  });
}

/** A selector list split on its top-level commas. */
function selectorList(list) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of list) {
    if (char === "(" || char === "[") depth += 1;
    if (char === ")" || char === "]") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current.trim().replace(/\s+/g, " "));
      current = "";
    } else current += char;
  }
  if (current.trim()) parts.push(current.trim().replace(/\s+/g, " "));
  return parts;
}

const inForcedColours = (rule) => rule.at.some((at) => /forced-colors:\s*active/.test(at));

test("a control drawn by its label or track shows focus with an outline there, which forced colours keep", () => {
  const missing = [];
  let seen = 0;
  for (const file of editorCss()) {
    const declsBySelector = new Map();
    for (const rule of cssRules(readFileSync(path.join(editorDir, file), "utf8")).filter((item) => !inForcedColours(item))) {
      for (const selector of selectorList(rule.selector)) declsBySelector.set(selector, [...(declsBySelector.get(selector) ?? []), ...rule.decls]);
    }
    for (const [selector, decls] of declsBySelector) {
      // The focused element is an invisible input; the ring is drawn on its label or the track beside it.
      if (!/:has\([^)]*:focus-visible[^)]*\)|:focus-visible\s*[+~]/.test(selector)) continue;
      seen += 1;
      const outline = decls.some((decl) => ["outline", "outline-style"].includes(decl.prop) && !/^(?:none|0)\b/.test(decl.value));
      if (!outline) missing.push(`${file} ${selector}`);
    }
  }
  assert.ok(seen >= 8, `the scan reaches the drawn controls (${seen})`);
  assert.deepEqual(missing, []);
});

const CHOSEN = /:checked|\[aria-(?:pressed|selected|checked)="true"\]/;
const COLOUR_PROPS = /^(?:background(?:-color)?|border(?:-(?:top|right|bottom|left))?-color|box-shadow|color|fill|stroke)$/;

test("under forced colours a chosen or pressed control keeps a mark of its own", () => {
  const missing = [];
  let seen = 0;
  for (const file of editorCss()) {
    const rules = cssRules(readFileSync(path.join(editorDir, file), "utf8"));
    const plain = rules.filter((rule) => !inForcedColours(rule));
    const forced = rules.filter(inForcedColours).flatMap((rule) => selectorList(rule.selector));
    const textMark = (head) => plain.some((rule) => selectorList(rule.selector).some((selector) => selector.startsWith(head))
      && rule.decls.some((decl) => decl.prop === "content" && /^["'][^"']+["']/.test(decl.value)));
    for (const rule of plain) {
      if (!rule.decls.some((decl) => COLOUR_PROPS.test(decl.prop))) continue;
      for (const selector of selectorList(rule.selector)) {
        const match = CHOSEN.exec(selector);
        if (!match) continue;
        // The chosen element's part of the selector: `.pill:has(input:checked`, `.cover:checked`.
        const head = selector.slice(0, match.index + match[0].length);
        seen += 1;
        if (textMark(head)) continue; // a visible word marks it ("Dipakai")
        if (!forced.some((item) => item.startsWith(head))) missing.push(`${file} ${selector}`);
      }
    }
  }
  assert.ok(seen >= 12, `the scan reaches the chosen states (${seen})`);
  assert.deepEqual([...new Set(missing)], []);
});
