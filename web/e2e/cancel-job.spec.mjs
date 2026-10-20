import { expect } from "@playwright/test";

import { login, skipWithoutCredentials, test } from "./support/harness.mjs";

// "Batalkan" on a running job (plan 2026-10-20 A4), on the dashboard and on the project page:
// a quiet button, a confirmation inside the page (no browser dialog), Escape and focus, then
// "Dibatalkan". The job API and its cancel route are faked inside the browser (page.route), so
// nothing on the server changes; only the login is real. The real route and the runner are
// covered by web/tests/job-cancel.test.mjs and web/tests/job-cancel-runner.test.mjs.

const JOB_ID = "4b1f2c3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const NOW = new Date().toISOString();
const ACTIVE_AI = { state: "active", order: ["uji"], providers: [{ name: "uji", displayName: null }], label: "LLM aktif: uji" };
const RUNNING = {
  id: JOB_ID, status: "processing", stage: "transcribing", stageDetail: "Transkripsi audio 40%", progress: 42,
  createdAt: NOW, updatedAt: NOW, source: { type: "upload", name: "Podcast 7.mp4" },
  options: { selectionMode: "v3", renderMode: "fit-blur", limit: 3, minDuration: 20, maxDuration: 60 }, clips: [],
};
const CANCELLED = {
  ...RUNNING, status: "cancelled", stage: "cancelled", stageDetail: "Dibatalkan sebelum selesai",
  cancellation: { requestedAt: NOW, previousStatus: "processing", safeAfter: NOW },
};

/** Fakes the job list, the job, its cancel route and the two status routes; returns the cancel requests. */
async function fakeJobApi(page) {
  const cancels = [];
  let job = RUNNING;
  await page.route(/\/api\/(?:jobs|llm\/status|storage\/status)(?:[/?]|$)/, (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const json = (status, body) => route.fulfill({ status, contentType: "application/json", headers: { "Cache-Control": "no-store" }, body: JSON.stringify(body) });
    if (pathname === "/api/llm/status") return json(200, { llm: ACTIVE_AI });
    if (pathname === "/api/storage/status") return json(200, { admission: { allowed: true, code: null } });
    if (pathname === "/api/jobs") return json(200, { jobs: [job] });
    if (pathname === `/api/jobs/${JOB_ID}/cancel` && request.method() === "POST") {
      cancels.push({ origin: request.headers().origin || null });
      job = CANCELLED;
      return json(200, { job, cancelled: true });
    }
    if (pathname === `/api/jobs/${JOB_ID}`) return json(200, { job });
    return json(200, { clips: [] });
  });
  page.on("dialog", (dialog) => { throw new Error(`Unexpected browser dialog: ${dialog.message()}`); });
  return cancels;
}

const askButton = (page) => page.getByRole("button", { name: "Batalkan", exact: true });
const confirmation = (page) => page.getByRole("group", { name: "Batalkan proses ini?" });
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function confirmFlow(page, cancels) {
  await expect(askButton(page)).toBeVisible();
  await askButton(page).click();
  await expect(confirmation(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Lanjutkan proses" })).toBeFocused();

  // Escape keeps the job running and returns the focus to "Batalkan".
  await page.keyboard.press("Escape");
  await expect(confirmation(page)).toHaveCount(0);
  await expect(askButton(page)).toBeFocused();
  expect(cancels).toHaveLength(0);

  await page.keyboard.press("Enter");
  await expect(confirmation(page)).toBeVisible();
  await page.getByRole("button", { name: "Ya, batalkan" }).click();
  await expect.poll(() => cancels.length).toBe(1);
  expect(cancels[0].origin).toBe(new URL(page.url()).origin);
  await expect(askButton(page)).toHaveCount(0);
}

test.describe("Batalkan a running job (faked job API)", () => {
  test.beforeEach(() => skipWithoutCredentials(test));

  test("dashboard: confirm inside the page, then the job reads Dibatalkan", async ({ page }) => {
    const cancels = await fakeJobApi(page);
    await login(page, "/dashboard");
    await expect(page.getByText("Transkripsi audio 40%")).toBeVisible();
    await expect(page.getByText("42%", { exact: true })).toBeVisible();

    await confirmFlow(page, cancels);
    const state = page.locator("#job-state");
    await expect(state).toHaveText("Dibatalkan");
    await expect(state).toBeFocused();
    await expect(page.getByText("42%", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Proses dibatalkan sebelum klip selesai.")).toBeVisible();
  });

  test("project page: Batalkan in the progress panel, then the cancelled notice", async ({ page }) => {
    const cancels = await fakeJobApi(page);
    await login(page, `/projects/${JOB_ID}`);
    await expect(page.getByRole("heading", { name: "Transkripsi audio 40%" })).toBeVisible();

    await confirmFlow(page, cancels);
    await expect(page.getByRole("heading", { name: "Transkripsi audio 40%" })).toHaveCount(0);
    await expect(page.getByText("Proses dibatalkan", { exact: true })).toBeFocused();
    await expect(page.getByText("Dibatalkan", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Buat ulang di Buat Klip" })).toHaveAttribute("href", "/dashboard");
  });

  test("at 360 px the confirmation fits, its buttons are 44 px targets and nothing scrolls sideways", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 760 });
    await fakeJobApi(page);
    await login(page, "/dashboard");
    for (const path of ["/dashboard", `/projects/${JOB_ID}`]) {
      if (new URL(page.url()).pathname !== path) await page.goto(path);
      await askButton(page).click();
      await expect(confirmation(page)).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      for (const name of ["Ya, batalkan", "Lanjutkan proses"]) {
        const box = await page.getByRole("button", { name }).boundingBox();
        expect(box.height, name).toBeGreaterThanOrEqual(44);
      }
      await page.keyboard.press("Escape");
    }
  });
});
