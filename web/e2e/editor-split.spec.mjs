// Layar terbagi (CONTRACTS §5.45) on the editor fakes: chosen from the Tata letak panel (Mode
// Lengkap) and card (Mode Cepat) with its default bands; "Pembagian" 30/70 and 50/50 and "Tukar atas
// dan bawah"; "Atur layar terbagi" over the source picture (a truth frame of the document with
// latar blur and nothing over it): a drag of a box stores one crop on release, keys move and zoom
// it, a corner resizes it, the zoom slider stores when let go; the result shows both bands and the
// line; Escape, focus return, undo inside the dialog, leaving the split drops the bands; and axe.
//
// The store is the real one (commands, undo, autosave) over the fake API and preview client.
// Prerequisites (as web/e2e/editor-framing.spec.mjs): a server with POTONGIN_EDITOR_V3=on and
// POTONGIN_EDITOR_FAKES=1, E2E_EDITOR_FAKES=1 to run this file, E2E_USERNAME/E2E_PASSWORD; optional
// AXE_CORE_PATH=<axe.min.js>. EDITOR_CHROME overrides the Chrome for Testing build.
import { expect, test as base } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { FAKE_CLIP_ID, FAKE_JOB_ID } from "../components/editor/__dev__/fakes.mjs";
import { openCard } from "./support/editor-cards.mjs";
import { login, settings } from "./support/harness.mjs";

const EDITOR = `/projects/${FAKE_JOB_ID}/clips/${FAKE_CLIP_ID}/edit?mode=lengkap`;
const CEPAT = EDITOR.replace("mode=lengkap", "mode=cepat");

function defaultChrome() {
  const candidate = path.join(os.homedir(), ".cache", "ms-playwright", "chromium-1217", "chrome-linux64", "chrome");
  return existsSync(candidate) ? candidate : undefined;
}

function axeSource() {
  const explicit = process.env.AXE_CORE_PATH;
  if (explicit && existsSync(explicit)) return readFileSync(explicit, "utf8");
  try {
    return readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
  } catch {
    return null;
  }
}

const chrome = process.env.EDITOR_CHROME || defaultChrome();
const AXE = axeSource();
const DEFAULT_BANDS = { top_pm: 300, top: { x_e5: 50000, y_e5: 50000, zoom_pm: 1000 }, bottom: { x_e5: 50000, y_e5: 50000, zoom_pm: 1000 } };

// ---------------------------------------------------------------------------------------------
// Browser-side scenario (serialised by addInitScript; self-contained). The still is a synthetic
// 720×1280 latar blur frame: the "source" band in the middle, with a bar every 10 % of its width.
function installScenario(config) {
  const frames = [];
  window.__splitFrames = frames;

  async function still(f) {
    const canvas = new OffscreenCanvas(720, 1280);
    const context = canvas.getContext("2d");
    context.fillStyle = "#222";
    context.fillRect(0, 0, 720, 1280);
    context.fillStyle = "#3a6";
    context.fillRect(0, 437, 720, 405);
    context.fillStyle = "#fff";
    for (let x = 0; x < 720; x += 72) context.fillRect(x, 437, 4, 405);
    context.fillRect(0, 830, Math.min(720, 2 + f), 12);
    return canvas.convertToBlob({ type: "image/png" });
  }

  window.__potonginEditorScenario = {
    api(api, fakes) {
      if (!config.split) return api;
      const doc = fakes.fakeDoc();
      doc.layout = { default: { ...doc.layout.default, mode: "split" }, split: config.split };
      return fakes.createFakeApiClient({ doc });
    },
    previewClient(client) {
      return {
        ...client,
        async frame(doc, f) {
          frames.push({ layout: doc.layout.default.mode, split: Object.hasOwn(doc.layout, "split"),
            captions: doc.captions.enabled, tracks: doc.tracks.length, f });
          return still(f);
        },
      };
    },
    store(store, fakes, parts) {
      store.ready?.catch?.(() => {});
      store.destroy();
      return fakes.createRealEditorStore({ ...parts });
    },
  };
}

