// The one-layout editor (rombak 06 §2–§4, §9, §14; 08 Fase 10 Editor F1) on the editor fakes:
// Teks open on load and exactly one tab panel, a click on the open tab keeps it, the tabs by
// keyboard, the old ?mode/?card/?panel links landing on their tab without a console error, the
// grid per breakpoint with no page scroll at 1366×768, the ratio label, the conditional checks
// button, the Klip list and its drawer, and the single-key shortcut switch shared with the app.
// It replaces editor-views.spec.mjs once the old shell is removed (F10).
//
// On GitHub Actions: gh workflow run editor-gates.yml -f ref=<branch> -f suite=e2e \
//   -f command='e2e/editor-layout-shell.spec.mjs'
import { TAB_IDS, openPanel, panelRegion, panelTab, tabName } from "./support/editor-panels.mjs";
import {
  closeShortcutDialog, expect, openShell, otherClipId, playButton, shortcutDialog, test, useShellDefaults,
} from "./support/editor-shell.mjs";
import { openShortcutHelp } from "./support/editor-topbar.mjs";
import { L } from "./support/i18n.mjs";

useShellDefaults();

const tabpanels = (page) => panelRegion(page).getByRole("tabpanel");
const topBar = (page) => page.locator('[data-slot="topBar"]');
const clipList = (page) => page.locator('[data-slot="clips"]').getByRole("grid", { name: L("editor.clips.title") });

test("Teks is open on load: five tabs in order, exactly one tab panel, the transcript and the clip list always there", async ({ page }) => {
  await openShell(page);
  await expect(panelRegion(page).getByRole("tab")).toHaveText(TAB_IDS.map(tabName));
  await expect(panelTab(page, "text")).toHaveAttribute("aria-selected", "true");
  await expect(tabpanels(page)).toHaveCount(1);
  await expect(tabpanels(page)).toBeVisible();
  await expect(page.locator('[role="tabpanel"]:visible')).toHaveCount(1);
  await expect(page.locator('[data-slot="transcript"]')).toBeVisible();
  await expect(page.locator('[data-slot="clips"]')).toBeVisible();
  // No view switch, no tools rail, no cards (latest only).
  await expect(page.locator("[data-view-switch]")).toHaveCount(0);
  await expect(page.locator("[data-rail]")).toHaveCount(0);
  await expect(page.locator('[data-slot="cards"]')).toHaveCount(0);
});

test("every tab shows its own panel and only it; a click on the open tab keeps it open", async ({ page }) => {
  await openShell(page);
  // Teks last: it is already open, and choosing another tab first puts ?panel in the address.
  for (const id of ["layout", "audio", "logo", "coldopen", "text"]) {
    const panel = await openPanel(page, id);
    await expect(panel).toBeVisible();
    await panelTab(page, id).click();
    await expect(panelTab(page, id)).toHaveAttribute("aria-selected", "true");
    await expect(tabpanels(page)).toHaveCount(1);
    await expect(page).toHaveURL(new RegExp(`\\?panel=${id}$`));
  }
});

test("the tabs by keyboard: ← → move and select, Home and End go to the ends, the frame stays put", async ({ page }) => {
  await openShell(page);
  const frame = () => page.evaluate(() => window.__potonginEditor.player.state()?.frame ?? null);
  const before = await frame();
  await panelTab(page, "text").focus();
  await page.keyboard.press("ArrowRight");
  await expect(panelTab(page, "layout")).toBeFocused();
  await expect(panelTab(page, "layout")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(panelTab(page, "coldopen")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await expect(panelTab(page, "text")).toHaveAttribute("aria-selected", "true");
  expect(await frame()).toBe(before);
  await expect(tabpanels(page)).toHaveCount(1);
});

for (const [query, id, search] of [
  ["?mode=cepat", "text", ""],
  ["?mode=lengkap&panel=music", "audio", "?panel=audio"],
  ["?panel=transcript", "text", "?panel=text"],
  ["?card=hook", "text", "?panel=text"],
  ["?card=lines", "text", "?panel=text"],
  ["?card=coldopen", "coldopen", "?panel=coldopen"],
  ["?card=layout", "layout", "?panel=layout"],
  ["?card=extras", "logo", "?panel=logo"],
  ["?panel=logo", "logo", "?panel=logo"],
  ["?panel=bogus", "text", ""],
]) {
  test(`an old link ${query} opens the ${id} tab and the address reads '${search || "(none)"}'`, async ({ page }) => {
    await openShell(page, query);
    await expect(panelTab(page, id)).toHaveAttribute("aria-selected", "true");
    await expect(tabpanels(page)).toHaveCount(1);
    expect(new URL(page.url()).search).toBe(search);
  });
}

test("the two-view editor's remembered view is dropped on the first open", async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("seeded")) {
      window.localStorage.setItem("potongin-editor-view", "lengkap");
      window.sessionStorage.setItem("seeded", "1");
    }
  });
  await openShell(page);
  expect(await page.evaluate(() => window.localStorage.getItem("potongin-editor-view"))).toBeNull();
});

