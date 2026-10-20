// Cek ejaan on the editor fakes: the review in the transcript panel (Mode Lengkap) and in the Teks
// caption card (Mode Cepat), its AI task polled every second, "Terima" as word edits with one
// Urungkan, "Lewati" and "Tampilkan lagi", "Terima semua" as one undo step, the failure, limit and
// settings states, the keyboard after a row leaves, reduced motion and axe. The page runs the real
// store over a fake API whose clip carries three typos as word edits; aiSpelling/aiTask follow the
// test's script (window.__potonginEditorScenario).
//
// Prerequisites (as web/e2e/editor-ai.spec.mjs): a server with POTONGIN_EDITOR_V3=on and
// POTONGIN_EDITOR_FAKES=1, E2E_EDITOR_FAKES=1, E2E_USERNAME/E2E_PASSWORD; optional AXE_CORE_PATH.
// On GitHub Actions: gh workflow run editor-gates.yml -f ref=<branch> -f suite=e2e \
//   -f command='e2e/editor-spelling.spec.mjs'
import { expect, test as base } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { FAKE_CLIP_ID, FAKE_JOB_ID, fakeWords } from "../components/editor/__dev__/fakes.mjs";
import { openCard } from "./support/editor-cards.mjs";
import { switchView } from "./support/editor-topbar.mjs";
import { login, settings } from "./support/harness.mjs";

const LENGKAP = `/projects/${FAKE_JOB_ID}/clips/${FAKE_CLIP_ID}/edit?mode=lengkap`;
const CEPAT = `/projects/${FAKE_JOB_ID}/clips/${FAKE_CLIP_ID}/edit?mode=cepat`;
const TASK_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const ID = fakeWords().words.map((word) => word.id); // ID[4] "film", ID[6] "Jadi", ID[11] "subuh"
// The clip as the ASR wrote it: three words misspelt.
const TYPOS = Object.freeze({ [ID[4]]: { text: "flim" }, [ID[6]]: { text: "jadi" }, [ID[11]]: { text: "subu" } });
const SUGGESTIONS = [
  { id: "sp_7c9e66790", wordIds: [ID[4]], from: "flim", to: "film", kind: "spelling" },
  { id: "sp_7c9e66791", wordIds: [ID[6]], from: "jadi", to: "Jadi", kind: "case" },
  { id: "sp_7c9e66792", wordIds: [ID[11]], from: "subu", to: "subuh", kind: "spelling" },
];
const DONE = Object.freeze({ start: { taskId: TASK_ID, llm: { state: "pending" } }, task: { state: "done", suggestions: SUGGESTIONS, error: null, truncated: false } });

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

// Browser side (serialised by addInitScript): the fake API serves the clip with `config.edits`,
// aiSpelling/aiTask follow `config`, every call is kept; the store is the real one.
function installScenario(config) {
  const calls = [];
  window.__spellingCalls = calls;
  let starts = 0;
  let polls = 0;
  window.__potonginEditorScenario = {
    api(_api, fakes) {
      const doc = fakes.fakeDoc();
      doc.captions.word_edits = JSON.parse(JSON.stringify(config.edits));
      const api = fakes.createFakeApiClient({ doc });
      return {
        ...api,
        async aiSpelling(spellDoc) {
          starts += 1;
          calls.push({ name: "aiSpelling", at: performance.now(), edits: spellDoc.captions.word_edits });
          const answer = Array.isArray(config.starts) ? config.starts[Math.min(starts, config.starts.length) - 1] : config.start;
          return JSON.parse(JSON.stringify(answer));
        },
        async aiTask(taskId) {
          if (taskId !== config.start?.taskId && !(config.starts ?? []).some((answer) => answer.taskId === taskId)) return api.aiTask(taskId);
          polls += 1;
          calls.push({ name: "aiTask", at: performance.now(), taskId });
          if (polls < (config.pendingPolls ?? 2)) return { state: "pending", suggestions: [], error: null };
          return JSON.parse(JSON.stringify(config.task));
        },
      };
    },
    store(store, fakes, parts) {
      store.destroy();
      return fakes.createRealEditorStore({ ...parts, autosave: { debounceMs: 600_000, maxIntervalMs: 600_000 } });
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
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const url = message.location()?.url ?? "";
      if (message.text().startsWith("Failed to load resource") && url.endsWith("/favicon.ico")) return;
      failures.push(`${message.text()} ${url}`);
    });
    page.on("pageerror", (error) => failures.push(error.stack || error.message));
    await use(page);
    if (failures.length && testInfo.status === testInfo.expectedStatus) throw new Error(`Browser diagnostics:\n${failures.join("\n")}`);
  },
});

test.use({ launchOptions: chrome ? { executablePath: chrome } : {}, viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 });
test.skip(process.env.E2E_EDITOR_FAKES !== "1",
  "E2E_EDITOR_FAKES=1 is required (server with POTONGIN_EDITOR_V3=on and POTONGIN_EDITOR_FAKES=1)");
