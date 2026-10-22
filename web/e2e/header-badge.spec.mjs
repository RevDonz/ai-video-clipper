import { expect } from "@playwright/test";

import { login, skipWithoutCredentials, test } from "./support/harness.mjs";

// The job badge in the shared sidebar (components/JobBadge.jsx, docs/operations/PROGRES_JOB.md).
// The job list and the one job are faked inside the browser (page.route), so nothing on the server
// changes; only the login is real. /bantuan is used because the page reads no job data itself.

const JOB_ID = "5c2a3d4e-6f70-4a8b-9c0d-1e2f3a4b5c6d";
const NEW_ID = "6d3b4e5f-7081-4b9c-8d1e-2f3a4b5c6d7e";
const NOW = new Date().toISOString();
const running = (progress, extra = {}) => ({
  id: JOB_ID, status: "processing", stage: "transcribing", progress, createdAt: NOW, updatedAt: NOW,
  source: { type: "upload", name: "Podcast 7.mp4" }, options: { selectionMode: "v3" }, clips: [], ...extra,
});
const clips = (count) => Array.from({ length: count }, (_, index) => ({ index: index + 1, title: `Klip ${index + 1}` }));

/** Fakes GET /api/jobs and GET /api/jobs/<id> from `server.jobs`; records every request path. */
async function fakeJobs(page, jobs) {
  const server = { jobs, requests: [] };
  await page.route(/\/api\/jobs(?:\/[0-9a-f-]{36})?(?:\?.*)?$/, (route) => {
    const { pathname } = new URL(route.request().url());
    server.requests.push(pathname);
    const json = (status, body) => route.fulfill({ status, contentType: "application/json", headers: { "Cache-Control": "no-store" }, body: JSON.stringify(body) });
    if (pathname === "/api/jobs") return json(200, { jobs: server.jobs, total: server.jobs.length, editor: false });
    const job = server.jobs.find((item) => item.id === pathname.split("/")[3]);
    return job ? json(200, { job }) : json(404, { error: "Job tidak ditemukan" });
  });
  return server;
}

const badge = (page) => page.locator(".appSide .jobBadge");
const live = (page) => page.locator('.appSide [aria-live="polite"]');
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const jobsChanged = (page) => page.evaluate(() => window.dispatchEvent(new Event("potongin:jobs-changed")));

test.describe("Job badge in the sidebar (faked job API)", () => {
  test.beforeEach(() => skipWithoutCredentials(test));

  test("a running job: a link with its percentage, read on its own, then its outcome announced", async ({ page }) => {
    const server = await fakeJobs(page, [running(42)]);
    await login(page, "/bantuan");
    const link = page.getByRole("link", { name: "1 berjalan · 42%" });
    await expect(link).toHaveAttribute("href", `/projects/${JOB_ID}`);
    await expect(link).toHaveAttribute("title", "Podcast 7.mp4");
    await expect(live(page)).toHaveText("");

    // The next read is of that job alone; a moving percentage is not announced.
    server.jobs = [running(57)];
    await expect(page.getByRole("link", { name: "1 berjalan · 57%" })).toBeVisible({ timeout: 10_000 });
    expect(server.requests).toContain(`/api/jobs/${JOB_ID}`);
    await expect(live(page)).toHaveText("");

    server.jobs = [running(100, { status: "completed", stage: "completed", clips: clips(3) })];
    await expect(page.getByRole("link", { name: "Terakhir: 3 klip" })).toBeVisible({ timeout: 10_000 });
    await expect(live(page)).toHaveText("Proyek selesai: 3 klip");
    await expect(badge(page).locator(".jobBadgeDot")).toHaveCount(0);
  });

  test("a page that starts a job refreshes the badge at once", async ({ page }) => {
    const server = await fakeJobs(page, [running(100, { status: "completed", clips: clips(8) })]);
    await login(page, "/bantuan");
    await expect(page.getByRole("link", { name: "Terakhir: 8 klip" })).toBeVisible();
    server.jobs = [{ ...running(0), id: NEW_ID, status: "queued" }, ...server.jobs];
    await jobsChanged(page);
    // Well before the idle read a minute later.
    await expect(page.getByRole("link", { name: "1 berjalan · 0%" })).toHaveAttribute("href", `/projects/${NEW_ID}`, { timeout: 3_000 });
    await expect(live(page)).toHaveText("", { timeout: 1_000 });
  });

  test("a failed or cancelled newest job says so", async ({ page }) => {
    const server = await fakeJobs(page, [running(30, { status: "failed", stage: "failed" })]);
    await login(page, "/bantuan");
    await expect(page.getByRole("link", { name: "Terakhir: gagal" })).toBeVisible();
    server.jobs = [running(30, { status: "cancelled", stage: "cancelled" })];
    await jobsChanged(page);
    await expect(page.getByRole("link", { name: "Terakhir: dibatalkan" })).toBeVisible();
  });

  test("no jobs: no badge, and the live region stays empty", async ({ page }) => {
    const server = await fakeJobs(page, []);
    await login(page, "/bantuan");
    await expect.poll(() => server.requests.filter((path) => path === "/api/jobs").length).toBeGreaterThan(0);
    await expect(badge(page)).toHaveCount(0);
    await expect(live(page)).toHaveText("");
    await expect(page.locator(".appSide .brandName")).toBeVisible();
  });

  test("a hidden tab sends nothing; showing it again reads the list at once", async ({ page }) => {
    const server = await fakeJobs(page, [running(42)]);
    await login(page, "/bantuan");
    await expect(page.getByRole("link", { name: "1 berjalan · 42%" })).toBeVisible();
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const hiddenAt = server.requests.length;
    // Longer than the 5 s interval of a running job.
    await page.waitForTimeout(7_000);
    expect(server.requests.length).toBe(hiddenAt);
    await page.evaluate(() => {
      delete document.visibilityState;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect.poll(() => server.requests.slice(hiddenAt), { timeout: 2_000 }).toContain("/api/jobs");
  });

  test("keyboard: the badge comes right after the brand", async ({ page }) => {
    await fakeJobs(page, [running(42)]);
    await login(page, "/bantuan");
    const link = page.getByRole("link", { name: "1 berjalan · 42%" });
    await expect(link).toBeVisible();
    await page.getByRole("link", { name: "Potongin AI", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(link).toBeFocused();
  });
});

test.describe("Job badge on a phone (faked job API)", () => {
  test.beforeEach(() => skipWithoutCredentials(test));

  test("at 360 px the short form fits the top bar as a 44 px target; at 390 px the full text shows", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 760 });
    await fakeJobs(page, [running(42)]);
    await login(page, "/bantuan");
    const link = page.getByRole("link", { name: "1 berjalan · 42%" });
    await expect(link).toBeVisible();
    const menu = page.getByRole("button", { name: "Menu", exact: true });
    const [box, toggle] = await Promise.all([link.boundingBox(), menu.boundingBox()]);
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(Math.abs(box.y - toggle.y), "same row as Menu").toBeLessThan(2);
    expect(box.x + box.width).toBeLessThanOrEqual(toggle.x);
    expect(await link.evaluate((element) => getComputedStyle(element, "::after").content)).toContain("42%");
    expect(await overflow(page)).toBeLessThanOrEqual(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(link.locator(".jobBadgeText")).toBeInViewport();
    expect((await link.locator(".jobBadgeText").boundingBox()).width).toBeGreaterThan(60);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });
});
