// Tab Teks of the one-layout editor (rombak 06 §8.1, Editor F3): the caption's and the hook's
// basic controls, "Edit per baris", the suggestions behind one click, and "Pakai di semua klip"
// with its confirmation. The legacy shell's panel and cards keep their own specs until F10.
//
// On GitHub Actions: gh workflow run editor-gates.yml -f ref=<branch> -f suite=e2e \
//   -f command='e2e/editor-text-tab.spec.mjs'
import { openPanel } from "./support/editor-panels.mjs";
import { expect, openTabs as openShell, test, useShellDefaults } from "./support/editor-shell.mjs";
import { L } from "./support/i18n.mjs";

useShellDefaults();

const docOf = (page) => page.evaluate(() => window.__potonginEditor.store.getState().doc);
const hookOf = (doc) => doc.tracks.find((track) => track.kind === "hook")?.items?.[0] ?? null;
const pick = (group, name) => group.getByRole("radio", { name, exact: true }).check();

test("Teks opens with the caption's basics in view and the fine controls folded", async ({ page }) => {
  await openShell(page);
  const panel = await openPanel(page, "text");
  await expect(panel.getByRole("switch", { name: L("editor.text.caption.show") })).toBeChecked();
  await expect(panel.getByRole("radiogroup", { name: L("editor.text.caption.style") }).getByRole("radio")).toHaveCount(6);
  await expect(panel.getByRole("radiogroup", { name: L("editor.text.caption.size") })).toBeVisible();
  await expect(panel.getByRole("radiogroup", { name: L("editor.text.caption.position") })).toBeVisible();
  await expect(panel.getByRole("radiogroup", { name: L("editor.text.caption.highlight") })).toBeVisible();
  await expect(panel.getByRole("slider", { name: L("editor.text.caption.fineSize") })).toBeHidden();
  await expect(panel.getByRole("radiogroup", { name: L("editor.text.hook.design") })).toBeHidden();
});

test("a pack, a size, a position and the highlight are one command each; undo brings them back", async ({ page }) => {
  await openShell(page);
  const panel = await openPanel(page, "text");
  const before = await docOf(page);
  await pick(panel.getByRole("radiogroup", { name: L("editor.text.caption.style") }), new RegExp(`^${L("editor.text.packs.sorot")}`));
  await expect.poll(async () => (await docOf(page)).captions.pack.id).toBe("sorot");
  await pick(panel.getByRole("radiogroup", { name: L("editor.text.caption.size") }), L("editor.text.sizes.large"));
  await expect.poll(async () => (await docOf(page)).captions.overrides.size_pm).toBe(1200);
  await pick(panel.getByRole("radiogroup", { name: L("editor.text.caption.position") }), L("editor.text.positions.top"));
  await expect.poll(async () => (await docOf(page)).captions.overrides.y_e5).toBe(38000);
  await pick(panel.getByRole("radiogroup", { name: L("editor.text.caption.highlight") }), L("editor.text.colours.green"));
  await expect.poll(async () => (await docOf(page)).captions.overrides.highlight).toBe("#3DF5A6");
  for (let step = 0; step < 4; step += 1) await page.evaluate(() => window.__potonginEditor.store.undo());
  const after = await docOf(page);
  expect(after.captions.pack.id).toBe(before.captions.pack.id);
  expect(after.captions.overrides.size_pm).toBe(before.captions.overrides.size_pm);
});

test("a size off the three pills presses none, and the fine slider shows it", async ({ page }) => {
  await openShell(page);
  const panel = await openPanel(page, "text");
  await panel.locator('[data-advanced="caption"] button').first().click();
  const slider = panel.getByRole("slider", { name: L("editor.text.caption.fineSize") });
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  await expect(panel.getByRole("radiogroup", { name: L("editor.text.caption.size") }).getByRole("radio", { checked: true })).toHaveCount(0);
  await expect.poll(async () => (await docOf(page)).captions.overrides.size_pm).toBe(1050);
});

test("Tampilkan caption turns the caption off; the rest of the panel stays", async ({ page }) => {
  await openShell(page);
  const panel = await openPanel(page, "text");
  await panel.getByRole("switch", { name: L("editor.text.caption.show") }).click();
  await expect.poll(async () => (await docOf(page)).captions.enabled).toBe(false);
  await expect(panel.getByRole("radiogroup", { name: L("editor.text.caption.style") })).toBeVisible();
});

test("the caption over a face offers its one-click fix", async ({ page }) => {
  await openShell(page, "", { planWarnings: [{ code: "caption_over_face", ref: "tengah" }] });
  const panel = await openPanel(page, "text");
  await panel.getByRole("button", { name: L("editor.text.caption.moveTo", { place: L("editor.text.positions.middle") }), exact: true }).click();
  await expect.poll(async () => (await docOf(page)).captions.overrides.y_e5).toBe(60000);
});