test.skip(!settings.username || !settings.password, "E2E_USERNAME and E2E_PASSWORD are required");

async function openLengkap(page, config) {
  await page.addInitScript(installScenario, { edits: TYPOS, ...config });
  await page.goto(LENGKAP);
  await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 30_000 });
  await page.getByRole("tab", { name: "Transkrip" }).click();
  await page.locator('[data-panel="transcript"] [data-spelling-toggle]').click();
  const review = page.locator("#spelling-review-transcript");
  await expect(review).toBeVisible();
  return review;
}

const calls = (page) => page.evaluate(() => window.__spellingCalls);
const edits = (page) => page.evaluate(() => window.__potonginEditor.store.getState().doc.captions.word_edits);
const rows = (review) => review.getByRole("list", { name: "Saran ejaan" }).getByRole("listitem");

test("the review lists 'salah → benar' with context; Terima is a word edit that Ctrl+Z takes back", async ({ page }) => {
  const review = await openLengkap(page, { ...DONE, pendingPolls: 3 });
  await expect(review.locator('[data-spelling-state="checking"]')).toContainText("AI sedang memeriksa ejaan");
  await expect(review.getByText("Teks transkrip klip ini dikirim ke penyedia AI yang aktif di Pengaturan.")).toBeVisible();
  await expect(rows(review)).toHaveCount(3, { timeout: 10_000 });
  const first = rows(review).first();
  await expect(first.locator("del")).toHaveText("flim");
  await expect(first.locator("ins")).toHaveText("film");
  await expect(first).toContainText("ditahan di");
  await expect(first).toContainText("Ejaan");
  await expect(rows(review).nth(1)).toContainText("Huruf kapital");
  await expect(page.locator('[data-panel="transcript"] [data-spelling-toggle]')).toHaveText("Cek ejaan · 3");
  const polls = (await calls(page)).filter((call) => call.name === "aiTask");
  expect(polls.length).toBe(3);
  for (let index = 1; index < polls.length; index += 1) {
    const gap = polls[index].at - polls[index - 1].at;
    expect(gap).toBeGreaterThan(800);
    expect(gap).toBeLessThan(2500);
  }
  expect((await calls(page)).find((call) => call.name === "aiSpelling").edits).toEqual(TYPOS);

  await first.getByRole("button", { name: "Terima: flim jadi film" }).click();
  await expect.poll(() => edits(page)).toEqual({ [ID[6]]: { text: "jadi" }, [ID[11]]: { text: "subu" } });
  await expect(rows(review)).toHaveCount(2);
  await expect(review.locator("[data-spelling-status]")).toHaveText("1 perbaikan diterapkan. Urungkan dengan Ctrl+Z.");
  await expect(page.locator('[data-panel="transcript"] [data-w="4"]')).toHaveText("film");

  await page.keyboard.press("Control+z");
  await expect.poll(() => edits(page)).toEqual(TYPOS);
  await expect(rows(review)).toHaveCount(3);
});

test("Lewati hides a row until 'Tampilkan lagi'; Terima semua is one undo step", async ({ page }) => {
  const review = await openLengkap(page, DONE);
  await expect(rows(review)).toHaveCount(3, { timeout: 10_000 });
  await rows(review).nth(1).getByRole("button", { name: "Lewati: jadi" }).click();
  await expect(rows(review)).toHaveCount(2);
  await expect(review).toContainText("1 dilewati");
  await review.getByRole("button", { name: "Tampilkan lagi" }).click();
  await expect(rows(review)).toHaveCount(3);

  await review.getByRole("button", { name: "Terima semua (3)" }).click();
  await expect.poll(() => edits(page)).toEqual({ [ID[6]]: { text: "Jadi" }, [ID[11]]: { text: "subuh" } });
  await expect(review.locator("[data-spelling-status]")).toHaveText("3 perbaikan diterapkan. Urungkan dengan Ctrl+Z.");
  await expect(review.locator('[data-spelling-state="done"]')).toHaveText("Semua saran sudah ditangani.");
  await expect(review.locator("[data-spelling-status]")).toBeFocused();
  await page.keyboard.press("Control+z");
  await expect.poll(() => edits(page)).toEqual(TYPOS);
  await expect(rows(review)).toHaveCount(3);
  expect((await calls(page)).filter((call) => call.name === "aiSpelling")).toHaveLength(1);
});

