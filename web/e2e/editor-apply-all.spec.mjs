// "Pakai di semua klip" in the editor (CONTRACTS §5.48) on the editor fakes: the button under
// Caption, Logo and Tata letak in both views; the clip is saved before the batch; the result
// "Dipakai di n klip · k dilewati" with the skipped clips and Urungkan; the result stays across a
// view switch; a lost answer shows an error and the retry reuses the batch; a project with one clip
// shows no button; 44 px targets and keyboard use.
//
// Prerequisites: a server with POTONGIN_EDITOR_V3=on and POTONGIN_EDITOR_FAKES=1,
// E2E_USERNAME/E2E_PASSWORD, E2E_EDITOR_FAKES=1.
// On GitHub Actions: gh workflow run editor-gates.yml -f ref=<branch> -f suite=e2e \
//   -f command='e2e/editor-apply-all.spec.mjs'
import { expect, test as base } from "@playwright/test";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { FAKE_CLIP_ID, FAKE_JOB_ID, FAKE_OTHER_CLIPS } from "../components/editor/__dev__/fakes.mjs";
import { openCard } from "./support/editor-cards.mjs";
import { switchView } from "./support/editor-topbar.mjs";
import { login, settings } from "./support/harness.mjs";

const editorPath = `/projects/${FAKE_JOB_ID}/clips/${FAKE_CLIP_ID}/edit`;
const LOG_KEY = "__applyAllLog";
const FOUR_CLIPS = [FAKE_CLIP_ID, ...FAKE_OTHER_CLIPS].map((clipId, at) => ({ clipId, index: at + 1, title: `Klip nomor ${at + 1}` }));

function defaultChrome() {
  const candidate = path.join(os.homedir(), ".cache", "ms-playwright", "chromium-1217", "chrome-linux64", "chrome");
  return existsSync(candidate) ? candidate : undefined;
}
const chrome = process.env.EDITOR_CHROME || process.env.PARITY_CHROME || defaultChrome();

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
      if (reason !== "net::ERR_ABORTED") failures.requests.push(`${request.method()} ${request.url()} ${reason}`);
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
  viewport: { width: 1366, height: 768 },
  deviceScaleFactor: 1,
});
test.skip(process.env.E2E_EDITOR_FAKES !== "1",
  "E2E_EDITOR_FAKES=1 is required (server with POTONGIN_EDITOR_V3=on and POTONGIN_EDITOR_FAKES=1)");
test.skip(!settings.username || !settings.password, "E2E_USERNAME and E2E_PASSWORD are required");

// Browser side (serialised by addInitScript). `clips` replaces the listing; `failFirst` makes the
// first batch request fail like a lost connection. Every flush, batch and undo is logged in order.
function installScenario(config) {
  const log = (entry) => {
    const list = JSON.parse(window.sessionStorage.getItem(config.logKey) || "[]");
    list.push(entry);
    window.sessionStorage.setItem(config.logKey, JSON.stringify(list));
  };
  let failures = config.failFirst ? 1 : 0;
  window.__potonginEditorScenario = {
    api(api) {
      return {
        ...api,
        async clips() {
          const [model] = (await api.clips()).clips;
          return { clips: (config.clips ?? [model]).map((clip) => ({ ...model, ...clip })) };
        },
        async applyToAll(body, key) {
          log({ call: "apply", group: body.group, etag: body.etag, key });
          if (failures > 0) {
            failures -= 1;
            throw Object.assign(new Error("network"), { status: 0, code: "network_error" });
          }
          return api.applyToAll(body, key);
        },
        async undoApplyAll(batchId) {
          log({ call: "undo", batchId });
          return api.undoApplyAll(batchId);
        },
      };
    },
    store(store) {
      return {
        ...store,
        async flush() {
          const etag = await store.flush();
          log({ call: "flush", etag });
          return etag;
        },
      };
    },
  };
}

async function openEditor(page, query, { clips = FOUR_CLIPS, failFirst = false } = {}) {
  await page.addInitScript(installScenario, { clips, failFirst, logKey: LOG_KEY });
  await page.goto(`${editorPath}${query}`);
  await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 30_000 });
}

const callLog = (page) => page.evaluate((key) => JSON.parse(window.sessionStorage.getItem(key) || "[]"), LOG_KEY);
const block = (page, group) => page.locator(`[data-apply-all="${group}"]`);

