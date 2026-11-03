// Tab Tata letak and "Lihat sumber" of the one-layout editor (rombak 06 §8.2, §5.2, Editor F4a):
// the layout cards, the no-face choice, the split's share and swap, the fine controls, and the
// source view over the stage in place of the old shell's two dialogs: the gizmos, the keyframe
// tools, its ways back and its focus. Otomatis comes with RF-M5a (Fase 7).
//
// On GitHub Actions: gh workflow run editor-gates.yml -f ref=<branch> -f suite=e2e \
//   -f command='e2e/editor-layout-tab.spec.mjs'
import { openPanel, panelRegion, panelTab } from "./support/editor-panels.mjs";
import { expect, openTabs as openShell, playButton, test, useShellDefaults } from "./support/editor-shell.mjs";
import { L } from "./support/i18n.mjs";
import { shellDoc } from "./support/shell-docs.mjs";

useShellDefaults();

const docOf = (page) => page.evaluate(() => window.__potonginEditor.store.getState().doc);
const stage = (page) => page.locator('[data-slot="stage"]');
const showSource = (page) => stage(page).getByRole("button", { name: L("editor.stage.source.show"), exact: true });
const backButton = (page) => stage(page).getByRole("button", { name: L("editor.stage.source.back"), exact: true });
const sourceStage = (page) => page.locator("[data-source-stage]");
const layoutCards = (panel) => panel.getByRole("radiogroup", { name: L("editor.layout.choose") });

test("four layout cards with their names, and no Otomatis yet", async ({ page }) => {
  await openShell(page);
  const panel = await openPanel(page, "layout");
  await expect(layoutCards(panel).getByRole("radio")).toHaveCount(4);
  await expect(layoutCards(panel).locator('[data-option="auto"]')).toHaveCount(0);
  await expect(panel.getByText(L("editor.layout.wholeClip"))).toBeVisible();
});

test("Potong tengah switches at once; Lihat sumber shows only for a layout that allows it", async ({ page }) => {
  await openShell(page);
  await openPanel(page, "layout");
  await expect(showSource(page)).toHaveCount(0);
  const panel = panelRegion(page).getByRole("tabpanel");
  await layoutCards(panel).getByRole("radio", { name: new RegExp(`^${L("editor.layout.names.fillCenter")}`) }).check();
  await expect.poll(async () => (await docOf(page)).layout.default.mode).toBe("fill_center");
  await expect(showSource(page)).toBeVisible();
  await panelTab(page, "text").click();
  await expect(showSource(page)).toHaveCount(0);
});

test("Ikuti wajah runs the analysis first, then shows the no-face choice", async ({ page }) => {
  await openShell(page, "?panel=layout");
  const panel = panelRegion(page).getByRole("tabpanel");
  await layoutCards(panel).getByRole("radio", { name: new RegExp(`^${L("editor.layout.names.camera")}`) }).check();
  await expect.poll(async () => (await docOf(page)).layout.default.mode).toBe("camera");
  const noFace = panel.getByRole("radiogroup", { name: L("editor.layout.noFace.title") });
  await expect(noFace).toBeVisible();
  await noFace.getByRole("radio", { name: L("editor.layout.noFace.centre"), exact: true }).check();
  await expect.poll(async () => (await docOf(page)).layout.default.no_face).toBe("center");
});

test("the analysis's failure says so and Coba lagi runs it again (row 56)", async ({ page }) => {
  await page.addInitScript(() => {
    let failures = 1;
    window.__potonginLayoutTabScenario = { fail: () => (failures > 0 ? (failures -= 1, true) : false) };
  });
  await openShell(page, "?panel=layout");
  await page.evaluate(() => {
    const { api } = window.__potonginEditor;
    const inner = api.prepare;
    api.prepare = async (options) => {
      if (window.__potonginLayoutTabScenario.fail()) {
        throw Object.assign(new Error("failed"), { code: "internal_error" });
      }
      return inner.call(api, options);
    };
  });
  const panel = panelRegion(page).getByRole("tabpanel");
  await layoutCards(panel).getByRole("radio", { name: new RegExp(`^${L("editor.layout.names.camera")}`) }).check();
  const error = panel.locator("[data-layout-analysis-error]");
  await expect(error).toBeVisible();
  await error.getByRole("button", { name: L("editor.layout.analysis.retry"), exact: true }).click();
  await expect.poll(async () => (await docOf(page)).layout.default.mode).toBe("camera");
});