// ---------------------------------------------------------------------------------------------

const test = base.extend({
  workerStorageState: [async ({ browser }, use) => {
    const context = await browser.newContext({ baseURL: settings.baseURL });
    const page = await context.newPage();
    await login(page, "/projects");
    const state = await context.storageState();
    await context.close();
    await use(state);
  }, { scope: "worker" }],
  storageState: ({ workerStorageState }, use) => use(workerStorageState),
  page: async ({ page }, use, testInfo) => {
    const failures = { console: [], page: [], requests: [] };
    page.on("console", (message) => { if (message.type() === "error") failures.console.push(message.text()); });
    page.on("pageerror", (error) => failures.page.push(error.stack || error.message));
    page.on("requestfailed", (request) => {
      const reason = request.failure()?.errorText || "failed";
      const benign = reason === "net::ERR_ABORTED" && ["media", "other", "document"].includes(request.resourceType());
      if (!benign) failures.requests.push(`${request.method()} ${request.url()} ${reason}`);
    });
    // the fake runtime makes no API call: any request to the editor routes is a bug
    page.on("request", (request) => {
      if (/\/api\/jobs\/[^/]+\/clips\//.test(request.url())) failures.requests.push(`unexpected ${request.method()} ${request.url()}`);
    });
    await use(page);
    const count = Object.values(failures).reduce((total, list) => total + list.length, 0);
    if (count) {
      if (testInfo.status === testInfo.expectedStatus) throw new Error(`Browser diagnostics:\n${JSON.stringify(failures, null, 2)}`);
      process.stderr.write(`Browser diagnostics for ${testInfo.title}:\n${JSON.stringify(failures, null, 2)}\n`);
    }
  },
});

test.use({
  launchOptions: chrome ? { executablePath: chrome } : {},
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
});
test.skip(process.env.E2E_EDITOR_FAKES !== "1",
  "E2E_EDITOR_FAKES=1 is required (server with POTONGIN_EDITOR_V3=on and POTONGIN_EDITOR_FAKES=1)");
test.skip(!settings.username || !settings.password, "E2E_USERNAME and E2E_PASSWORD are required");

async function openEditor(page, config = {}, view = "lengkap") {
  await page.addInitScript(installScenario, config);
  await page.goto(view === "cepat" ? CEPAT : EDITOR);
  await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 30_000 });
}

async function openLayoutPanel(page, config) {
  await openEditor(page, config);
  await page.getByRole("tab", { name: "Tata letak" }).click();
  const panel = page.locator('[data-panel="layout"]');
  await expect(panel).toBeVisible();
  return panel;
}

async function openSplit(page, config = { split: DEFAULT_BANDS }) {
  const panel = await openLayoutPanel(page, config);
  await panel.getByRole("button", { name: "Atur potongan" }).click();
  const dialog = page.getByRole("dialog", { name: "Atur layar terbagi" });
  await expect(dialog).toBeVisible();
  return { panel, dialog, top: dialog.locator("[data-split-box='top']"), bottom: dialog.locator("[data-split-box='bottom']") };
}

const layoutOf = (page) => page.evaluate(() => window.__potonginEditor.store.getState().doc.layout);
const playerFrame = (page) => page.evaluate(() => window.__potonginEditor.player.state().frame);

async function drag(page, locator, dx, dy) {
  const rect = await locator.boundingBox();
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) await page.mouse.move(x + (dx * step) / 8, y + (dy * step) / 8);
  await page.mouse.up();
}