test("Caption card: the clip is saved, one batch runs, the result names the skipped clip and Urungkan undoes it", async ({ page }) => {
  await openEditor(page, "?mode=cepat");
  const card = await openCard(page, "caption");
  const button = card.getByRole("button", { name: "Pakai caption di semua klip" });
  await expect(button).toBeVisible();
  await expect(card.getByText("Klip yang caption-nya sudah diubah tidak ikut.")).toBeVisible();
  const box = await button.boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(44);
  await button.click();
  const result = block(page, "captions").locator("[data-apply-result]");
  await expect(result).toContainText("Dipakai di 2 klip · 1 dilewati");
  await result.getByText("Lihat yang dilewati").click();
  await expect(result).toContainText("Klip 3: sudah diubah manual");
  const log = await callLog(page);
  expect(log.map((entry) => entry.call)).toEqual(["flush", "apply"]);
  expect(log[1]).toMatchObject({ group: "captions", etag: log[0].etag });
  await result.getByRole("button", { name: "Urungkan" }).click();
  await expect(result).toContainText("Dikembalikan di 2 klip");
  await expect(result.getByRole("button", { name: "Urungkan" })).toHaveCount(0);
  expect((await callLog(page)).at(-1)).toEqual({ call: "undo", batchId: log[1].key });
});

test("the result stays when the view switches, and Lengkap's Teks panel shows the same button", async ({ page }) => {
  await openEditor(page, "?mode=cepat");
  const card = await openCard(page, "caption");
  await card.getByRole("button", { name: "Pakai caption di semua klip" }).click();
  await expect(block(page, "captions").locator("[data-apply-result]")).toContainText("Dipakai di 2 klip");
  await switchView(page, "lengkap");
  await page.locator("#editor-tab-text").click();
  const panel = page.locator('[data-panel="text"]');
  await expect(panel.getByRole("button", { name: "Pakai caption di semua klip" })).toBeVisible();
  await expect(panel.locator("[data-apply-result]")).toContainText("Dipakai di 2 klip · 1 dilewati");
});

test("Logo and Tata letak have their own button in both views, each sending its group", async ({ page }) => {
  await openEditor(page, "?mode=cepat");
  const extras = await openCard(page, "extras");
  await extras.getByRole("button", { name: "Pakai logo di semua klip" }).click();
  await expect(block(page, "logo").locator("[data-apply-result]")).toContainText("Dipakai di 2 klip");
  const layout = await openCard(page, "layout");
  await layout.getByRole("button", { name: "Pakai tata letak di semua klip" }).click();
  await expect(block(page, "layout").locator("[data-apply-result]")).toContainText("Dipakai di 2 klip");
  expect((await callLog(page)).filter((entry) => entry.call === "apply").map((entry) => entry.group)).toEqual(["logo", "layout"]);
  await switchView(page, "lengkap");
  await page.locator("#editor-tab-logo").click();
  await expect(page.locator('[data-panel="logo"]').getByRole("button", { name: "Pakai logo di semua klip" })).toBeVisible();
  await page.locator("#editor-tab-layout").click();
  await expect(page.locator('[data-panel="layout"]').getByRole("button", { name: "Pakai tata letak di semua klip" })).toBeVisible();
});

test("a lost answer shows an error; the retry with the keyboard sends the same batch id", async ({ page }) => {
  await openEditor(page, "?mode=cepat", { failFirst: true });
  const card = await openCard(page, "caption");
  const button = card.getByRole("button", { name: "Pakai caption di semua klip" });
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(card.getByRole("alert")).toHaveText("Gagal menerapkan; coba lagi");
  expect(await button.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
  await page.keyboard.press("Enter");
  await expect(block(page, "captions").locator("[data-apply-result]")).toContainText("Dipakai di 2 klip");
  const applies = (await callLog(page)).filter((entry) => entry.call === "apply");
  expect(applies).toHaveLength(2);
  expect(applies[1].key).toBe(applies[0].key);
});

test("a project with one clip shows no button", async ({ page }) => {
  await openEditor(page, "?mode=cepat", { clips: null });
  const card = await openCard(page, "caption");
  await expect(card.locator('[data-quick-body="caption"]')).toBeVisible();
  await expect(page.locator("[data-apply-all]")).toHaveCount(0);
});
