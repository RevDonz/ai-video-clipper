// The transcript of the one-layout editor (rombak 06 §6, §8.6; 08 Fase 10 Editor F2) on the
// editor fakes: always on screen in the centre, Kata | Baris, the word toolbar (the cut that
// applies, Edit kata, Mulai and Akhiri di sini on the bar; Kata kunci, Sembunyikan dari caption
// and Jadikan cold open behind ⋯), Ctrl+click for Kata kunci, Rapikan n and Ejaan n opening one
// drawer with two tabs, and Linimasa detail folded until opened. The old shell keeps its own
// specs (editor-transcript, editor-cleanup, editor-spelling) until F10.
//
// On GitHub Actions: gh workflow run editor-gates.yml -f ref=<branch> -f suite=e2e \
//   -f command='e2e/editor-transcript-shell.spec.mjs'
import { ACTION_LABELS, MENU_LABEL, TOOLBAR_LABEL } from "../components/editor/transcript/word-toolbar.mjs";
import { expect, openShell, test, useShellDefaults } from "./support/editor-shell.mjs";
import { L } from "./support/i18n.mjs";

useShellDefaults();

const BODY_WORD = 4;
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const startsWith = (text) => new RegExp(`^${escape(text)}`);

const transcript = (page) => page.locator('[data-slot="transcript"]');
const word = (page, index) => transcript(page).locator(`[data-transcript-words] [data-w="${index}"]`);
const toolbar = (page) => transcript(page).getByRole("toolbar", { name: TOOLBAR_LABEL });
const modes = (page) => transcript(page).getByRole("radiogroup", { name: L("editor.transcript.modeLabel") });
const mode = (page, id) => modes(page).getByRole("radio", { name: L(`editor.transcript.modes.${id}`), exact: true });
const cleanupButton = (page) => transcript(page).getByRole("button", { name: startsWith(L("editor.transcript.cleanup")) });
const spellingButton = (page) => transcript(page).getByRole("button", { name: startsWith(L("editor.transcript.spelling")) });
const drawer = (page) => page.getByRole("dialog", { name: L("editor.transcript.review.title") });
const timeline = (page) => page.locator('[data-slot="timeline-detail"]');
const timelineButton = (page) => timeline(page).getByRole("button", { name: L("editor.shell.timeline"), exact: true });
const commands = (page) => page.evaluate(() => (window.__potonginEditor.store.getState().commands ?? []).map(({ type, args }) => ({ type, args })));

test("the transcript is in the centre on open, in Kata, with Rapikan n beside Kata | Baris; Linimasa detail is folded", async ({ page }) => {
  await openShell(page);
  await expect(transcript(page)).toBeVisible();
  await expect(transcript(page).getByRole("heading", { level: 2, name: L("editor.shell.transcript") })).toBeVisible();
  await expect(mode(page, "words")).toBeChecked();
  await expect(mode(page, "lines")).not.toBeChecked();
  await expect(transcript(page).locator("[data-transcript-words]")).toBeVisible();
  await expect(word(page, BODY_WORD)).toBeVisible();
  // The list is fetched with the transcript, so the button counts it at once.
  await expect(cleanupButton(page)).toHaveAccessibleName(L("editor.transcript.cleanupCount", { count: 3 }));
  await expect(spellingButton(page)).toHaveAccessibleName(L("editor.transcript.spelling"));
  await expect(timelineButton(page)).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator('[data-slot="timeline"]')).toHaveCount(0);
  // No review is open inline: it lives in the drawer now.
  await expect(page.locator("[data-cleanup-review]")).toHaveCount(0);
});

test("a click on a word selects it: the bar holds the cut that applies, Edit kata, Mulai and Akhiri; ⋯ holds the rest", async ({ page }) => {
  await openShell(page);
  await word(page, BODY_WORD).click();
  await expect(toolbar(page)).toBeVisible();
  const names = [ACTION_LABELS.remove, ACTION_LABELS.edit, ACTION_LABELS.trimStart, ACTION_LABELS.trimEnd, MENU_LABEL];
  await expect(toolbar(page).getByRole("button")).toHaveText(names);
  // A cut action that does not apply is not there at all.
  await expect(toolbar(page).getByRole("button", { name: ACTION_LABELS.restore, exact: true })).toHaveCount(0);
  await expect(toolbar(page).getByRole("button", { name: ACTION_LABELS.extend, exact: true })).toHaveCount(0);
  await toolbar(page).getByRole("button", { name: MENU_LABEL, exact: true }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitemcheckbox", { name: ACTION_LABELS.emphasis })).toBeVisible();
  await expect(menu.getByRole("menuitemcheckbox", { name: ACTION_LABELS.hide })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: ACTION_LABELS.coldOpen })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});

test("Hapus, Mulai di sini and the menu's Sembunyikan run their commands on the selected word", async ({ page }) => {
  await openShell(page);
  const id = await word(page, BODY_WORD).getAttribute("data-word-id");
  await word(page, BODY_WORD).click();
  await toolbar(page).getByRole("button", { name: ACTION_LABELS.trimStart, exact: true }).click();
  await expect.poll(async () => (await commands(page)).at(-1)?.type).toBe("TrimStart");
  await word(page, BODY_WORD).click();
  await toolbar(page).getByRole("button", { name: MENU_LABEL, exact: true }).click();
  await page.getByRole("menu").getByRole("menuitemcheckbox", { name: ACTION_LABELS.hide }).click();
  await expect.poll(async () => (await commands(page)).at(-1)?.type).toBe("SetWordHidden");
  await word(page, BODY_WORD).click();
  await toolbar(page).getByRole("button", { name: ACTION_LABELS.remove, exact: true }).click();
  await expect.poll(async () => (await commands(page)).at(-1)?.type).toBe("RemoveWords");
  if (id) expect(JSON.stringify((await commands(page)).at(-1).args)).toContain(id);
});

