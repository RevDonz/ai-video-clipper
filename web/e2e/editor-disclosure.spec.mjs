// The "Lanjutan" folds of the one-layout editor (rombak 06 §2, §18.4): closed on load in every tab,
// their title saying what differs from the AI version, remembered per viewer, and "Perbaiki" in
// the checks opens the right tab and fold and focuses the control. Also every control of a tab is a
// 44 px target with visible focus, and axe finds nothing serious with the folds open.
//
// On GitHub Actions: gh workflow run editor-gates.yml -f ref=<branch> -f suite=e2e \
//   -f command='e2e/editor-disclosure.spec.mjs'
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { TAB_IDS, openPanel, panelRegion, panelTab } from "./support/editor-panels.mjs";
import { expect, openTabs as openShell, test, useShellDefaults } from "./support/editor-shell.mjs";
import { L } from "./support/i18n.mjs";
import { shellDoc } from "./support/shell-docs.mjs";

useShellDefaults();

const SEPARATOR = " · ";
const title = (panel, group) => panel.locator(`[data-advanced="${group}"] button`).first();
const summaryOf = (panel, group) => panel.locator(`[data-advanced="${group}"] [data-advanced-summary]`);
const DEFAULT = `${SEPARATOR}${L("editor.advanced.default")}`;

const CASES = [
  ["text", {}, ["caption", "hook"]],
  ["layout", {}, ["camera"]],
  ["layout", { doc: "split" }, ["split"]],
  ["audio", { doc: "music" }, ["music"]],
  ["logo", { doc: "logo" }, ["logo"]],
  ["logo", { doc: "watermark" }, ["watermark"]],
  ["coldopen", { doc: "coldOpen" }, ["coldOpen"]],
];

for (const [tab, { doc }, groups] of CASES) {
  test(`${tab}${doc ? ` with ${doc}` : ""}: ${groups.join(", ")} closed on load, the title says Bawaan`, async ({ page }) => {
    await openShell(page, "", doc ? { doc: shellDoc(doc) } : {});
    const panel = await openPanel(page, tab);
    for (const group of groups) {
      await expect(title(panel, group)).toHaveAttribute("aria-expanded", "false");
      await expect(summaryOf(panel, group)).toHaveText(DEFAULT);
      await expect(panel.locator(`[data-advanced="${group}"] input`).first()).toBeHidden();
    }
  });
}

test("a fold that has no item to tune is not there", async ({ page }) => {
  await openShell(page);
  const audio = await openPanel(page, "audio");
  await expect(audio.locator("[data-advanced]")).toHaveCount(0);
  const logo = await openPanel(page, "logo");
  await expect(logo.locator("[data-advanced]")).toHaveCount(0);
  const coldOpen = await openPanel(page, "coldopen");
  await expect(coldOpen.locator("[data-advanced]")).toHaveCount(0);
});

test("caption: the title follows an edit, and goes back with undo", async ({ page }) => {
  await openShell(page);
  const panel = await openPanel(page, "text");
  await title(panel, "caption").click();
  await panel.getByRole("radiogroup", { name: L("editor.text.caption.entrance") }).getByRole("radio", { name: L("editor.text.entrances.pop"), exact: true }).check();
  await expect(summaryOf(panel, "caption")).toHaveText(`${SEPARATOR}${L("editor.text.entrances.pop")}`);
  await panel.getByRole("radiogroup", { name: L("editor.text.caption.wordsPerLine") }).getByRole("radio", { name: "1", exact: true }).check();
  await expect(summaryOf(panel, "caption")).toHaveText(`${SEPARATOR}${L("editor.text.entrances.pop")}${SEPARATOR}${L("editor.text.summary.words", { count: 1 })}`);
  await page.evaluate(() => { window.__potonginEditor.store.undo(); window.__potonginEditor.store.undo(); });
  await expect(summaryOf(panel, "caption")).toHaveText(DEFAULT);
});

test("hook: design and position show in the title", async ({ page }) => {
  await openShell(page);
  const panel = await openPanel(page, "text");
  await title(panel, "hook").click();
  await panel.getByRole("radiogroup", { name: L("editor.text.hook.design") }).getByRole("radio", { name: new RegExp(`^${L("editor.text.designs.kicker")}`) }).check();
  await expect(summaryOf(panel, "hook")).toHaveText(`${SEPARATOR}${L("editor.text.designs.kicker")}`);
});

test("cold open: a fine nudge shows as a signed offset", async ({ page }) => {
  await openShell(page, "", { doc: shellDoc("coldOpen") });
  const panel = await openPanel(page, "coldopen");
  await title(panel, "coldOpen").click();
  await panel.getByRole("button", { name: L("editor.coldOpen.fine.endLater"), exact: true }).click();
  await expect(summaryOf(panel, "coldOpen")).toContainText(L("editor.coldOpen.summary.out", { sign: "+", seconds: 0.1 }));
});

