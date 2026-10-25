// The click-budget table the e2e spec walks (web/e2e/support/click-budget.mjs) stays the §10 table
// of rombak 06: one entry per row, the cell copied as written, the budget its largest number, and
// every entry either walkable (steps and a target), exempt, or waiting for a named sub-phase. A
// waiting entry whose control is already in the one layout is walked where it sits today; the
// others say why they cannot be walked yet (`gap`).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { CLICK_BUDGET, clickCount } from "../e2e/support/click-budget.mjs";
import { SHELL_DOCS, shellDoc, shellDocContext } from "../e2e/support/shell-docs.mjs";
import { checkDoc } from "../lib/editor/doc-model.mjs";

const DOC = new URL("../../docs/plans/2026-10-24-rombak/06-editor.md", import.meta.url);
// F2 (the transcript) has landed: its rows are walked, so it is no longer a phase to wait for.
const PHASES = new Set(["F3", "F4a", "F4b", "F5", "F6", "F7", "F8", "F9"]);
const WITHIN = new Set(["topBar", "clips", "stage", "transcript", "panel", "timeline", "menu", "dialog"]);
const SCENARIO_KEYS = new Set(["clips", "planWarnings", "readOnly", "conflict", "removal", "context", "doc"]);
// Rows whose control waits for a later sub-phase but is in the one layout already (06 §2.3, §10):
// walked at their place today, so the F2 shell keeps every existing capability within budget.
const WALKED_TODAY = [17, 19, 20, 43, 44, 46, 47, 49, 50, 51, 59, 60, 61, 62, 63, 64, 65, 66, 67, 72, 75, 76, 77, 89, 91];

/** `{row: clicksCell}` of the §10 table. */
function docRows() {
  const text = readFileSync(DOC, "utf8");
  const section = text.slice(text.indexOf("## 10. Peta fitur lengkap"), text.indexOf("## 11. Backend"));
  const rows = new Map();
  for (const line of section.split("\n")) {
    const match = /^\| (\d+) \|(.*)\|$/.exec(line);
    if (!match) continue;
    const cells = match[2].split(" | ").map((cell) => cell.trim());
    rows.set(Number(match[1]), cells.at(-1));
  }
  return rows;
}

const largest = (cell) => Math.max(...[...cell.matchAll(/\d+/g)].map((match) => Number(match[0])));

function checkLocator(locator, where) {
  assert.ok(locator && typeof locator === "object", where);
  assert.ok(WITHIN.has(locator.within), `${where}: within`);
  if (locator.testId) return;
  // A word of the transcript, by its index in the words artifact (it has no role of its own).
  if (Object.hasOwn(locator, "word")) {
    assert.ok(Number.isInteger(locator.word) && locator.word >= 0, `${where}: word`);
    assert.equal(locator.within, "transcript", `${where}: a word is in the transcript`);
    return;
  }
  assert.equal(typeof locator.role, "string", `${where}: role`);
  assert.equal(typeof locator.name, "string", `${where}: name`);
  if (locator.regex) assert.doesNotThrow(() => new RegExp(locator.name), where);
}

test("one entry per row of the §10 table, in its order, with the cell as written", () => {
  const rows = docRows();
  assert.equal(rows.size, 92, "the scan reaches all of §10");
  assert.deepEqual(CLICK_BUDGET.map((item) => item.row), [...rows.keys()]);
  for (const item of CLICK_BUDGET) assert.equal(item.docClicks, rows.get(item.row), `row ${item.row}`);
});

test("each budget is the cell's largest number, unless a note says why", () => {
  for (const item of CLICK_BUDGET) {
    if (item.excluded) {
      assert.equal(item.budget, undefined, `row ${item.row}`);
      assert.ok(/\S/.test(item.excluded), `row ${item.row}: a reason`);
      continue;
    }
    if (item.budgetNote) assert.ok(item.budget > largest(item.docClicks), `row ${item.row}: a note only to raise the count`);
    else assert.equal(item.budget, largest(item.docClicks), `row ${item.row}`);
    // A task outside the closed list of advanced tasks (06 §2.3) is at most 3 clicks.
    if (![38, 54, 61, 65].includes(item.row)) assert.ok(item.budget <= 3, `row ${item.row} is a common task`);
    else assert.ok(item.budget <= 5, `row ${item.row} is an advanced task`);
  }
});

test("a walkable entry fits its budget with locators the spec understands; the rest name their sub-phase", () => {
  let walkable = 0;
  for (const item of CLICK_BUDGET) {
    if (item.excluded) continue;
    if (item.pending) assert.ok(PHASES.has(item.pending), `row ${item.row}: ${item.pending}`);
    if (item.pending && !item.target) {
      assert.equal(typeof item.gap, "string", `row ${item.row}: a waiting entry that is not walked says why`);
      assert.ok(/\S/.test(item.gap), `row ${item.row}: gap`);
      assert.equal(item.steps, undefined, `row ${item.row}: no steps without a target`);
      continue;
    }
    assert.equal(item.gap, undefined, `row ${item.row}: a walked entry has no gap`);
    walkable += 1;
    assert.ok(Array.isArray(item.steps), `row ${item.row}: steps`);
    item.steps.forEach((step, at) => checkLocator(step, `row ${item.row} step ${at}`));
    checkLocator(item.target, `row ${item.row} target`);
    for (const key of Object.keys(item.scenario ?? {})) assert.ok(SCENARIO_KEYS.has(key), `row ${item.row}: scenario ${key}`);
    if (item.scenario?.doc) assert.ok(Object.hasOwn(SHELL_DOCS, item.scenario.doc), `row ${item.row}: doc ${item.scenario.doc}`);
    assert.ok(clickCount(item) <= item.budget, `row ${item.row}: ${clickCount(item)} clicks for a budget of ${item.budget}`);
  }
  assert.ok(walkable >= 15, "the shell's own controls are walked from F1 on");
  // F2: the transcript's rows (21–32), the read-only and conflict rows (10, 11) and Linimasa (78).
  for (const row of [10, 11, ...Array.from({ length: 12 }, (_, at) => 21 + at), 78]) {
    const item = CLICK_BUDGET.find((entry) => entry.row === row);
    assert.equal(item.pending, undefined, `row ${row} is walked from F2 on`);
    assert.ok(item.target, `row ${row}: a target`);
  }
  assert.ok(walkable >= 33, "the shell's and the transcript's controls are walked");
  for (const row of WALKED_TODAY) {
    const item = CLICK_BUDGET.find((entry) => entry.row === row);
    assert.ok(item.target, `row ${row}: walked at its place today`);
  }
  assert.ok(walkable >= 58, "the panels' controls that the one layout mounts today are walked too");
});

test("every document a row opens is valid for the fakes' clip", () => {
  for (const name of Object.keys(SHELL_DOCS)) {
    assert.deepEqual(checkDoc(shellDoc(name), shellDocContext()), [], name);
  }
});
