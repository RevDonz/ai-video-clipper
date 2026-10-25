import { mkdir } from "node:fs/promises";
import path from "node:path";

import { expect } from "@playwright/test";

import { login, skipWithoutCredentials, test } from "./support/harness.mjs";

// Screenshots of the signed-in app shell (rombak 07 §15, 08 Fase 1 Dashboard F1): the sidebar at
// 1280 and 1024 px with its account menu open, and the top bar and the open drawer at 390 and
// 360 px. Written to $EDITOR_GATES_OUT/shell-shots so a run on main and a run on a branch can be
// compared file by file; the selectors are the ones both shells have (the account menu is shot
// only where it exists). /bantuan reads no job data itself and the job list is faked, so the
// pages are the same on every server.

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

  for (const width of [1280, 1024]) {
    test(`${width} px: the sidebar and its account menu`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await noJobs(page);
      await login(page, "/bantuan");
      await expect(page.getByRole("navigation").first()).toBeVisible();
      await shoot(page, `desktop-${width}-bantuan`);
      const account = page.locator(".appAccount");
      if (await account.count()) {
        await account.first().click();
        await expect(page.getByRole("menu")).toBeVisible();
        await page.waitForTimeout(300);
        await shoot(page, `desktop-${width}-account`);
      }
    });
  }

  for (const width of [390, 360]) {
    test(`${width} px: the top bar and the open drawer`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await noJobs(page);
      await login(page, "/bantuan");
      const menu = page.locator("button[aria-expanded]").first();
      await expect(menu).toBeVisible();
      await shoot(page, `mobile-${width}-bantuan`);
      await menu.click();
      await expect(page.getByRole("navigation").first()).toBeVisible();
      await page.waitForTimeout(400);
      await shoot(page, `mobile-${width}-drawer`);
      const account = page.getByRole("dialog").locator(".appAccount");
      if (await account.count()) {
        await account.first().click();
        await expect(page.getByRole("menu")).toBeVisible();
        await page.waitForTimeout(300);
        await shoot(page, `mobile-${width}-account`);
      }
    });
  }
});
