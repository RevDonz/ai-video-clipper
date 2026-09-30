// Hook suggestions in the Teks panel (plan §7.1 "UI", T3.4), against the fake runtime: the
// instant cards with their source labels and fit badges, "Pakai" as one undoable command, the AI
// task polled every second, its failure, rate-limit and off states, the keyboard, and reduced
// motion. The fake API's aiHooks/aiTask are replaced per test through window.__potonginEditorScenario.
//
// Prerequisites (as web/e2e/editor-shell.spec.mjs): a server with POTONGIN_EDITOR_V3=on and
// POTONGIN_EDITOR_FAKES=1, E2E_EDITOR_FAKES=1, E2E_USERNAME/E2E_PASSWORD; optional AXE_CORE_PATH.
import { expect, test as base } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { FAKE_CLIP_ID, FAKE_JOB_ID } from "../components/editor/__dev__/fakes.mjs";
import { login, settings } from "./support/harness.mjs";

const EDITOR = `/projects/${FAKE_JOB_ID}/clips/${FAKE_CLIP_ID}/edit`;
const TASK_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

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

const INSTANT = [
  { id: "hk_1", text: "Kenapa sutradara ditahan di film sendiri?", source: "ai_selection", kind: "v3_hook", fits: true, style: null, evidence: [], basis: null },
  { id: "hk_2", text: "Sutradara ditahan security di pintu masuk", source: "ai_selection", kind: "v3_title", fits: true, style: null, evidence: [], basis: null },
  { id: "hk_3", text: "Jadi waktu itu kita datang subuh dan langsung ditahan di depan pintu masuk belakang", source: "heuristic", kind: "hook_unit", fits: false, style: null, evidence: [], basis: null },
];
const AI = [
  { id: "ai_7c9e66790", text: "Sutradara nggak bisa masuk ke film sendiri", source: "llm", kind: "llm", fits: true, style: "klaim", evidence: ["L0001"], basis: "Kenapa sutradara ditahan di film sendiri?" },
  { id: "ai_7c9e66791", text: "Kenapa security nahan sutradaranya?", source: "llm", kind: "llm", fits: true, style: "pertanyaan", evidence: ["L0001"], basis: "Kenapa sutradara ditahan di film sendiri?" },
];

// Browser side (serialised by addInitScript): aiHooks/aiTask follow `config`, every call is kept.
function installScenario(config) {
  const calls = [];
  window.__aiCalls = calls;
  const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  let hooksCalls = 0;
  window.__potonginEditorScenario = {
    api(api) {
      return {
        ...api,
        async aiHooks(doc) {
          hooksCalls += 1;
          calls.push({ name: "aiHooks", at: performance.now(), hook: doc.tracks?.[0]?.items?.[0]?.payload?.text ?? null });
          if (config.hooksDelayMs) await wait(config.hooksDelayMs);
          if (config.hooksFailOnce && hooksCalls === 1) throw Object.assign(new Error("offline"), { status: 0, code: "network_error" });
          const answer = typeof config.answers?.[hooksCalls - 1] === "object" ? config.answers[hooksCalls - 1] : config.answer;
          return JSON.parse(JSON.stringify(answer));
        },
        async aiTask(taskId) {
          calls.push({ name: "aiTask", at: performance.now(), taskId });
          const polls = calls.filter((call) => call.name === "aiTask").length;
          if (polls < (config.pendingPolls ?? 2)) return { state: "pending", suggestions: [], error: null };
          return JSON.parse(JSON.stringify(config.task));
        },
      };
    },
  };
}

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
    const failures = [];
    page.on("console", (message) => { if (message.type() === "error") failures.push(message.text()); });
    page.on("pageerror", (error) => failures.push(error.stack || error.message));
    await use(page);
    if (failures.length && testInfo.status === testInfo.expectedStatus) throw new Error(`Browser diagnostics:\n${failures.join("\n")}`);
  },
});

test.use({ launchOptions: chrome ? { executablePath: chrome } : {}, viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 });
test.skip(process.env.E2E_EDITOR_FAKES !== "1",
  "E2E_EDITOR_FAKES=1 is required (server with POTONGIN_EDITOR_V3=on and POTONGIN_EDITOR_FAKES=1)");
test.skip(!settings.username || !settings.password, "E2E_USERNAME and E2E_PASSWORD are required");

async function openText(page, config) {
  await page.addInitScript(installScenario, config);
  await page.goto(EDITOR);
  await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 30_000 });
  await page.getByRole("tab", { name: "Teks" }).click();
  await expect(page.locator("[data-hook-suggestions]")).toBeVisible();
}

const calls = (page) => page.evaluate(() => window.__aiCalls);
const commands = (page) => page.evaluate(() => window.__potonginEditor.store.getState().commands ?? []);
const hookField = (page) => page.getByRole("textbox", { name: "Teks hook" });
const instantList = (page) => page.getByRole("list", { name: "Saran otomatis" });
const aiList = (page) => page.getByRole("list", { name: "Saran AI" });

