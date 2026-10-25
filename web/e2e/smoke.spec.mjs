import { expect } from "@playwright/test";

import { login, resolveTarget, skipWithoutCredentials, test } from "./support/harness.mjs";
import { L } from "./support/i18n.mjs";

test.describe("authenticated read-only smoke", () => {
  test.beforeEach(() => skipWithoutCredentials(test));

  test("the history and the newest completed project render", async ({ page }) => {
    await login(page, "/projects");
    await expect(page.getByRole("heading", { level: 1, name: L("projects.title") })).toBeVisible();

    const target = await resolveTarget(page);
    await page.goto(`/projects/${encodeURIComponent(target.jobId)}`);
    await expect(page.getByRole("heading", { level: 2, name: /klip/ })).toBeVisible();
    await expect(page.getByRole("article")).toHaveCount(target.clipCount);
  });
});
