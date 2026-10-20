// "Atur bingkai", the manual framing of the crop layouts (CONTRACTS §5.41), on the editor fakes:
// opened from the Tata letak panel (Mode Lengkap) and card (Mode Cepat); the source picture is a
// truth frame of the document with latar blur and nothing over it; a drag of the 9:16 box stores
// one keyframe at the playhead on release; keys nudge it; a second keyframe "Geser"; "Hapus
// keyframe" and "Kembali ke otomatis"; the lime diamonds on the dialog's scrubber and on the
// timeline; face-track waits for the first keyframe to show a result and drops its no-face choice;
// latar blur drops the keyframes; Escape, focus return, undo inside the dialog, and axe.
//
// The store is the real one (commands, undo, autosave) over the fake API and preview client.
// Prerequisites (as web/e2e/editor-layout.spec.mjs): a server with POTONGIN_EDITOR_V3=on and
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

// ---------------------------------------------------------------------------------------------
// Browser-side scenario (serialised by addInitScript; self-contained). The still is a synthetic
// 720×1280 latar blur frame: the "source" band in the middle, with a bar every 10 % of its width.
function installScenario(config) {
  const frames = [];
  window.__framingFrames = frames;

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
      const patch = { ...(config.layout ? { "layout.default.mode": config.layout } : {}),
        ...(config.layout === "camera" ? { "base.camera.sha256": "c".repeat(64) } : {}) };
      if (!Object.keys(patch).length) return api;
      const doc = fakes.fakeDoc();
      for (const [pathText, value] of Object.entries(patch)) {
        const keys = pathText.split(".");
        let target = doc;
        for (const key of keys.slice(0, -1)) target = target[key];
        target[keys.at(-1)] = value;
      }
      return fakes.createFakeApiClient({ doc });
    },
    previewClient(client) {
      return {
        ...client,
        async frame(doc, f) {
          frames.push({ layout: doc.layout.default.mode, keyframes: Object.hasOwn(doc.layout, "keyframes"),
            captions: doc.captions.enabled, tracks: doc.tracks.length, joins: doc.main.joins.length, f });
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

async function openFraming(page, config = { layout: "fill_center" }) {
  const panel = await openLayoutPanel(page, config);
  await panel.getByRole("button", { name: "Atur bingkai" }).click();
  const dialog = page.getByRole("dialog", { name: "Atur bingkai" });
  await expect(dialog).toBeVisible();
  return { panel, dialog, box: dialog.getByRole("slider", { name: "Bingkai 9:16" }) };
}

const layoutOf = (page) => page.evaluate(() => window.__potonginEditor.store.getState().doc.layout);
const playerFrame = (page) => page.evaluate(() => window.__potonginEditor.player.state().frame);

async function dragBox(page, box, dx) {
  const rect = await box.boundingBox();
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) await page.mouse.move(x + (dx * step) / 8, y);
  await page.mouse.up();
}

test("Atur bingkai opens from Tata letak on the source picture, the box on the layout's own framing", async ({ page }) => {
  const { panel, dialog, box } = await openFraming(page);
  await expect(panel.locator("[data-layout-framing]")).toContainText("Otomatis: bingkai di tengah.");
  await expect(box).toBeFocused();
  await expect(box).toHaveAttribute("aria-valuenow", "50");
  await expect(box).toHaveAttribute("data-auto", "true");
  await expect(dialog.locator("[data-gizmo='frame']")).toHaveAttribute("data-still", "ready");
  // the still is the document with latar blur and nothing over it, at the playhead
  const [first] = await page.evaluate(() => window.__framingFrames);
  expect(first).toEqual({ layout: "fit_blur", keyframes: false, captions: false, tracks: 0, joins: 0, f: await playerFrame(page) });
  await expect(dialog.locator("[data-framing-result]")).toHaveAttribute("role", "img");
  await expect(dialog.getByRole("button", { name: "Kembali ke otomatis" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Hapus keyframe" })).toBeDisabled();
  // nothing scrolls sideways
  const overflow = await dialog.evaluate((node) => node.scrollWidth - node.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("a drag stores one keyframe at the playhead on release; the diamonds follow", async ({ page }) => {
  const { dialog, box } = await openFraming(page);
  const before = await page.evaluate(() => window.__potonginEditor.store.getState().canUndo);
  await dragBox(page, box, -120);
  await expect.poll(async () => (await layoutOf(page)).keyframes?.length ?? 0).toBe(1);
  const [keyframe] = (await layoutOf(page)).keyframes;
  expect(keyframe.move).toBe("cut");
  expect(keyframe.pan_e5).toBeLessThan(50000);
  await expect(box).toHaveAttribute("data-auto", "false");
  await expect(dialog.locator("[data-keyframe-mark]")).toHaveCount(1);
  await expect(dialog.locator("[data-keyframe-mark][data-here]")).toHaveCount(1);
  expect(before).toBe(false);
  // one undo step for the whole drag, Ctrl+Z works inside the dialog
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await layoutOf(page)).keyframes ?? null).toBe(null);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(async () => (await layoutOf(page)).keyframes?.length ?? 0).toBe(1);
});

test("keys nudge; a second keyframe slides; Hapus keyframe and Kembali ke otomatis", async ({ page }) => {
  const { dialog, box } = await openFraming(page);
  await box.focus();
  for (let i = 0; i < 3; i += 1) await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await layoutOf(page)).keyframes?.[0]?.pan_e5).toBe(53000);
  await page.keyboard.press("Shift+ArrowLeft");
  await expect.poll(async () => (await layoutOf(page)).keyframes?.[0]?.pan_e5).toBe(43000);
  await expect(box).toHaveAttribute("aria-valuenow", "43");
  // the first keyframe has no move to choose
  await expect(dialog.getByRole("radio", { name: "Geser" })).toBeDisabled();
  // another frame: the box shows the held framing; Tambah keyframe stores it there
  const scrub = dialog.getByRole("slider", { name: "Posisi" });
  await scrub.fill("200");
  await expect.poll(() => playerFrame(page)).toBe(200);
  await dialog.getByRole("button", { name: "Tambah keyframe" }).click();
  await expect.poll(async () => (await layoutOf(page)).keyframes?.length).toBe(2);
  await box.focus();
  await page.keyboard.press("End");
  await expect.poll(async () => (await layoutOf(page)).keyframes?.[1]?.pan_e5).toBe(100000);
  await dialog.getByRole("radio", { name: "Geser" }).check();
  await expect.poll(async () => (await layoutOf(page)).keyframes?.[1]?.move).toBe("slide");
  await expect(dialog.locator("[data-keyframe-mark]")).toHaveCount(2);
  // between the two the box moves on its own (the slide), and the previous keyframe is one click away
  await scrub.fill("120");
  const between = Number(await box.getAttribute("aria-valuenow"));
  expect(between).toBeGreaterThan(43);
  expect(between).toBeLessThan(100);
  await dialog.getByRole("button", { name: "Keyframe sebelumnya" }).click();
  await expect(box).toHaveAttribute("aria-valuenow", "43");
  await dialog.getByRole("button", { name: "Hapus keyframe" }).click();
  await expect.poll(async () => (await layoutOf(page)).keyframes?.length).toBe(1);
  await dialog.getByRole("button", { name: "Kembali ke otomatis" }).click();
  await expect.poll(async () => Object.hasOwn(await layoutOf(page), "keyframes")).toBe(false);
  await expect(box).toHaveAttribute("data-auto", "true");
});

test("Selesai closes and gives focus back; the timeline shows a lime diamond per keyframe", async ({ page }) => {
  const { panel, dialog, box } = await openFraming(page);
  await box.focus();
  await page.keyboard.press("PageUp");
  await expect.poll(async () => (await layoutOf(page)).keyframes?.length ?? 0).toBe(1);
  await dialog.getByRole("button", { name: "Selesai" }).click();
  await expect(dialog).toBeHidden();
  await expect(panel.getByRole("button", { name: "Atur bingkai" })).toBeFocused();
  await expect(panel.locator("[data-layout-framing]")).toContainText("Diatur manual: 1 keyframe.");
  const marks = page.locator('[data-lane="video"] [data-keyframe-mark]');
  await expect(marks).toHaveCount(1);
  const colour = await marks.first().evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(colour).toBe("rgb(223, 255, 88)"); // --accent
  // Escape closes too; "Kembali ke otomatis" is in the panel as well
  await panel.getByRole("button", { name: "Atur bingkai" }).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await panel.getByRole("button", { name: "Kembali ke otomatis" }).click();
  await expect.poll(async () => Object.hasOwn(await layoutOf(page), "keyframes")).toBe(false);
  await expect(marks).toHaveCount(0);
});

test("face-track: the result waits for the first keyframe, then the no-face choice gives way", async ({ page }) => {
  const { panel, dialog, box } = await openFraming(page, { layout: "camera" });
  await expect(panel.locator("[data-layout-framing]")).toContainText("Otomatis: bingkai mengikuti wajah.");
  await expect(dialog.locator("[data-framing-result]")).toContainText("Mengikuti wajah");
  await box.focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => (await layoutOf(page)).keyframes?.length ?? 0).toBe(1);
  await expect(dialog.locator("[data-framing-result]")).toHaveAttribute("role", "img");
  await dialog.getByRole("button", { name: "Selesai" }).click();
  await expect(panel.locator("[data-layout-noface]")).toHaveCount(0);
  await expect(panel.locator("[data-layout-framing]")).toContainText("juga di bagian tanpa wajah");
});

test("latar blur has no framing and drops the keyframes; one undo brings them back", async ({ page }) => {
  const { panel, dialog, box } = await openFraming(page);
  await box.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await layoutOf(page)).keyframes?.length ?? 0).toBe(1);
  await dialog.getByRole("button", { name: "Selesai" }).click();
  await panel.getByRole("group", { name: "Pilih tata letak" }).getByRole("radio", { name: /^Latar blur/ }).check();
  await expect.poll(async () => (await layoutOf(page)).default.mode).toBe("fit_blur");
  expect(Object.hasOwn(await layoutOf(page), "keyframes")).toBe(false);
  await expect(panel.locator("[data-layout-framing]")).toContainText("Pilih Ikuti wajah atau Potong tengah");
  await expect(panel.getByRole("button", { name: "Atur bingkai" })).toHaveCount(0);
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await layoutOf(page)).keyframes?.length ?? 0).toBe(1);
});