test("instant cards come at once with their source labels and fit badges; 'Pakai' is one undoable command", async ({ page }) => {
  await openText(page, { answer: { taskId: null, heuristic: INSTANT, llm: { state: "disabled" } } });
  const cards = instantList(page).getByRole("listitem");
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0).locator("[data-source-label]")).toHaveText("AI seleksi");
  await expect(cards.nth(2).locator("[data-source-label]")).toHaveText("Heuristik");
  await expect(cards.nth(2).locator('[data-fit="overflow"]')).toHaveText("Akan terpotong");
  await expect(cards.nth(1).locator('[data-fit="fits"]')).toHaveText("Muat");
  // The seed's hook is hk_1's text: that card is the one in use.
  await expect(cards.nth(0).getByRole("button")).toHaveText("Dipakai");
  await expect(cards.nth(0).getByRole("button")).toBeDisabled();

  await cards.nth(1).getByRole("button", { name: `Pakai hook: ${INSTANT[1].text}` }).click();
  await expect(hookField(page)).toHaveValue(INSTANT[1].text);
  await expect(cards.nth(1).getByRole("button")).toHaveText("Dipakai");
  await expect(cards.nth(0).getByRole("button")).toHaveText("Pakai");
  const applied = (await commands(page)).filter((command) => command.type === "SetHookText");
  expect(applied).toEqual([{ type: "SetHookText", args: { text: INSTANT[1].text, origin: "suggestion:hk_2" }, mergeKey: null }]);

  await page.keyboard.press("Control+z");
  await expect(hookField(page)).toHaveValue(INSTANT[0].text);
  await expect(cards.nth(0).getByRole("button")).toHaveText("Dipakai");
  // With the LLM off nothing about AI shows: no status, no privacy note, no AI list.
  await expect(page.locator("[data-ai-status]")).toHaveCount(0);
  await expect(page.getByText(/penyedia AI/)).toHaveCount(0);
  expect((await calls(page)).filter((call) => call.name === "aiHooks")).toHaveLength(1);
});

test("the AI task is polled every second; its cards arrive labelled 'AI' with the transcript line they rest on", async ({ page }) => {
  await openText(page, {
    answer: { taskId: TASK_ID, heuristic: INSTANT, llm: { state: "pending" } }, pendingPolls: 3,
    task: { state: "done", suggestions: AI, error: null },
  });
  await expect(page.locator('[data-ai-status="pending"]')).toContainText("AI sedang menulis saran dari transkrip klip ini");
  await expect(page.getByText("Teks transkrip klip ini dikirim ke penyedia AI yang aktif di Pengaturan.")).toBeVisible();
  await expect(aiList(page).getByRole("listitem")).toHaveCount(2, { timeout: 10_000 });
  const first = aiList(page).getByRole("listitem").first();
  await expect(first.locator("[data-source-label]")).toHaveText("AI");
  await expect(first).toContainText("klaim");
  await expect(first).toContainText(`Dari transkrip: “${AI[0].basis}”`);
  await expect(page.locator('[data-ai-status="done"]')).toBeVisible();
  const polls = (await calls(page)).filter((call) => call.name === "aiTask");
  expect(polls.map((call) => call.taskId)).toEqual(Array(polls.length).fill(TASK_ID));
  expect(polls.length).toBe(3);
  for (let index = 1; index < polls.length; index += 1) {
    const gap = polls[index].at - polls[index - 1].at;
    expect(gap).toBeGreaterThan(800);
    expect(gap).toBeLessThan(2500);
  }
  await first.getByRole("button", { name: `Pakai hook: ${AI[0].text}` }).click();
  await expect(hookField(page)).toHaveValue(AI[0].text);
  const applied = (await commands(page)).filter((command) => command.type === "SetHookText");
  expect(applied.at(-1).args).toEqual({ text: AI[0].text, origin: "suggestion:ai_7c9e66790" });
});

test("a failed AI task says so plainly, keeps the instant cards and 'Coba lagi' asks again", async ({ page }) => {
  await openText(page, {
    answers: [{ taskId: TASK_ID, heuristic: INSTANT, llm: { state: "pending" } }, { taskId: null, heuristic: INSTANT, llm: { state: "disabled" } }],
    pendingPolls: 1, task: { state: "failed", suggestions: [], error: { code: "llm_unavailable", messageId: "editor_ai.llm_unavailable" } },
  });
  const notice = page.locator("[data-ai-notice]");
  await expect(notice).toContainText("Saran AI belum tersedia (kuota/koneksi); memakai saran otomatis.", { timeout: 10_000 });
  await expect(instantList(page).getByRole("listitem")).toHaveCount(3);
  await notice.getByRole("button", { name: "Coba lagi" }).click();
  await expect(page.locator("[data-ai-status]")).toHaveCount(0);
  expect((await calls(page)).filter((call) => call.name === "aiHooks")).toHaveLength(2);
});

test("the hourly limit and an unreadable settings file are explained; the instant cards stay", async ({ page }) => {
  await openText(page, { answer: { taskId: null, heuristic: INSTANT, llm: { state: "rate_limited", retryAfterMs: 125_000 } } });
  await expect(page.locator("[data-ai-notice]")).toHaveText("Batas saran AI untuk proyek ini sudah tercapai (30 per jam). Coba lagi dalam 3 menit.");
  await expect(instantList(page).getByRole("listitem")).toHaveCount(3);
});

