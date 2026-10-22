import { expect } from "@playwright/test";

import { login, skipWithoutCredentials, test } from "./support/harness.mjs";

// The shared sidebar (components/AppShell.jsx): a column from 1024 px, a "Menu" drawer below it.
// /bantuan is used because the page reads no job data itself; the job list is faked so the
// badge never depends on the server's projects.

async function noJobs(page) {
  await page.route(/\/api\/jobs(?:\?.*)?$/, (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ jobs: [], total: 0, editor: false }),
  }));
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const nav = (page) => page.getByRole("navigation", { name: "Menu utama" });

test.describe("App sidebar", () => {
  test.beforeEach(() => skipWithoutCredentials(test));

  test("on a laptop the sidebar is always there: grouped links, the current page marked, no Menu button", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await noJobs(page);
    await login(page, "/bantuan");
    await expect(nav(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "Menu", exact: true })).toBeHidden();
    for (const name of ["Buat klip", "Riwayat", "Konteks Tren", "Pengaturan", "Bantuan"]) {
      await expect(nav(page).getByRole("link", { name, exact: true })).toBeVisible();
    }
    await expect(nav(page).getByRole("link", { name: "Bantuan", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(nav(page).getByRole("link", { name: "Riwayat", exact: true })).not.toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("button", { name: "Keluar" })).toBeVisible();
    await expect(page.getByRole("main")).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  test("on a phone Menu opens the drawer, Escape closes it and focus goes back to Menu", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await noJobs(page);
    await login(page, "/bantuan");
    const menu = page.getByRole("button", { name: "Menu", exact: true });
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await expect(nav(page)).toBeHidden();
    expect(await overflow(page)).toBeLessThanOrEqual(0);

    await menu.click();
    const close = page.getByRole("button", { name: "Tutup", exact: true });
    await expect(close).toHaveAttribute("aria-expanded", "true");
    await expect(nav(page)).toBeVisible();
    await expect(nav(page).getByRole("link", { name: "Buat klip", exact: true })).toBeFocused();
    // The page behind the drawer takes no focus while it is open.
    expect(await page.locator("main").evaluate((element) => element.inert)).toBe(true);
    expect(await overflow(page)).toBeLessThanOrEqual(0);

    await page.keyboard.press("Escape");
    await expect(nav(page)).toBeHidden();
    await expect(menu).toBeFocused();
    expect(await page.locator("main").evaluate((element) => element.inert)).toBe(false);

    // The Tutup button and a tap on the dimmed page close it too.
    await menu.click();
    await close.click();
    await expect(nav(page)).toBeHidden();
    await expect(menu).toBeFocused();
    await menu.click();
    await page.mouse.click(380, 600);
    await expect(nav(page)).toBeHidden();
  });

  test("a drawer left open closes when the window grows past 1024 px", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 900 });
    await noJobs(page);
    await login(page, "/bantuan");
    await page.getByRole("button", { name: "Menu", exact: true }).click();
    await expect(nav(page)).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(nav(page)).toBeVisible();
    expect(await page.locator("main").evaluate((element) => element.inert)).toBe(false);
  });

  test("the skip link is the first stop and jumps to the page", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await noJobs(page);
    await login(page, "/bantuan");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Langsung ke isi" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#konten$/);
  });
});