test("no-face runs from the plan are jump targets", async ({ page }) => {
  await openShell(page, "?panel=layout", { doc: shellDoc("camera"), planWarnings: [{ code: "no_face_blur", f: 30 }] });
  const panel = panelRegion(page).getByRole("tabpanel");
  await panel.locator('[data-layout-noface] ul button').click();
  await expect.poll(() => page.evaluate(() => window.__potonginEditor.player.frame?.() ?? window.__potonginEditor.player.state()?.frame)).toBe(30);
});

test("zoom is in Lanjutan, stored once on release, and Kembali ke 100% clears it", async ({ page }) => {
  await openShell(page, "?panel=layout");
  const panel = panelRegion(page).getByRole("tabpanel");
  await panel.locator('[data-advanced="camera"] button').first().click();
  const zoom = panel.getByRole("slider", { name: L("editor.layout.zoom") });
  await zoom.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await docOf(page)).layout.zoom_pm).toBe(1050);
  await panel.getByRole("button", { name: L("editor.layout.zoomReset"), exact: true }).click();
  await expect.poll(async () => (await docOf(page)).layout.zoom_pm ?? 1000).toBe(1000);
});

test("the split: share, swap, and each band's zoom in Lanjutan with its summary", async ({ page }) => {
  await openShell(page, "?panel=layout", { doc: shellDoc("split") });
  const panel = panelRegion(page).getByRole("tabpanel");
  const share = panel.getByRole("radiogroup", { name: L("editor.layout.split.share") });
  await share.getByRole("radio", { name: "50/50", exact: true }).check();
  await expect.poll(async () => (await docOf(page)).layout.split.top_pm).toBe(500);
  await share.getByRole("radio", { name: "30/70", exact: true }).check();
  await panel.getByRole("button", { name: L("editor.layout.split.swap"), exact: true }).click();
  await expect.poll(async () => (await docOf(page)).layout.split.top_pm).toBe(700);
  await panel.locator('[data-advanced="split"] button').first().click();
  const top = panel.getByRole("slider", { name: L("editor.layout.split.zoomTop") });
  await top.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await docOf(page)).layout.split.top.zoom_pm).toBe(1010);
  await expect(panel.locator('[data-advanced="split"] [data-advanced-summary]'))
    .toContainText(L("editor.layout.summary.bands", { top: 101, bottom: 100 }));
});

test("Lihat sumber: the frame gizmo over the stage, focus on the box, a key stores a keyframe, the old dialog is gone", async ({ page }) => {
  await openShell(page, "?panel=layout", { doc: shellDoc("fillCenter") });
  await expect(page.locator("[data-framing-dialog]")).toHaveCount(0);
  await showSource(page).click();
  const box = sourceStage(page).getByRole("slider");
  await expect(box).toBeFocused();
  await expect(page.locator("[data-stage-live]")).toHaveText(L("editor.stage.source.liveSource"));
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await docOf(page)).layout.keyframes?.length ?? 0).toBe(1);
  await page.evaluate(() => window.__potonginEditor.store.undo());
  await expect.poll(async () => (await docOf(page)).layout.keyframes?.length ?? 0).toBe(0);
});

