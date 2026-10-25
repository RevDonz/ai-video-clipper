// The click-budget table the e2e spec walks (web/e2e/support/click-budget.mjs) stays the §10 table
// of rombak 06: one entry per row, the cell copied as written, the budget its largest number, and
// every entry either walkable (steps and a target), waiting for a named sub-phase, or exempt.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { CLICK_BUDGET, clickCount } from "../e2e/support/click-budget.mjs";

const DOC = new URL("../../docs/plans/2026-10-24-rombak/06-editor.md", import.meta.url);
const PHASES = new Set(["F2", "F3", "F4a", "F4b", "F5", "F6", "F7", "F8", "F9"]);
const WITHIN = new Set(["topBar", "clips", "stage", "panel", "menu", "dialog"]);

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
    if (item.pending) {
      assert.ok(PHASES.has(item.pending), `row ${item.row}: ${item.pending}`);
      assert.equal(item.target, undefined, `row ${item.row}: pending entries have no target yet`);
      continue;
    }
    walkable += 1;
    assert.ok(Array.isArray(item.steps), `row ${item.row}: steps`);
    item.steps.forEach((step, at) => checkLocator(step, `row ${item.row} step ${at}`));
    checkLocator(item.target, `row ${item.row} target`);
    assert.ok(clickCount(item) <= item.budget, `row ${item.row}: ${clickCount(item)} clicks for a budget of ${item.budget}`);
  }
  assert.ok(walkable >= 15, "the shell's own controls are walked from F1 on");
});