test("Mode Cepat's Tata letak card opens the same dialog under a crop layout only", async ({ page }) => {
  await openEditor(page, {}, "cepat");
  let card = await openCard(page, "layout");
  await expect(card.getByRole("button", { name: "Atur bingkai" })).toHaveCount(0);
  await card.getByRole("radio", { name: "Potong tengah" }).check();
  card = await openCard(page, "layout");
  await card.getByRole("button", { name: "Atur bingkai" }).click();
  const dialog = page.getByRole("dialog", { name: "Atur bingkai" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => (await layoutOf(page)).keyframes?.length ?? 0).toBe(1);
  await page.keyboard.press("Escape");
  await expect(page.locator("#card-layout-button")).toContainText("Potong tengah · bingkai manual");
});

test("QG-A11Y: axe finds no critical or serious violation in the framing dialog", async ({ page }) => {
  test.skip(!AXE, "axe-core is not a web dependency yet: set AXE_CORE_PATH to an axe.min.js");
  const { dialog } = await openFraming(page);
  await page.keyboard.press("ArrowRight");
  await expect(dialog.locator("[data-keyframe-mark]")).toHaveCount(1);
  await page.addScriptTag({ content: AXE });
  const violations = await page.evaluate(async () => {
    const result = await window.axe.run(document.querySelector("[data-framing-dialog]"), { resultTypes: ["violations"] });
    return result.violations.map((violation) => ({ id: violation.id, impact: violation.impact }));
  });
  expect(violations.filter((violation) => ["critical", "serious"].includes(violation.impact))).toEqual([]);
});
