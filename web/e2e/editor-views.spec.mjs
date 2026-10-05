// The editor's two views (docs/plans/2026-10-02-editor-mode-cepat.md §1, §4, §9.4) on the editor
// fakes. Z0 seeds this file with the scaffold's checks: the default URL is today's Lengkap layout,
// and ?mode=cepat mounts the cards, the scrubber and the same stage. Task A owns the file and
// replaces the default-URL check when it flips the default to Cepat (AC1).
//
// Prerequisites: a server with POTONGIN_EDITOR_V3=on and POTONGIN_EDITOR_FAKES=1,
// E2E_USERNAME/E2E_PASSWORD, E2E_EDITOR_FAKES=1; AXE_CORE_PATH=<axe.min.js> for the axe check.
// On GitHub Actions: gh workflow run editor-gates.yml -f ref=<branch> -f suite=e2e \
//   -f command='e2e/editor-views.spec.mjs'
import { expect, test as base } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { FAKE_CLIP_ID, FAKE_JOB_ID } from "../components/editor/__dev__/fakes.mjs";
import { openCard } from "./support/editor-cards.mjs";
import { login, settings } from "./support/harness.mjs";

const BASE = `/projects/${FAKE_JOB_ID}/clips/${FAKE_CLIP_ID}/edit`;
const CARD_LABELS = ["Hook", "Caption", "Teks caption", "Cold open", "Tata letak", "Logo & Musik"];
const PANEL_TABS = ["Transkrip", "Teks", "Cold open", "Tata letak", "Logo", "Musik"];

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

const chrome = process.env.EDITOR_CHROME || process.env.PARITY_CHROME || defaultChrome();
const AXE = axeSource();

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
  viewport: { width: 1366, height: 650 },
  deviceScaleFactor: 1,
});
test.skip(process.env.E2E_EDITOR_FAKES !== "1",
  "E2E_EDITOR_FAKES=1 is required (server with POTONGIN_EDITOR_V3=on and POTONGIN_EDITOR_FAKES=1)");
test.skip(!settings.username || !settings.password, "E2E_USERNAME and E2E_PASSWORD are required");

async function openEditor(page, target) {
  await page.goto(target);
  await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 30_000 });
}

const root = (page) => page.locator("[data-editor-root]");
const cards = (page) => page.getByRole("complementary", { name: "Pengaturan klip" });
const header = (page, id) => cards(page).locator(`#card-${id}-button`);

