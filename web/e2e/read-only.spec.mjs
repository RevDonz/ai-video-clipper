import { expect } from "@playwright/test";

import {
  editorPath, expectEditorReady, expectPlaybackAdvances, login, resolveTarget, settings,
  skipWithoutCredentials, test,
} from "./support/harness.mjs";

test.describe("read-only production-safe flows", () => {
  test.beforeEach(() => skipWithoutCredentials(test));

  test("login preserves a nested candidate-editor deep link", async ({ context, page }) => {
    await login(page);
    const target = await resolveTarget(page);
    const next = editorPath(target.jobId, target.availableCandidateIds[0]);

    await context.clearCookies();
    await page.goto(next);
    await expect(page).toHaveURL((url) => url.pathname === "/login" && url.searchParams.get("next") === next);
    await page.locator('input[name="username"]').fill(settings.username);
    await page.locator('input[name="password"]').fill(settings.password);
    await Promise.all([
      page.waitForURL((url) => url.pathname === next),
      page.locator('button[type="submit"]').click(),
    ]);
    await expectEditorReady(page);
  });

  test("project exposes every V2 candidate and every editor loads", async ({ page }) => {
    await login(page);
    const target = await resolveTarget(page);

    await page.goto(`/projects/${encodeURIComponent(target.jobId)}`);
    await expect(page.locator(".candidateCard")).toHaveCount(target.availableCandidateIds.length);
    for (const [index, candidateId] of target.availableCandidateIds.entries()) {
      await page.goto(editorPath(target.jobId, candidateId));
      await expectEditorReady(page);
      if (index === 0) await expectPlaybackAdvances(page.locator("video").first());
    }
  });

  test("editor accepts a weak transport ETag at runtime", async ({ page }) => {
    await login(page);
    const target = await resolveTarget(page);
    const candidateId = target.availableCandidateIds[0];
    const editPath = `/api/jobs/${encodeURIComponent(target.jobId)}/candidates/${encodeURIComponent(candidateId)}/edit`;
    let transformed = false;
    await page.route(`**${editPath}`, async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      const headers = { ...response.headers() };
      const etag = headers.etag;
      expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
      headers.etag = `W/${etag}`;
      transformed = true;
      await route.fulfill({ response, headers });
    });
    await page.goto(editorPath(target.jobId, candidateId));
    await expectEditorReady(page);
    expect(transformed).toBe(true);
  });
});
