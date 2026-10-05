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

const editorDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "components", "editor");
const KIT_DIRS = ["ui", "quick", "rail", "scrubber"];

function cssFiles(dirs) {
  return dirs.flatMap((dir) => {
    const full = path.join(editorDir, dir);
    if (!existsSync(full)) return [];
    return readdirSync(full).filter((name) => name.endsWith(".css")).map((name) => path.join(dir, name));
  });
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

test("an accordion's header button and its region name each other", () => {
  assert.deepEqual(accordionIds("card-hook"), { button: "card-hook-button", region: "card-hook-region" });
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
  const files = cssFiles(KIT_DIRS);
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