test("the hook: text with its counter, and off and on again keeps the words", async ({ page }) => {
  await openShell(page);
  const panel = await openPanel(page, "text");
  const field = panel.getByRole("textbox", { name: L("editor.text.hook.text") });
  await field.fill("Hook baru dari saya");
  await expect.poll(async () => hookOf(await docOf(page))?.payload.text).toBe("Hook baru dari saya");
  await expect(panel.locator("[data-hook-counter]")).toHaveText("19/90");
  const toggle = panel.getByRole("switch", { name: L("editor.text.hook.show") });
  await toggle.click();
  await expect.poll(async () => hookOf(await docOf(page))).toBeNull();
  await expect(field).toHaveValue("Hook baru dari saya");
  await expect(panel.locator('[data-advanced="hook"]')).toHaveCount(0);
  await toggle.click();
  await expect.poll(async () => hookOf(await docOf(page))?.payload.text).toBe("Hook baru dari saya");
});

test("the suggestions ask the server only when opened; Pakai sets the hook", async ({ page }) => {
  await openShell(page);
  const panel = await openPanel(page, "text");
  const calls = () => page.evaluate(() => window.__potonginEditor.api.calls.filter((call) => call.name === "aiHooks").length);
  expect(await calls()).toBe(0);
  const toggle = panel.getByRole("button", { name: L("editor.text.hook.suggestions"), exact: true });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const use = panel.locator("[data-hook-suggestions] [data-suggestion] button").first();
  await use.click();
  expect(await calls()).toBe(1);
  await expect.poll(async () => hookOf(await docOf(page))?.origin ?? hookOf(await docOf(page))?.payload?.origin ?? "").toMatch(/suggestion/);
});

test("hook design, duration and position in Lanjutan", async ({ page }) => {
  await openShell(page);
  const panel = await openPanel(page, "text");
  await panel.locator('[data-advanced="hook"] button').first().click();
  await pick(panel.getByRole("radiogroup", { name: L("editor.text.hook.design") }), new RegExp(`^${L("editor.text.designs.blok")}`));
  await expect.poll(async () => hookOf(await docOf(page)).payload.design.id).toBe("blok");
  const position = panel.getByRole("slider", { name: L("editor.text.hook.position") });
  await position.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => hookOf(await docOf(page)).transform.y_e5).toBe(13500);
  const duration = panel.getByRole("slider", { name: L("editor.text.hook.duration") });
  await duration.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => hookOf(await docOf(page)).dur_f).toBe(121);
});

test("Edit per baris opens the transcript in Baris with focus in its first line", async ({ page }) => {
  await openShell(page);
  const panel = await openPanel(page, "text");
  await panel.getByRole("button", { name: L("editor.text.editLines"), exact: true }).click();
  const transcript = page.locator('[data-slot="transcript"]');
  await expect(transcript.locator('[data-transcript-mode="lines"]')).toBeVisible();
  await expect(transcript.getByRole("radio", { name: L("editor.transcript.modes.lines") })).toHaveAttribute("aria-checked", "true");
  await expect(transcript.locator("[data-line-input]").first()).toBeFocused();
});

test("Pakai caption di semua klip asks first, Batal returns focus, and the result carries Urungkan", async ({ page }) => {
  await openShell(page, "", { clips: 3 });
  const panel = await openPanel(page, "text");
  const button = panel.getByRole("button", { name: L("editor.applyAll.captions.button"), exact: true });
  await button.click();
  const dialog = page.getByRole("alertdialog", { name: L("editor.applyAll.captions.title") });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: L("editor.applyAll.cancel"), exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(button).toBeFocused();
  await button.click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await button.click();
  await dialog.getByRole("button", { name: L("editor.applyAll.confirm"), exact: true }).click();
  await expect(panel.locator("[data-apply-result]")).toBeVisible();
  await expect(panel.getByRole("button", { name: L("editor.applyAll.undo"), exact: true })).toBeVisible();
});

test("read-only: every caption and hook control is off, the jump to Baris still works", async ({ page }) => {
  await openShell(page, "", { readOnly: true });
  const panel = await openPanel(page, "text");
  await expect(panel.getByRole("switch", { name: L("editor.text.caption.show") })).toBeDisabled();
  await expect(panel.getByRole("textbox", { name: L("editor.text.hook.text") })).toBeDisabled();
  await expect(panel.getByRole("button", { name: L("editor.text.editLines"), exact: true })).toBeEnabled();
});
