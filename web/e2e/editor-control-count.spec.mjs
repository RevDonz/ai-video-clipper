// How many controls each place of the editor shows when it opens (rombak 06 §2.3, §18.4; 08 §1.1
// butir 5): the DOM count of buttons, tabs, switches, radios and fields, per tab of the
// one-layout editor ("after") and per view and tab of the old one ("before"), at 1366×768. The
// baseline is docs/editor/evidence/control-count.json; a count above it fails until the baseline
// is raised in the same change, and exactly one tab panel is visible in every tab.
//
// The numbers are measured, never written by hand: every run writes what it saw to
// $EDITOR_GATES_OUT/control-count.json (the gates artifact). While the baseline holds no numbers
// yet (null), the test fails with the measured file's place; copying it into
// docs/editor/evidence/control-count.json records the F1 baseline.
//
// On GitHub Actions: gh workflow run editor-gates.yml -f ref=<branch> -f suite=e2e \
//   -f command='e2e/editor-control-count.spec.mjs'
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { TAB_NAMES, openPanel, panelRegion } from "./support/editor-panels.mjs";
import { expect, openShell, test, useShellDefaults } from "./support/editor-shell.mjs";

useShellDefaults();
test.describe.configure({ mode: "serial" });

const BASELINE_FILE = new URL("../../docs/editor/evidence/control-count.json", import.meta.url);
const BASELINE = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
const SELECTOR = BASELINE.selector;
const LEGACY_TABS = Object.freeze({ transcript: "Transkrip", text: "Teks", coldopen: "Cold open", layout: "Tata letak", logo: "Logo", music: "Musik" });
const measured = { before: { cepat: null, lengkap: {} }, after: {} };

/** The visible controls on the page: what a viewer can see and reach without opening anything. */
function countControls(page) {
  return page.evaluate((selector) => [...document.querySelectorAll(selector)].filter((element) => {
    if (element.closest("[inert], [hidden], [aria-hidden='true']")) return false;
    const box = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    // A visually hidden input (a React Aria radio or switch) counts through its visible label.
    const label = element.closest("label");
    const shown = box.width > 1 && box.height > 1 ? element : label;
    if (!shown) return false;
    const shownBox = shown.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && shownBox.width > 1 && shownBox.height > 1;
  }).length, SELECTOR);
}

test.afterAll(() => {
  const out = process.env.EDITOR_GATES_OUT;
  if (!out) return;
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, "control-count.json"), `${JSON.stringify({ ...BASELINE, measured }, null, 2)}\n`);
});

test("the baseline names the selector and the viewport of 06 §2.3", () => {
  expect(SELECTOR).toBe("button, [role=button], [role=tab], [role=switch], [role=radio], input, select, textarea");
  expect(BASELINE.viewport).toEqual({ width: 1366, height: 768 });
});

test("before: the two-view editor, Mode Cepat and every Mode Lengkap tab", async ({ page }) => {
  await openShell(page, "?mode=cepat", { shell: "legacy" });
  measured.before.cepat = await countControls(page);
  for (const [id, name] of Object.entries(LEGACY_TABS)) {
    await page.goto(`${new URL(page.url()).pathname}?mode=lengkap&panel=${id}`);
    await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("tab", { name, exact: true })).toHaveAttribute("aria-selected", "true");
    measured.before.lengkap[id] = await countControls(page);
  }
});

test("after: each of the five tabs as it opens, one tab panel each, never above the baseline", async ({ page }) => {
  await openShell(page);
  for (const id of ["text", "layout", "audio", "logo", "coldopen"]) {
    await openPanel(page, id);
    await expect(panelRegion(page).getByRole("tabpanel")).toHaveCount(1);
    await expect(page.locator('[role="tabpanel"]:visible')).toHaveCount(1);
    measured.after[id] = await countControls(page);
  }
  const unmeasured = Object.keys(TAB_NAMES).filter((id) => !Number.isSafeInteger(BASELINE.after?.[id]));
  expect(unmeasured, `no baseline yet for ${unmeasured.join(", ")}: record the measured counts `
    + `($EDITOR_GATES_OUT/control-count.json, now ${JSON.stringify(measured.after)}) in docs/editor/evidence/control-count.json`).toEqual([]);
  for (const id of Object.keys(TAB_NAMES)) {
    expect(measured.after[id], `${id}: ${measured.after[id]} controls, the baseline allows ${BASELINE.after[id]}`).toBeLessThanOrEqual(BASELINE.after[id]);
  }
});