test("keyboard: after Terima the next row's Terima has focus with a visible ring", async ({ page }) => {
  const review = await openLengkap(page, DONE);
  await expect(rows(review)).toHaveCount(3, { timeout: 10_000 });
  const accept = rows(review).first().getByRole("button", { name: "Terima: flim jadi film" });
  await accept.focus();
  await page.keyboard.press("Enter");
  const next = review.getByRole("button", { name: "Terima: jadi jadi Jadi" });
  await expect(next).toBeFocused();
  expect(await next.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");
  await page.keyboard.press("Tab");
  await expect(review.getByRole("button", { name: "Lewati: jadi" })).toBeFocused();
});

test("a failed check says so and 'Coba lagi' asks again; the hourly limit is explained", async ({ page }) => {
  const review = await openLengkap(page, {
    starts: [{ taskId: TASK_ID, llm: { state: "pending" } }, { taskId: null, llm: { state: "rate_limited", retryAfterMs: 125_000 } }],
    pendingPolls: 1, task: { state: "failed", suggestions: [], error: { code: "llm_unavailable", messageId: "editor_ai.llm_unavailable" } },
  });
  const failed = review.locator('[data-spelling-state="failed"]');
  await expect(failed).toContainText("Cek ejaan belum bisa dipakai (kuota/koneksi AI).", { timeout: 10_000 });
  await failed.getByRole("button", { name: "Coba lagi" }).click();
  await expect(review.locator('[data-spelling-state="rate_limited"]'))
    .toHaveText("Batas saran AI untuk proyek ini sudah tercapai (30 per jam). Coba lagi dalam 3 menit.");
  expect((await calls(page)).filter((call) => call.name === "aiSpelling")).toHaveLength(2);
});

test("with the AI off in Pengaturan the review says what to do and sends nothing to a provider", async ({ page }) => {
  const message = "Pengaturan AI tidak bisa dibaca; saran AI dimatikan dan saran otomatis dipakai.";
  const review = await openLengkap(page, { start: { taskId: null, llm: { state: "disabled", message } } });
  await expect(review.locator('[data-spelling-state="off"]')).toHaveText(message);
  await expect(review.getByText(/penyedia AI yang aktif/)).toHaveCount(0);
  expect((await calls(page)).filter((call) => call.name === "aiTask")).toHaveLength(0);
});

test("Mode Cepat: the Teks caption card opens the same review; accepting updates the lines; a view switch keeps the answer", async ({ page }) => {
  await page.addInitScript(installScenario, { edits: TYPOS, ...DONE });
  await page.goto(CEPAT);
  await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 30_000 });
  const card = await openCard(page, "lines");
  const lines = () => card.locator("[data-line-key] input").evaluateAll((inputs) => inputs.map((input) => input.value));
  await expect.poll(lines).toEqual(["Kenapa sutradara ditahan di", "flim sendiri?", "jadi waktu itu kita", "datang subu"]);
  expect((await calls(page)) ?? []).toHaveLength(0);
  const toggle = card.locator("[data-spelling-toggle]");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  const review = page.locator("#spelling-review-card");
  await expect(rows(review)).toHaveCount(3, { timeout: 10_000 });
  await review.getByRole("button", { name: "Terima semua (3)" }).click();
  await expect.poll(lines).toEqual(["Kenapa sutradara ditahan di", "film sendiri?", "Jadi waktu itu kita", "datang subuh"]);
  await page.keyboard.press("Control+z");
  await expect.poll(lines).toEqual(["Kenapa sutradara ditahan di", "flim sendiri?", "jadi waktu itu kita", "datang subu"]);

  await switchView(page, "lengkap");
  await page.getByRole("tab", { name: "Transkrip" }).click();
  await page.locator('[data-panel="transcript"] [data-spelling-toggle]').click();
  await expect(rows(page.locator("#spelling-review-transcript"))).toHaveCount(3);
  expect((await calls(page)).filter((call) => call.name === "aiSpelling")).toHaveLength(1);
});

test("no version label in the review", async ({ page }) => {
  const review = await openLengkap(page, DONE);
  await expect(rows(review)).toHaveCount(3, { timeout: 10_000 });
  expect(await review.innerText()).not.toMatch(/\bV[0-9]\b|versi [0-9]|mesin (?:lama|baru)|—/i);
});

test.describe("reduced motion", () => {
  test("rows appear without animation and the progress bar is hidden", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const review = await openLengkap(page, { ...DONE, pendingPolls: 50 });
    await expect(review.locator('[data-spelling-state="checking"]')).toBeVisible();
    await expect(review.locator('[data-spelling-state="checking"] [aria-hidden="true"]')).toBeHidden();
    expect(await review.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
  });
});

test("QG-A11Y: axe finds no critical or serious violation in the review with suggestions", async ({ page }) => {
  test.skip(!AXE, "axe-core is not a web dependency: set AXE_CORE_PATH to an axe.min.js");
  const review = await openLengkap(page, DONE);
  await expect(rows(review)).toHaveCount(3, { timeout: 10_000 });
  await page.waitForTimeout(400); // entrance fades end before axe reads contrast
  await page.addScriptTag({ content: AXE });
  const result = await page.evaluate(async () => window.axe.run(document.querySelector("#spelling-review-transcript"),
    { resultTypes: ["violations"] }));
  const serious = result.violations.filter((violation) => ["critical", "serious"].includes(violation.impact));
  expect(serious.map((violation) => `${violation.id}: ${violation.nodes.length}`)).toEqual([]);
});