test("Ctrl+click marks a word as Kata kunci in one click and leaves the selection alone", async ({ page }) => {
  await openShell(page);
  await word(page, BODY_WORD).click({ modifiers: ["Control"] });
  await expect.poll(async () => (await commands(page)).at(-1)?.type).toBe("SetWordEmphasis");
  await expect(toolbar(page)).toHaveCount(0);
});

test("Rapikan n opens the drawer on Rapikan; Ejaan is its second tab; Escape closes it and focus goes back", async ({ page }) => {
  await openShell(page);
  await cleanupButton(page).click();
  await expect(drawer(page)).toBeVisible();
  const tabs = drawer(page).getByRole("tablist", { name: L("editor.transcript.review.tabsLabel") });
  await expect(tabs.getByRole("tab")).toHaveCount(2);
  await expect(tabs.getByRole("tab", { name: startsWith(L("editor.transcript.cleanup")) })).toHaveAttribute("aria-selected", "true");
  await expect(drawer(page).locator("[data-cleanup-review]")).toBeVisible();
  // While Rapikan is open, the transcript marks what it proposes.
  await expect(transcript(page).locator("[data-cleanup-gap]").first()).toBeAttached();
  await tabs.getByRole("tab", { name: startsWith(L("editor.transcript.spelling")) }).click();
  await expect(drawer(page).locator("[data-spelling-review]")).toBeVisible();
  await expect(drawer(page).locator("[data-cleanup-review]")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(drawer(page)).toHaveCount(0);
  await expect(cleanupButton(page)).toBeFocused();
});

test("Ejaan n opens the same drawer on Ejaan; Tutup closes it", async ({ page }) => {
  await openShell(page);
  await spellingButton(page).click();
  await expect(drawer(page)).toBeVisible();
  await expect(drawer(page).getByRole("tab", { name: startsWith(L("editor.transcript.spelling")) })).toHaveAttribute("aria-selected", "true");
  await drawer(page).getByRole("button", { name: L("aria.close"), exact: true }).click();
  await expect(drawer(page)).toHaveCount(0);
  await expect(spellingButton(page)).toBeFocused();
});

test("Terapkan in the drawer applies the checked items as one command", async ({ page }) => {
  await openShell(page);
  await cleanupButton(page).click();
  const apply = drawer(page).getByRole("button", { name: /\(\d+\)$/ });
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect.poll(async () => (await commands(page)).at(-1)?.type).toBe("ApplyCleanup");
});

test("Baris shows one field per caption line; Kata brings the words back", async ({ page }) => {
  await openShell(page);
  await mode(page, "lines").click();
  await expect(mode(page, "lines")).toBeChecked();
  await expect(transcript(page).locator("[data-caption-lines]")).toBeVisible();
  await expect(transcript(page).locator("[data-line-key] input").first()).toBeVisible();
  await expect(transcript(page).locator("[data-transcript-words]")).toHaveCount(0);
  await mode(page, "words").click();
  await expect(transcript(page).locator("[data-transcript-words]")).toBeVisible();
  await expect(transcript(page).locator("[data-caption-lines]")).toHaveCount(0);
});

test("the old Caption lines link (?card=lines) opens the transcript in Baris", async ({ page }) => {
  await openShell(page, "?card=lines");
  await expect(mode(page, "lines")).toBeChecked();
  await expect(transcript(page).locator("[data-caption-lines]")).toBeVisible();
});

test("a cut shows its restore chip, and one click restores it", async ({ page }) => {
  await openShell(page, "", { removal: [6, 7] });
  const chip = transcript(page).locator("[data-removal-id]");
  await expect(chip).toHaveCount(1);
  await chip.click();
  await expect.poll(async () => (await commands(page)).at(-1)?.type).toBe("RestoreRemoval");
});

test("sentences outside the clip fold away behind one button", async ({ page }) => {
  await openShell(page, "", { context: true });
  const unfold = transcript(page).locator("[data-transcript-words] > button").first();
  await expect(unfold).toBeVisible();
  const before = await transcript(page).locator("[data-transcript-words] [data-w]").count();
  await unfold.click();
  await expect.poll(() => transcript(page).locator("[data-transcript-words] [data-w]").count()).toBeGreaterThan(before);
});

test("Linimasa detail opens with one click, shows the lanes, and stays open after a reload", async ({ page }) => {
  await openShell(page);
  await timelineButton(page).click();
  await expect(timelineButton(page)).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator('[data-slot="timeline"]')).toBeVisible();
  await expect(page.locator("[data-lane-row]").first()).toBeVisible();
  await page.reload();
  await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 30_000 });
  await expect(timelineButton(page)).toHaveAttribute("aria-expanded", "true");
  await timelineButton(page).click();
  await expect(page.locator('[data-slot="timeline"]')).toHaveCount(0);
});

test("at 1366×768 the open transcript, drawer and timeline never scroll the page", async ({ page }) => {
  await openShell(page);
  await timelineButton(page).click();
  await cleanupButton(page).click();
  await expect(drawer(page)).toBeVisible();
  const overflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  }));
  expect(overflow).toEqual({ x: 0, y: 0 });
});