test("Layar terbagi is a fourth layout: the default bands, the share, and no Bingkai", async ({ page }) => {
  const panel = await openLayoutPanel(page);
  await expect(panel.locator("[data-layout-option]")).toHaveCount(4);
  await panel.getByRole("group", { name: "Pilih tata letak" }).getByRole("radio", { name: /^Layar terbagi/ }).check();
  await expect.poll(async () => (await layoutOf(page)).default.mode).toBe("split");
  expect((await layoutOf(page)).split).toEqual(DEFAULT_BANDS);
  const section = panel.locator("[data-layout-split]");
  await expect(section).toContainText("Atas 30%, bawah 70%.");
  await expect(panel.locator("[data-layout-framing]")).toHaveCount(0);
  await section.getByRole("radio", { name: "50/50" }).check();
  await expect.poll(async () => (await layoutOf(page)).split.top_pm).toBe(500);
  await expect(section).toContainText("Atas 50%, bawah 50%.");
  // nothing scrolls sideways in the panel with four cards
  const overflow = await panel.evaluate((node) => node.scrollWidth - node.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("Tukar atas dan bawah moves the small band with its picture; one undo brings it back", async ({ page }) => {
  const split = { ...DEFAULT_BANDS, top: { x_e5: 100000, y_e5: 0, zoom_pm: 3000 } };
  const panel = await openLayoutPanel(page, { split });
  await panel.getByRole("button", { name: "Tukar atas dan bawah" }).click();
  await expect.poll(async () => (await layoutOf(page)).split.top_pm).toBe(700);
  expect((await layoutOf(page)).split.bottom).toEqual(split.top);
  await expect(panel.locator("[data-layout-split]")).toContainText("Atas 70%, bawah 30%.");
  // 30/70 keeps the swapped order
  await expect(panel.locator("[data-layout-split]").getByRole("radio", { name: "30/70" })).toBeChecked();
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await layoutOf(page)).split.top_pm).toBe(300);
});

test("Atur layar terbagi opens on the source picture with a box per band and the result", async ({ page }) => {
  const { dialog, top, bottom } = await openSplit(page);
  await expect(top).toBeFocused();
  await expect(top).toHaveAttribute("data-active", "true");
  await expect(bottom).toHaveAttribute("data-active", "false");
  await expect(dialog.locator("[data-gizmo='split']")).toHaveAttribute("data-still", "ready");
  const [first] = await page.evaluate(() => window.__splitFrames);
  expect(first).toEqual({ layout: "fit_blur", split: false, captions: false, tracks: 0, f: await playerFrame(page) });
  const result = dialog.locator("[data-split-result]");
  await expect(result).toHaveAttribute("role", "img");
  await expect(result.locator("[data-split-band]")).toHaveCount(2);
  // the top band takes 30 % of the result's height
  const [frameBox, topBox] = await Promise.all([result.boundingBox(), result.locator("[data-split-band='top']").boundingBox()]);
  expect(Math.abs(topBox.height / frameBox.height - 0.3)).toBeLessThan(0.01);
  const overflow = await dialog.evaluate((node) => node.scrollWidth - node.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("a drag stores one crop on release; Ctrl+Z inside the dialog undoes it", async ({ page }) => {
  const split = { ...DEFAULT_BANDS, top: { x_e5: 50000, y_e5: 50000, zoom_pm: 2500 } };
  const { top } = await openSplit(page, { split });
  await drag(page, top, -150, -60);
  await expect.poll(async () => (await layoutOf(page)).split.top.x_e5).toBeLessThan(50000);
  const after = (await layoutOf(page)).split.top;
  expect(after.y_e5).toBeLessThan(50000);
  expect(after.zoom_pm).toBe(2500);
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await layoutOf(page)).split.top).toEqual(split.top);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(async () => (await layoutOf(page)).split.top).toEqual(after);
});

test("keys move and zoom the focused box; a corner resizes it; the slider stores when let go", async ({ page }) => {
  const split = { ...DEFAULT_BANDS, bottom: { x_e5: 50000, y_e5: 50000, zoom_pm: 2000 } };
  const { dialog, bottom } = await openSplit(page, { split });
  await bottom.focus();
  await expect(bottom).toHaveAttribute("data-active", "true");
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await layoutOf(page)).split.bottom.x_e5).toBe(51000);
  await page.keyboard.press("Shift+ArrowUp");
  await expect.poll(async () => (await layoutOf(page)).split.bottom.y_e5).toBe(40000);
  await page.keyboard.press("Equal"); // "=" is the + key without Shift
  await expect.poll(async () => (await layoutOf(page)).split.bottom.zoom_pm).toBe(2100);
  // the south-east corner pulled outwards makes the box bigger: a lower zoom
  await drag(page, bottom.locator("[data-corner='se']"), 120, 120);
  await expect.poll(async () => (await layoutOf(page)).split.bottom.zoom_pm).toBeLessThan(2100);
  // the zoom slider of the band being edited
  const zoom = dialog.getByRole("slider", { name: "Perbesar bawah" });
  const before = (await layoutOf(page)).split.bottom.zoom_pm;
  await zoom.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await layoutOf(page)).split.bottom.zoom_pm).toBe(before + 10);
  // "Potongan" picks the other band
  await dialog.getByRole("radio", { name: "Atas" }).check();
  await expect(dialog.locator("[data-split-box='top']")).toHaveAttribute("data-active", "true");
  await expect(dialog.getByRole("slider", { name: "Perbesar atas" })).toBeVisible();
});