test("the settings notice replaces the AI part when the saved settings cannot be read", async ({ page }) => {
  const message = "Pengaturan AI tidak bisa dibaca; saran AI dimatikan dan saran otomatis dipakai.";
  await openText(page, { answer: { taskId: null, heuristic: INSTANT, llm: { state: "disabled", message } } });
  await expect(page.locator("[data-ai-notice]")).toHaveText(message);
  await expect(page.getByText(/penyedia AI yang aktif/)).toHaveCount(0);
});

test("switching panels keeps the cards and the running task; no second request", async ({ page }) => {
  await openText(page, {
    answer: { taskId: TASK_ID, heuristic: INSTANT, llm: { state: "pending" } }, pendingPolls: 4,
    task: { state: "done", suggestions: AI, error: null },
  });
  await expect(instantList(page).getByRole("listitem")).toHaveCount(3);
  await page.getByRole("tab", { name: "Transkrip" }).click();
  await page.getByRole("tab", { name: "Teks" }).click();
  await expect(aiList(page).getByRole("listitem")).toHaveCount(2, { timeout: 10_000 });
  expect((await calls(page)).filter((call) => call.name === "aiHooks")).toHaveLength(1);
});

test("a failed first request offers 'Coba lagi'; loading shows what is loading", async ({ page }) => {
  await openText(page, { hooksFailOnce: true, hooksDelayMs: 400, answer: { taskId: null, heuristic: INSTANT, llm: { state: "disabled" } } });
  await expect(page.getByRole("alert").filter({ hasText: "Saran hook belum bisa dimuat." })).toBeVisible();
  await page.locator("[data-hook-suggestions]").getByRole("button", { name: "Coba lagi" }).click();
  await expect(page.locator("[data-hook-suggestions]").getByRole("status")).toContainText("Mencari saran hook…");
  await expect(instantList(page).getByRole("listitem")).toHaveCount(3);
});

test("keyboard: Tab reaches 'Pakai' with a visible focus ring and Enter applies it", async ({ page }) => {
  await openText(page, { answer: { taskId: null, heuristic: INSTANT, llm: { state: "disabled" } } });
  await expect(instantList(page).getByRole("listitem")).toHaveCount(3);
  // From the hook field, Tab skips the card in use (disabled) and lands on the next "Pakai".
  await hookField(page).focus();
  await page.keyboard.press("Tab");
  const button = instantList(page).getByRole("listitem").nth(1).getByRole("button");
  await expect(button).toBeFocused();
  const ring = await button.evaluate((element) => getComputedStyle(element).boxShadow);
  expect(ring).not.toBe("none");
  await page.keyboard.press("Enter");
  await expect(hookField(page)).toHaveValue(INSTANT[1].text);
});

test("no version label anywhere in the Teks panel", async ({ page }) => {
  await openText(page, {
    answer: { taskId: TASK_ID, heuristic: INSTANT, llm: { state: "pending" } }, pendingPolls: 1,
    task: { state: "done", suggestions: AI, error: null },
  });
  await expect(aiList(page).getByRole("listitem")).toHaveCount(2, { timeout: 10_000 });
  const text = await page.locator('[data-panel="text"]').innerText();
  expect(text).not.toMatch(/\bV[0-9]\b|versi [0-9]|mesin (?:lama|baru)|—/i);
});

test.describe("reduced motion", () => {
  test("cards appear without animation and the progress bar is hidden", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openText(page, { answer: { taskId: TASK_ID, heuristic: INSTANT, llm: { state: "pending" } }, pendingPolls: 50, task: { state: "pending" } });
    const card = instantList(page).getByRole("listitem").first();
    await expect(card).toBeVisible();
    expect(await card.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
    await expect(page.locator('[data-ai-status="pending"]')).toBeVisible();
    await expect(page.locator('[data-ai-status="pending"] [aria-hidden="true"]')).toBeHidden();
  });
});

test("QG-A11Y: axe finds no critical or serious violation in the Teks panel with suggestions", async ({ page }) => {
  test.skip(!AXE, "axe-core is not a web dependency: set AXE_CORE_PATH to an axe.min.js");
  await openText(page, {
    answer: { taskId: TASK_ID, heuristic: INSTANT, llm: { state: "pending" } }, pendingPolls: 1,
    task: { state: "done", suggestions: AI, error: null },
  });
  await expect(aiList(page).getByRole("listitem")).toHaveCount(2, { timeout: 10_000 });
  await page.addScriptTag({ content: AXE });
  const result = await page.evaluate(async () => window.axe.run(document.querySelector('[data-panel="text"]'),
    { resultTypes: ["violations"] }));
  const serious = result.violations.filter((violation) => ["critical", "serious"].includes(violation.impact));
  expect(serious.map((violation) => `${violation.id}: ${violation.nodes.length}`)).toEqual([]);
});
