// Mode Cepat scaffolding landed by Z0 (docs/plans/2026-10-02-editor-mode-cepat.md §10 step 1,
// "Shapes fixed here"): the card registry and its placeholder files, the Rail and Scrubber
// seams, the line-model API, the size tokens, the `gates` input of editor-gates.yml, the e2e
// helpers per owner and the existing specs pinned to Mode Lengkap. Tasks A to D replace the files
// behind these shapes, never the shapes.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CARDS, DEFAULT_CARD, cardById } from "../components/editor/quick/cards.mjs";
import * as captionLines from "../lib/editor/caption-lines.mjs";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const editorDir = path.join(webDir, "components", "editor");
const read = (...parts) => readFileSync(path.join(...parts), "utf8");

test("the card registry lists the six cards in the mockup's order, Caption open on load", () => {
  assert.deepEqual(CARDS.map((card) => [card.id, card.label, card.owner]), [
    ["hook", "Hook", "B"],
    ["caption", "Caption", "B"],
    ["lines", "Teks caption", "C"],
    ["coldopen", "Cold open", "B"],
    ["layout", "Tata letak", "B"],
    ["extras", "Logo & Musik", "B"],
  ]);
  assert.ok(Object.isFrozen(CARDS));
  assert.equal(DEFAULT_CARD, "caption");
  assert.equal(cardById("lines").file, "quick/CaptionLinesCard.jsx");
  assert.equal(cardById("nope"), null);
});

test("every card entry has its component file", () => {
  for (const card of CARDS) {
    const file = path.join(editorDir, card.file);
    assert.ok(existsSync(file), card.file);
    const source = readFileSync(file, "utf8");
    assert.match(source, /^"use client";/, card.file);
    assert.match(source, new RegExp(`export default function ${card.component}\\(`), card.file);
    assert.equal(typeof card.load, "function", card.file);
  }
});

test("the view seams exist: QuickPanel, Rail({ panels, value, onChange }) and Scrubber({ plan, state, player, frameBus, disabled })", () => {
  assert.match(read(editorDir, "quick", "QuickPanel.jsx"), /export default function QuickPanel\(/);
  assert.match(read(editorDir, "rail", "Rail.jsx"), /export default function Rail\(\{ panels, value, onChange/);
  assert.match(read(editorDir, "scrubber", "Scrubber.jsx"), /export default function Scrubber\(\{ plan,[^}]*player, frameBus/);
  const app = read(editorDir, "EditorApp.jsx");
  assert.match(app, /<QuickPanel\b/);
  assert.match(app, /<Rail\b/);
  assert.match(app, /<Scrubber\b/);
});

test("the line model exports the whole API of §2, the parts task C builds included", () => {
  for (const name of ["captionRows", "linesSummary", "lineEdit", "checkCommands", "focusAfterRegroup"]) {
    assert.equal(typeof captionLines[name], "function", name);
  }
});

test("the size tokens of §8.1 are on the editor root", () => {
  const css = read(editorDir, "editor.module.css");
  for (const [name, value] of [["--ed-target", "44px"], ["--ed-bottom-height", "96px"], ["--ed-rail-width", "84px"],
    ["--ed-side-width", "clamp(360px, 32vw, 460px)"], ["--ed-font-size-note", "13px"], ["--ed-label-tracking", "0.08em"]]) {
    assert.match(css, new RegExp(`^\\s*${name}: ${value.replace(/[()]/g, "\\$&")};$`, "m"), name);
  }
});

test("editor-gates.yml has a boolean `gates` input that only sets EDITOR_GATES=1 for the e2e specs", () => {
  const workflow = read(webDir, "..", ".github", "workflows", "editor-gates.yml");
  assert.match(workflow, /^ {6}gates:\n {8}description: [^\n]+\n {8}required: false\n {8}default: false\n {8}type: boolean$/m);
  const uses = workflow.match(/inputs\.gates/g) ?? [];
  assert.equal(uses.length, 1, "one use of the input");
  assert.match(workflow, /^ {10}EDITOR_GATES: \$\{\{ inputs\.gates && '1' \|\| '' \}\}$/m);
  const step = workflow.slice(workflow.indexOf("- name: Browser specs on the editor fakes"), workflow.indexOf("- name: Build the production image"));
  assert.match(step, /EDITOR_GATES: \$\{\{ inputs\.gates/, "the input reaches the e2e step");
});

test("the e2e helpers exist per owner with the names the specs call", () => {
  const support = path.join(webDir, "e2e", "support");
  const exportsOf = (file) => [...read(support, file).matchAll(/^export (?:async )?function (\w+)\(/gm)].map((match) => match[1]);
  assert.deepEqual(exportsOf("editor-topbar.mjs").sort(),
    ["openChecks", "openShortcutHelp", "resetToAi", "safeZone", "switchView", "toggleTruthFrame"]);
  assert.deepEqual(exportsOf("editor-words.mjs"), ["wordAction"]);
  assert.deepEqual(exportsOf("editor-cards.mjs"), ["openCard"]);
});

test("the existing editor specs open Mode Lengkap explicitly, so a new default view cannot move them", () => {
  const specs = readdirSync(path.join(webDir, "e2e")).filter((name) => /^editor-.*\.spec\.mjs$/.test(name));
  const constants = specs.flatMap((name) => [...read(webDir, "e2e", name).matchAll(/^const (EDITOR|editorUrl) = (.+)$/gm)]
    .map((match) => [name, match[2]]));
  assert.ok(constants.length >= 8, "the scan reaches the specs' editor URLs");
  for (const [name, value] of constants) assert.match(value, /\/edit\?mode=lengkap`;$/, name);
});
