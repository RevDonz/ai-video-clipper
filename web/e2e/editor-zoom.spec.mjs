// "Zoom" and the source's black bars (CONTRACTS §5.52) on the editor fakes: the Zoom slider in the
// Tata letak panel stores one SetZoom when it is let go (key or pointer), "Kembali ke 100%" drops
// it, one undo brings it back, the split has no Zoom and drops it, the Mode Cepat card names it;
// "Atur bingkai" draws a smaller box at the zoomed crop's row; a source with black bars says that
// they are left out; nothing scrolls sideways at the narrowest editor width (1024 px), the slider is a
// 44 px target; axe.
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

// ---------------------------------------------------------------------------------------------
// Browser-side scenario (serialised by addInitScript; self-contained). The still is a synthetic
// 720×1280 latar blur frame: the "source" band in the middle, with a bar every 10 % of its width.
function installScenario(config) {
  async function still() {
    const canvas = new OffscreenCanvas(720, 1280);
    const context = canvas.getContext("2d");
    context.fillStyle = "#222";
    context.fillRect(0, 0, 720, 1280);
    context.fillStyle = "#3a6";
    context.fillRect(0, 437, 720, 405);
    context.fillStyle = "#fff";
    for (let x = 0; x < 720; x += 72) context.fillRect(x, 437, 4, 405);
    return canvas.convertToBlob({ type: "image/png" });
  }

  window.__potonginEditorScenario = {
    api(api, fakes) {
      if (!config.layout && !config.zoom && !config.bars) return api;
      const doc = fakes.fakeDoc();
      if (config.layout) doc.layout.default.mode = config.layout;
      if (config.zoom) doc.layout.zoom_pm = config.zoom;
      if (config.bars) doc.base.source.content_rect = { x: 0, y: 90, w: doc.base.source.w, h: doc.base.source.h - 180 };
      return fakes.createFakeApiClient({ doc });
    },
    previewClient(client) {
      return { ...client, async frame() { return still(); } };
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

const layoutOf = (page) => page.evaluate(() => window.__potonginEditor.store.getState().doc.layout);

test("the Zoom slider stores one step per key, Kembali ke 100% drops it, one undo brings it back", async ({ page }) => {
  const panel = await openLayoutPanel(page);
  const section = panel.locator("[data-layout-zoom]");
  const slider = section.getByRole("slider", { name: "Zoom" });
  await expect(slider).toHaveAttribute("aria-valuetext", "100%");
  await expect(section.getByRole("button", { name: "Kembali ke 100%" })).toHaveCount(0);
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await layoutOf(page)).zoom_pm).toBe(1050);
  await page.keyboard.press("End");
  await expect.poll(async () => (await layoutOf(page)).zoom_pm).toBe(1500);
  await expect(slider).toHaveAttribute("aria-valuetext", "150%");
  await expect(section).toHaveAttribute("data-zoom-pm", "1500");
  await section.getByRole("button", { name: "Kembali ke 100%" }).click();
  await expect.poll(async () => Object.hasOwn(await layoutOf(page), "zoom_pm")).toBe(false);
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await layoutOf(page)).zoom_pm).toBe(1500);
});

test("a pointer drag on the slider stores the zoom once, when it is let go", async ({ page }) => {
  const panel = await openLayoutPanel(page);
  const slider = panel.locator("[data-layout-zoom-range]");
  const rect = await slider.boundingBox();
  expect(rect.height).toBeGreaterThanOrEqual(44);
  const y = rect.y + rect.height / 2;
  await page.mouse.move(rect.x + 4, y);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) await page.mouse.move(rect.x + 4 + ((rect.width / 2) * step) / 8, y);
  expect(Object.hasOwn(await layoutOf(page), "zoom_pm")).toBe(false); // nothing stored while dragging
  await page.mouse.up();
  await expect.poll(async () => (await layoutOf(page)).zoom_pm ?? 1000).toBeGreaterThan(1150);
  // the drag was one command: one undo is 100 % again
  await page.keyboard.press("Control+z");
  await expect.poll(async () => Object.hasOwn(await layoutOf(page), "zoom_pm")).toBe(false);
});

test("the split has no Zoom and drops it; the other layouts keep it", async ({ page }) => {
  const panel = await openLayoutPanel(page, { zoom: 1250 });
  const choose = (name) => panel.getByRole("group", { name: "Pilih tata letak" }).getByRole("radio", { name: new RegExp(`^${name}`) }).check();
  await choose("Potong tengah");
  await expect.poll(async () => (await layoutOf(page)).default.mode).toBe("fill_center");
  expect((await layoutOf(page)).zoom_pm).toBe(1250);
  await choose("Layar terbagi");
  await expect.poll(async () => (await layoutOf(page)).default.mode).toBe("split");
  expect(Object.hasOwn(await layoutOf(page), "zoom_pm")).toBe(false);
  await expect(panel.locator("[data-layout-zoom]")).toHaveCount(0);
});

test("Atur bingkai draws a smaller box at the zoomed crop's row", async ({ page }) => {
  const panel = await openLayoutPanel(page, { layout: "fill_center", zoom: 1500 });
  await panel.getByRole("button", { name: "Atur bingkai" }).click();
  const dialog = page.getByRole("dialog", { name: "Atur bingkai" });
  await expect(dialog).toBeVisible();
  const picture = await dialog.locator("[data-gizmo='frame']").boundingBox();
  const box = await dialog.getByRole("slider", { name: "Bingkai 9:16" }).boundingBox();
  // 1280×720 at 150 %: the crop is 1280/1920 of the picture's height, centred
  expect(box.height / picture.height).toBeCloseTo(1280 / 1920, 1);
  expect(box.y + box.height / 2 - (picture.y + picture.height / 2)).toBeLessThan(2);
  await page.keyboard.press("Escape");
});

test("a source with black bars says they are left out; Mode Cepat names the zoom", async ({ page }) => {
  const panel = await openLayoutPanel(page, { bars: true, zoom: 1250 });
  await expect(panel.locator("[data-layout-bars]")).toHaveText("Garis hitam di tepi video sumber sudah dibuang.");
  await page.goto(CEPAT);
  await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#card-layout-button")).toContainText("zoom 125%");
});

// The editor opens from 1024 px up (below it, EditorApp shows "Editor butuh layar minimal 1024
// px"), so the narrowest editor is the width to check.
test("at the narrowest editor width the Zoom section fits and nothing scrolls sideways", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const panel = await openLayoutPanel(page);
  const section = panel.locator("[data-layout-zoom]");
  await section.scrollIntoViewIfNeeded();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const rect = await section.locator("[data-layout-zoom-range]").boundingBox();
  expect(rect.height).toBeGreaterThanOrEqual(44);
});

test("QG-A11Y: axe finds no critical or serious violation in the layout panel with Zoom", async ({ page }) => {
  test.skip(!AXE, "axe-core is not a web dependency yet: set AXE_CORE_PATH to an axe.min.js");
  await openLayoutPanel(page, { zoom: 1250, bars: true });
  await page.addScriptTag({ content: AXE });
  const violations = await page.evaluate(async () => {
    const result = await window.axe.run(document.querySelector("[data-panel='layout']"), { resultTypes: ["violations"] });
    return result.violations.map((violation) => ({ id: violation.id, impact: violation.impact }));
  });
  expect(violations.filter((violation) => ["critical", "serious"].includes(violation.impact))).toEqual([]);
});
