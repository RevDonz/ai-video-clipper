import { mkdir } from "node:fs/promises";
import path from "node:path";

import { expect } from "@playwright/test";

import { login, skipWithoutCredentials, test } from "./support/harness.mjs";

// Screenshots of the signed-in app shell (rombak 07 §15, i18n M0 "screenshot shell id sama"):
// the sidebar on a laptop, the top bar and the open drawer at 360 px. Written to
// $EDITOR_GATES_OUT/shell-shots so a run on main and a run on a branch can be compared file by
// file. /bantuan reads no job data itself and the job list is faked, so the pages are the same
// on every server.

async function noJobs(page) {
  await page.route(/\/api\/jobs(?:\?.*)?$/, (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ jobs: [], total: 0, editor: false }),
  }));
}

async function shoot(page, name) {
  await page.evaluate(() => document.fonts.ready);
  const out = path.join(process.env.EDITOR_GATES_OUT || test.info().outputDir, "shell-shots");
  await mkdir(out, { recursive: true });
  await page.screenshot({ path: path.join(out, `${name}.png`), animations: "disabled", caret: "hide" });
}

test.describe("App shell screenshots", () => {
  test.beforeEach(() => skipWithoutCredentials(test));

  test("laptop: the sidebar", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await noJobs(page);
    await login(page, "/bantuan");
    await expect(page.getByRole("navigation").first()).toBeVisible();
    await shoot(page, "desktop-1280-bantuan");
  });

  test("360 px: the top bar and the open drawer", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await noJobs(page);
    await login(page, "/bantuan");
    const menu = page.locator("button[aria-expanded]").first();
    await expect(menu).toBeVisible();
    await shoot(page, "mobile-360-bantuan");
    await menu.click();
    await expect(page.getByRole("navigation").first()).toBeVisible();
    await page.waitForTimeout(400);
    await shoot(page, "mobile-360-drawer");
  });
});