test("the default URL opens today's Lengkap layout: tabs, panel and timeline, no cards", async ({ page }) => {
  await openEditor(page, BASE);
  await expect(root(page)).toHaveAttribute("data-editor-view", "lengkap");
  const tabs = page.getByRole("tablist", { name: "Panel editor" }).getByRole("tab");
  await expect(tabs).toHaveText(PANEL_TABS);
  await expect(page.getByRole("tab", { name: "Transkrip" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-panel="transcript"]')).toBeVisible();
  await expect(page.locator('[data-slot="timeline"]')).toBeVisible();
  await expect(page.locator('[data-slot="cards"]')).toHaveCount(0);
  await expect(page.getByRole("slider", { name: "Posisi putar" })).toHaveCount(0);
});

test("the tabs keep their keys: ←/→ move and select, Home and End go to the ends", async ({ page }) => {
  await openEditor(page, `${BASE}?mode=lengkap`);
  await page.getByRole("tab", { name: "Transkrip" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Teks" })).toBeFocused();
  await expect(page.getByRole("tab", { name: "Teks" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(page.getByRole("tab", { name: "Musik" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Transkrip" })).toBeFocused();
});

test("?mode=cepat mounts the six cards with Caption open, the scrubber, and no tabs or timeline", async ({ page }) => {
  await openEditor(page, `${BASE}?mode=cepat`);
  await expect(root(page)).toHaveAttribute("data-editor-view", "cepat");
  await expect(page.getByRole("tablist")).toHaveCount(0);
  await expect(page.locator('[data-slot="timeline"]')).toHaveCount(0);
  const headers = cards(page).getByRole("heading", { level: 2 }).getByRole("button");
  await expect(headers).toHaveCount(CARD_LABELS.length);
  for (const [index, label] of CARD_LABELS.entries()) await expect(headers.nth(index)).toContainText(label);
  await expect(header(page, "caption")).toHaveAttribute("aria-expanded", "true");
  await expect(cards(page).locator('[aria-expanded="true"]')).toHaveCount(1);
  // Closed bodies are inert and hidden; the open one is a region named by its header.
  await expect(page.locator("#card-hook-region")).toHaveAttribute("inert", "");
  await expect(page.locator("#card-hook-region")).toBeHidden();
  await expect(page.getByRole("region", { name: "Caption", exact: true })).toBeVisible();
  // Teks caption sums up the plan's cues (the fakes group the 12 words in fours).
  await expect(header(page, "lines")).toContainText("3 baris");
  await expect(page.getByRole("slider", { name: "Posisi putar" })).toBeVisible();
});

test("one card open at a time: opening another closes Caption, and the open header closes its card", async ({ page }) => {
  await openEditor(page, `${BASE}?mode=cepat`);
  const lines = await openCard(page, "lines");
  await expect(lines).toBeVisible();
  await expect(header(page, "caption")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#card-caption-region")).toHaveAttribute("inert", "");
  await header(page, "lines").click();
  await expect(cards(page).locator('[aria-expanded="true"]')).toHaveCount(0);
});

test("the scrubber seeks the player and follows the playhead", async ({ page }) => {
  await openEditor(page, `${BASE}?mode=cepat`);
  const slider = page.getByRole("slider", { name: "Posisi putar" });
  await slider.fill("45");
  await expect.poll(() => page.evaluate(() => window.__potonginEditor.player.frame())).toBe(45);
  await page.evaluate(() => window.__potonginEditor.player.seek(120));
  await expect(slider).toHaveValue("120");
  await expect(slider).toHaveAttribute("aria-valuetext", /^00:04,0 dari \d\d:\d\d,\d$/);
});

test("a card's way to Mode Lengkap keeps the stage, the player and the undo history", async ({ page }) => {
  await openEditor(page, `${BASE}?mode=cepat`);
  await page.evaluate(() => window.__potonginEditor.store.dispatch("SetCaptionsEnabled", { on: false }));
  const before = await page.evaluate(() => {
    document.querySelector('[data-stage="canvas"]').dataset.probe = "same";
    return window.__potonginEditor.store.getState().canUndo;
  });
  expect(before).toBe(true);
  await page.locator("#card-caption-region").getByRole("button", { name: "Atur di Mode Lengkap" }).click();
  await expect(root(page)).toHaveAttribute("data-editor-view", "lengkap");
  await expect(page.getByRole("tab", { name: "Teks" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-stage="canvas"][data-probe="same"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Urungkan" }).click();
  expect(await page.evaluate(() => window.__potonginEditor.store.getState().doc.captions.enabled)).toBe(true);
  await expect(page.locator('[data-editor-ready="true"]')).toBeVisible();
});

test("the bottom bar's link opens the transcript in Mode Lengkap", async ({ page }) => {
  await openEditor(page, `${BASE}?mode=cepat`);
  await page.getByRole("button", { name: "Potong per kata di Mode Lengkap →" }).click();
  await expect(page.getByRole("tab", { name: "Transkrip" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-panel="transcript"]')).toBeVisible();
});

test("QG-A11Y: axe finds no critical or serious violation in the Cepat scaffold", async ({ page }) => {
  test.skip(!AXE, "axe-core is not a web dependency: set AXE_CORE_PATH to an axe.min.js");
  await openEditor(page, `${BASE}?mode=cepat`);
  await page.addScriptTag({ content: AXE });
  const blocking = await page.evaluate(async () => {
    const result = await window.axe.run(document, { resultTypes: ["violations"] });
    return result.violations.filter((item) => ["critical", "serious"].includes(item.impact))
      .map((item) => ({ id: item.id, impact: item.impact, targets: item.nodes.slice(0, 3).map((node) => node.target.join(" ")) }));
  });
  expect(blocking).toEqual([]);
});
