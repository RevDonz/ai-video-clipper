import { expect } from "@playwright/test";

import { login, resolveTarget, skipWithoutCredentials, test } from "./support/harness.mjs";

test.describe("authenticated read-only smoke", () => {
  test.beforeEach(() => skipWithoutCredentials(test));

  test("projects and latest completed V2 project render", async ({ page }) => {
    await login(page, "/projects");
    await expect(page.getByRole("heading", { name: "Riwayat proyek" })).toBeVisible();

    const target = await resolveTarget(page);
    await page.goto(`/projects/${encodeURIComponent(target.jobId)}`);
    await expect(page.getByRole("heading", { name: "Kandidat potongan" })).toBeVisible();
    await expect(page.locator(".candidateCard")).toHaveCount(target.availableCandidateIds.length);
  });
});