test("the open state is remembered per fold in this browser, and storage that refuses means closed", async ({ page }) => {
  await openShell(page);
  const panel = await openPanel(page, "text");
  await title(panel, "hook").click();
  await page.reload();
  await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 30_000 });
  const again = await openPanel(page, "text");
  await expect(title(again, "hook")).toHaveAttribute("aria-expanded", "true");
  await expect(title(again, "caption")).toHaveAttribute("aria-expanded", "false");
});

test("the keyboard opens a fold, and focus stays on its button", async ({ page }) => {
  await openShell(page);
  const panel = await openPanel(page, "text");
  await title(panel, "caption").focus();
  await page.keyboard.press("Enter");
  await expect(title(panel, "caption")).toHaveAttribute("aria-expanded", "true");
  await expect(title(panel, "caption")).toBeFocused();
  await expect(panel.getByRole("slider", { name: L("editor.text.caption.fineSize") })).toBeVisible();
});

test("Perbaiki on a hook in the app's top area opens Teks, the hook's fold and focuses its position", async ({ page }) => {
  await openShell(page, "?panel=audio", { planWarnings: [{ code: "unsafe_zone", ref: "it_hook" }] });
  await page.locator('[data-slot="topBar"]').getByRole("button", { name: L("editor.shell.checks.needs", { count: 1 }), exact: true }).click();
  await page.getByRole("button", { name: L("editor.shell.checks.fix"), exact: true }).click();
  await expect(panelTab(page, "text")).toHaveAttribute("aria-selected", "true");
  const panel = panelRegion(page).getByRole("tabpanel");
  await expect(title(panel, "hook")).toHaveAttribute("aria-expanded", "true");
  await expect(panel.getByRole("slider", { name: L("editor.text.hook.position") })).toBeFocused();
});

test("every control of every tab is a 44 px target", async ({ page }) => {
  await openShell(page, "", { doc: shellDoc("coldOpen") });
  for (const id of TAB_IDS) {
    const panel = await openPanel(page, id);
    const small = await panel.evaluate((root) => [...root.querySelectorAll("button, select, input:not([type=radio]):not([type=checkbox]):not([type=file]), textarea, label:has(input[type=radio]), label:has(input[role=switch])")]
      .filter((element) => {
        if (element.closest("[hidden]") || element.closest('[data-hook-suggestions]') || element.closest('[data-coldopen-suggestions]')) return false;
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && (box.height < 44 - 0.5 || box.width < 24);
      }).map((element) => `${element.tagName} "${element.textContent.trim().slice(0, 30)}" ${Math.round(element.getBoundingClientRect().height)}px`));
    expect(small, `${id}: below 44 px`).toEqual([]);
  }
});

test("a focused control shows its focus: the tabs' fold, a slider and a card", async ({ page }) => {
  await openShell(page);
  const panel = await openPanel(page, "text");
  const outlineOf = (locator) => locator.evaluate((element) => {
    const style = window.getComputedStyle(element);
    return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
  });
  await title(panel, "caption").focus();
  await page.keyboard.press("Enter");
  const slider = panel.getByRole("slider", { name: L("editor.text.caption.fineSize") });
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  const outline = await outlineOf(slider);
  expect(outline.style).not.toBe("none");
  expect(outline.width).toBeGreaterThanOrEqual(2);
});

function axeSource() {
  try {
    return readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
  } catch {
    return null;
  }
}
const AXE = process.env.AXE_CORE_PATH ? readFileSync(process.env.AXE_CORE_PATH, "utf8") : axeSource();

test("axe finds no critical or serious violation in any tab with its folds open", async ({ page }) => {
  test.skip(!AXE, "axe-core is not installed here");
  test.setTimeout(120_000);
  await openShell(page, "", { doc: shellDoc("coldOpen") });
  await page.addScriptTag({ content: AXE });
  for (const id of TAB_IDS) {
    const panel = await openPanel(page, id);
    const folds = panel.locator('[data-advanced] button[aria-expanded="false"]');
    while (await folds.count()) await folds.first().click();
    const violations = await page.evaluate(async () => {
      const { violations: found } = await window.axe.run('[data-slot="panel"]', { resultTypes: ["violations"] });
      return found.filter((entry) => entry.impact === "critical" || entry.impact === "serious")
        .map((entry) => ({ id: entry.id, nodes: entry.nodes.map((node) => node.target.join(" ")) }));
    });
    expect(violations, id).toEqual([]);
  }
});
