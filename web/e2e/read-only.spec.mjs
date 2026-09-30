import { expect } from "@playwright/test";

import {
  expectPlaybackAdvances, login, resolveTarget, settings, skipWithoutCredentials, test,
} from "./support/harness.mjs";

const projectPath = (jobId) => `/projects/${encodeURIComponent(jobId)}`;
const RETIRED_CANDIDATE = `cand_${"0".repeat(64)}`;

test.describe("read-only production-safe flows", () => {
  test.beforeEach(() => skipWithoutCredentials(test));

  test("login keeps a project deep link", async ({ context, page }) => {
    await login(page);
    const target = await resolveTarget(page);
    const next = projectPath(target.jobId);

    // Leave the history first: its posters would otherwise load without the cleared cookie.
    await page.goto("about:blank");
    await context.clearCookies();
    await page.goto(next);
    await expect(page).toHaveURL((url) => url.pathname === "/login" && url.searchParams.get("next") === next);
    await page.locator('input[name="username"]').fill(settings.username);
    await page.locator('input[name="password"]').fill(settings.password);
    await Promise.all([
      page.waitForURL((url) => url.pathname === next),
      page.locator('button[type="submit"]').click(),
    ]);
    await expect(page.getByRole("article")).toHaveCount(target.clipCount);
  });

  test("a project shows every clip ready to post, without version labels, and the first one plays", async ({ page }) => {
    await login(page);
    const target = await resolveTarget(page);
    await page.goto(projectPath(target.jobId));

    const cards = page.getByRole("article");
    await expect(cards).toHaveCount(target.clipCount);
    for (const card of await cards.all()) {
      await expect(card.getByRole("heading", { level: 3 })).toBeVisible();
      await expect(card.getByRole("link", { name: "Unduh MP4" })).toHaveAttribute("href", /^\/api\/jobs\/[^/]+\/files\/output\//);
      await expect(card.getByRole("button", { name: "Salin caption" })).toBeVisible();
    }
    await expect(page.getByText(/\bV[1-3]\b|Selection V|kandidat|Versi prompt|Kode peringatan/i)).toHaveCount(0);
    await expectPlaybackAdvances(page.locator("video").first());
  });

  test("an old candidate-editor link opens the project page", async ({ page }) => {
    await login(page);
    const target = await resolveTarget(page);
    await page.goto(`${projectPath(target.jobId)}/candidates/${RETIRED_CANDIDATE}/edit`);
    await expect(page).toHaveURL((url) => url.pathname === projectPath(target.jobId));
    await expect(page.getByRole("article")).toHaveCount(target.clipCount);
  });

  test("the retired candidate API routes answer 404", async ({ context, page }) => {
    await login(page);
    const target = await resolveTarget(page);
    // A second tab: the diagnostics fixture fails every API response of 400 or more, and these
    // 404s are the point.
    const probe = await context.newPage();
    await probe.goto(projectPath(target.jobId));
    const statuses = await probe.evaluate(async ({ jobId, candidate }) => {
      const base = `/api/jobs/${encodeURIComponent(jobId)}`;
      const paths = [
        `${base}/candidates`,
        `${base}/candidate-feedback`,
        `${base}/candidates/${candidate}/edit`,
        `${base}/candidates/${candidate}/caption-cues`,
      ];
      return Promise.all(paths.map(async (path) => (await fetch(path, { cache: "no-store" })).status));
    }, { jobId: target.jobId, candidate: RETIRED_CANDIDATE });
    await probe.close();
    expect(statuses).toEqual([404, 404, 404, 404]);
  });
});