test("Lihat sumber: a drag stores one keyframe; the keyframe tools work from the tab", async ({ page }) => {
  await openShell(page, "?panel=layout", { doc: shellDoc("fillCenter") });
  await showSource(page).click();
  const gizmo = sourceStage(page).locator('[data-gizmo="frame"]');
  await expect(gizmo).toHaveAttribute("data-still", "ready");
  const box = await sourceStage(page).locator("[data-frame-box]").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await docOf(page)).layout.keyframes?.length ?? 0).toBe(1);
  const tools = panelRegion(page).locator("[data-keyframe-tools]");
  await expect(tools).toBeVisible();
  await tools.getByRole("button", { name: L("editor.layout.keyframe.remove"), exact: true }).click();
  await expect.poll(async () => (await docOf(page)).layout.keyframes?.length ?? 0).toBe(0);
  await tools.getByRole("button", { name: L("editor.layout.keyframe.add"), exact: true }).click();
  await expect.poll(async () => (await docOf(page)).layout.keyframes?.length ?? 0).toBe(1);
});

test("Kembali ke hasil, Esc, another tab and Putar all go back; focus returns to Lihat sumber", async ({ page }) => {
  await openShell(page, "?panel=layout", { doc: shellDoc("fillCenter") });
  await showSource(page).click();
  await backButton(page).click();
  await expect(sourceStage(page)).toHaveCount(0);
  await expect(showSource(page)).toBeFocused();
  await expect(page.locator("[data-stage-live]")).toHaveText(L("editor.stage.source.liveResult"));

  await showSource(page).click();
  await page.keyboard.press("Escape");
  await expect(sourceStage(page)).toHaveCount(0);
  await expect(showSource(page)).toBeFocused();

  await showSource(page).click();
  await panelTab(page, "audio").click();
  await expect(sourceStage(page)).toHaveCount(0);

  await openPanel(page, "layout");
  await showSource(page).click();
  await playButton(page).click();
  await expect(sourceStage(page)).toHaveCount(0);
  await expect(playButton(page, { playing: true })).toBeVisible();
});

test("a layout that does not allow it closes the source (latar blur, an undo)", async ({ page }) => {
  await openShell(page, "?panel=layout", { doc: shellDoc("fillCenter") });
  await showSource(page).click();
  const panel = panelRegion(page).getByRole("tabpanel");
  await layoutCards(panel).getByRole("radio", { name: new RegExp(`^${L("editor.layout.names.fitBlur")}`) }).check();
  await expect(sourceStage(page)).toHaveCount(0);
  await expect(showSource(page)).toHaveCount(0);
});

test("Lihat sumber on the split: two boxes, the small band focused, a key moves it; the old dialog is gone", async ({ page }) => {
  await openShell(page, "?panel=layout", { doc: shellDoc("split") });
  await expect(page.locator("[data-split-dialog]")).toHaveCount(0);
  await showSource(page).click();
  const top = sourceStage(page).locator('[data-split-box="top"]');
  await expect(top).toBeFocused();
  await expect(sourceStage(page).locator('[data-split-box="bottom"]')).toBeVisible();
  await expect(sourceStage(page).locator("[data-split-result]")).toBeVisible();
  const before = (await docOf(page)).layout.split.top.x_e5;
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await docOf(page)).layout.split.top.x_e5).not.toBe(before);
});

test("read-only: the source opens, the box holds still", async ({ page }) => {
  await openShell(page, "?panel=layout", { doc: shellDoc("fillCenter"), readOnly: true });
  await showSource(page).click();
  const box = sourceStage(page).getByRole("slider");
  await expect(box).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("ArrowRight");
  expect((await docOf(page)).layout.keyframes?.length ?? 0).toBe(0);
});

test("at 1366×768 the source view fits inside the stage with no page scroll", async ({ page }) => {
  await openShell(page, "?panel=layout", { doc: shellDoc("fillCenter") });
  await showSource(page).click();
  const stageBox = await page.locator('[data-slot="stage"]').boundingBox();
  const picture = await sourceStage(page).locator('[data-gizmo="frame"]').boundingBox();
  expect(picture.width).toBeGreaterThan(200);
  expect(picture.y + picture.height).toBeLessThanOrEqual(stageBox.y + stageBox.height + 1);
  expect(await page.evaluate(() => document.scrollingElement.scrollHeight <= window.innerHeight)).toBe(true);
});