test("Selesai closes and gives focus back; Escape closes too", async ({ page }) => {
  const { panel, dialog } = await openSplit(page);
  await dialog.getByRole("button", { name: "Selesai" }).click();
  await expect(dialog).toBeHidden();
  await expect(panel.getByRole("button", { name: "Atur potongan" })).toBeFocused();
  await panel.getByRole("button", { name: "Atur potongan" }).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("leaving the split drops the bands; one undo brings them back", async ({ page }) => {
  const split = { ...DEFAULT_BANDS, top_pm: 500 };
  const panel = await openLayoutPanel(page, { split });
  await panel.getByRole("group", { name: "Pilih tata letak" }).getByRole("radio", { name: /^Potong tengah/ }).check();
  await expect.poll(async () => (await layoutOf(page)).default.mode).toBe("fill_center");
  expect(Object.hasOwn(await layoutOf(page), "split")).toBe(false);
  await expect(panel.locator("[data-layout-split]")).toHaveCount(0);
  await expect(panel.locator("[data-layout-framing]")).toBeVisible();
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await layoutOf(page)).split?.top_pm ?? null).toBe(500);
});

test("Mode Cepat's Tata letak card chooses the split and opens the same dialog", async ({ page }) => {
  await openEditor(page, {}, "cepat");
  let card = await openCard(page, "layout");
  await expect(card.getByRole("button", { name: "Atur potongan" })).toHaveCount(0);
  await card.getByRole("radio", { name: "Layar terbagi" }).check();
  await expect.poll(async () => (await layoutOf(page)).default.mode).toBe("split");
  card = await openCard(page, "layout");
  await expect(card.locator("[data-quick-split]")).toContainText("Atas 30%, bawah 70%.");
  await card.getByRole("button", { name: "Atur potongan" }).click();
  const dialog = page.getByRole("dialog", { name: "Atur layar terbagi" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => (await layoutOf(page)).split.top.x_e5).toBe(49000);
  await page.keyboard.press("Escape");
  await expect(page.locator("#card-layout-button")).toContainText("Layar terbagi · 30/70");
});

test("QG-A11Y: axe finds no critical or serious violation in the split dialog", async ({ page }) => {
  test.skip(!AXE, "axe-core is not a web dependency yet: set AXE_CORE_PATH to an axe.min.js");
  const { dialog } = await openSplit(page);
  await expect(dialog.locator("[data-gizmo='split']")).toHaveAttribute("data-still", "ready");
  await page.addScriptTag({ content: AXE });
  const violations = await page.evaluate(async () => {
    const result = await window.axe.run(document.querySelector("[data-split-dialog]"), { resultTypes: ["violations"] });
    return result.violations.map((violation) => ({ id: violation.id, impact: violation.impact }));
  });
  expect(violations.filter((violation) => ["critical", "serious"].includes(violation.impact))).toEqual([]);
});