test("at 1366×768 the page never scrolls; the transcript sits under the stage; the ratio label follows doc.output", async ({ page }) => {
  await openShell(page);
  const size = await page.evaluate(() => ({
    scrollHeight: document.scrollingElement.scrollHeight, scrollWidth: document.scrollingElement.scrollWidth,
    innerHeight: window.innerHeight, innerWidth: window.innerWidth,
  }));
  expect(size.scrollHeight).toBeLessThanOrEqual(size.innerHeight);
  expect(size.scrollWidth).toBeLessThanOrEqual(size.innerWidth);
  const stage = await page.locator('[data-slot="stage"]').boundingBox();
  const transcript = await page.locator('[data-slot="transcript"]').boundingBox();
  expect(transcript.y).toBeGreaterThanOrEqual(stage.y + stage.height - 1);
  await expect(page.locator("[data-stage-ratio]")).toHaveText(L("editor.stage.ratio", { ratio: "9:16" }));
});

test("at 1920×1080 the transcript sits beside the stage, the columns keep their widths and nothing scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openShell(page);
  const stage = await page.locator('[data-slot="stage"]').boundingBox();
  const transcript = await page.locator('[data-slot="transcript"]').boundingBox();
  expect(transcript.x).toBeGreaterThanOrEqual(stage.x + stage.width - 1);
  expect(Math.abs(transcript.y - stage.y)).toBeLessThan(2);
  expect(Math.round((await page.locator('[data-slot="clips"]').boundingBox()).width)).toBe(240);
  expect(Math.round((await panelRegion(page).boundingBox()).width)).toBe(380);
  expect(await page.evaluate(() => document.scrollingElement.scrollHeight <= window.innerHeight)).toBe(true);
});

test("without checks or notes the top bar has no checks button", async ({ page }) => {
  await openShell(page);
  await expect(topBar(page).locator("[data-checks-button]")).toHaveCount(0);
});

test("with a warning the checks button reads 'Perlu dicek 1' and opens the list", async ({ page }) => {
  await openShell(page, "", { planWarnings: [{ code: "tight_cut", ref: "rm_01", f: 120 }] });
  const button = topBar(page).getByRole("button", { name: L("editor.shell.checks.needs", { count: 1 }), exact: true });
  await expect(button).toBeVisible();
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
});

test("the Klip list: one row per clip with its number, duration and edit mark; a row opens that clip on the same tab", async ({ page }) => {
  await openShell(page, "", { clips: 3, at: 1 });
  const rows = clipList(page).getByRole("row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveAttribute("data-current", "true");
  await expect(rows.nth(1)).toContainText("#2");
  await expect(rows.nth(1)).toContainText("0:12");
  await expect(rows.nth(1)).toContainText(L("editor.clips.edited"));
  await expect(rows.nth(2)).not.toContainText(L("editor.clips.edited"));
  await openPanel(page, "layout");
  await rows.nth(2).click();
  await expect(page).toHaveURL(new RegExp(`/clips/${otherClipId(3)}/edit\\?panel=layout$`));
});

test("below 1280 px the clip column is a rail whose Klip button opens the list in a drawer; Escape closes it back to the button", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 768 });
  await openShell(page, "", { clips: 3, at: 1 });
  const rail = page.locator('[data-slot="clips"]');
  await expect(rail.getByRole("grid")).toHaveCount(0);
  const open = rail.getByRole("button", { name: L("editor.clips.open"), exact: true });
  await open.click();
  const drawer = page.getByRole("dialog", { name: L("editor.clips.title") });
  await expect(drawer.getByRole("grid", { name: L("editor.clips.title") }).getByRole("row")).toHaveCount(3);
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(open).toBeFocused();
});

test("'Pintasan satu tombol' turns K, I, O, ' and ? off, is the shared cookie, and survives a reload", async ({ page, context }) => {
  await openShell(page);
  await openShortcutHelp(page);
  const toggle = shortcutDialog(page).getByRole("switch", { name: L("editor.shortcuts.singleKey") });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(shortcutDialog(page).locator("[data-shortcut-off]")).toHaveCount(5);
  const cookies = await context.cookies();
  expect(cookies.find((cookie) => cookie.name === "potongin_shortcuts")?.value).toBe("off");
  await closeShortcutDialog(page).click();
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("k");
  await page.keyboard.press("Shift+?");
  // Nothing may happen: give the keys time to act before checking that they did not.
  await page.waitForTimeout(400);
  await expect(playButton(page)).toBeVisible();
  await expect(shortcutDialog(page)).toHaveCount(0);
  await page.keyboard.press("Space");
  await expect(playButton(page, { playing: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 30_000 });
  await openShortcutHelp(page);
  await expect(shortcutDialog(page).getByRole("switch", { name: L("editor.shortcuts.singleKey") })).not.toBeChecked();
});

test("the old shell still opens while the server keeps POTONGIN_EDITOR_SHELL=legacy", async ({ page }) => {
  await openShell(page, "?mode=lengkap", { shell: "legacy" });
  await expect(page.locator("[data-rail]")).toBeVisible();
  await expect(page.locator('[data-slot="clips"]')).toHaveCount(0);
});
