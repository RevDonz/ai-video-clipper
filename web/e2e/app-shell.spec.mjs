import { expect } from "@playwright/test";

import { login, settings, skipWithoutCredentials, test } from "./support/harness.mjs";
import { LOCALES } from "../lib/i18n/locales.mjs";
import { L, LIn, pageTitleIn } from "./support/i18n.mjs";

// The shared shell (components/AppShell.jsx, 05-ui-dashboard.md §4.2, §6.1): a flat sidebar from
// 1024 px, a "Menu" Drawer below it, the account menu with "Pintasan satu tombol" and Keluar, and
// the single-key shortcuts N and /. Runs in the desktop and mobile projects (each test sets its
// own viewport) and in en-smoke. /bantuan is used because the page reads no job data itself; the
// job list is faked so the badge never depends on the server's projects.

async function noJobs(page) {
  await page.route(/\/api\/jobs(?:\?.*)?$/, (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ jobs: [], total: 0, editor: false }),
  }));
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const nav = (page) => page.getByRole("navigation", { name: L("aria.mainMenu") });
const menuButton = (page) => page.getByRole("button", { name: L("shell.menu"), exact: true });
const drawer = (page) => page.getByRole("dialog", { name: L("shell.menu") });
const accountButton = (page) => page.getByRole("button", { name: L("shell.account.named", { name: settings.username }), exact: true });
const shortcutsItem = (page) => page.getByRole("menuitemcheckbox", { name: L("shell.account.shortcuts"), exact: true });
// Nothing focused: the keys go to the page itself.
const blur = (page) => page.evaluate(() => document.activeElement?.blur?.());
const inert = (page) => page.locator("main").evaluate((element) => element.inert);
const shortcutCookie = async (page) => (await page.context().cookies()).find((cookie) => cookie.name === "potongin_shortcuts")?.value;
const LINKS = ["shell.nav.create", "shell.nav.projects", "shell.nav.trends", "shell.nav.settings", "shell.nav.help"];

// Measured once an opening overlay has finished its scale-in (the menu grows from 95 %).
async function expectTarget(locator, what) {
  await expect.poll(async () => (await locator.boundingBox())?.height ?? 0, { message: `${what}: height` }).toBeGreaterThanOrEqual(44);
  await expect.poll(async () => (await locator.boundingBox())?.width ?? 0, { message: `${what}: width` }).toBeGreaterThanOrEqual(44);
}

test.describe("App shell", () => {
  test.beforeEach(() => skipWithoutCredentials(test));

  test("on a laptop the sidebar is always there: one flat list, the current page marked, no Menu button", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await noJobs(page);
    await login(page, "/bantuan");
    await expect(nav(page)).toHaveCount(1);
    await expect(nav(page)).toBeVisible();
    await expect(menuButton(page)).toBeHidden();
    // The links in order, and nothing else: no group labels, no Riwayat or Konteks Tren.
    const names = await nav(page).getByRole("link").allInnerTexts();
    expect(names.map((name) => name.trim())).toEqual(LINKS.map((key) => L(key)));
    for (const key of LINKS) await expectTarget(nav(page).getByRole("link", { name: L(key), exact: true }), key);
    await expect(nav(page).getByRole("link", { name: L("shell.nav.help"), exact: true })).toHaveAttribute("aria-current", "page");
    await expect(nav(page).getByRole("link", { name: L("shell.nav.projects"), exact: true })).not.toHaveAttribute("aria-current", "page");
    await expect(nav(page).locator("[aria-current]")).toHaveCount(1);
    // Keluar moved into the account menu; the account button sits at the foot of the sidebar.
    await expect(page.getByRole("button", { name: L("shell.account.logout") })).toHaveCount(0);
    await expect(accountButton(page)).toBeVisible();
    await expectTarget(accountButton(page), "account button");
    const [list, account] = await Promise.all([nav(page).boundingBox(), accountButton(page).boundingBox()]);
    expect(account.y).toBeGreaterThan(list.y + list.height);
    await expect(page.getByRole("main")).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  test("the account menu: opens from its button, Escape gives focus back, the shortcuts item is checked", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await noJobs(page);
    await login(page, "/bantuan");
    await accountButton(page).click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await expect(shortcutsItem(page)).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("menuitem", { name: L("shell.account.logout"), exact: true })).toBeVisible();
    const items = menu.locator('[role="menuitem"], [role="menuitemcheckbox"]');
    await expect(items).toHaveCount(2);
    for (const item of await items.all()) await expectTarget(item, "menu item");
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(accountButton(page)).toBeFocused();
    // From the keyboard too: Enter opens it with focus inside.
    await page.keyboard.press("Enter");
    await expect(menu).toBeVisible();
    await expect(menu.locator(":focus")).toHaveCount(1);
    await page.keyboard.press("Escape");
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  test("Pintasan satu tombol: N and / act while on; off (two clicks) they stop, and the choice survives a reload", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await noJobs(page);
    // N opens Buat klip; its page is stubbed so the test does not depend on the dashboard's own calls.
    await page.route(/\/dashboard(?:\?.*)?$/, (route) => (route.request().resourceType() === "document"
      ? route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>dashboard</title><main id=konten></main>" })
      : route.continue()));
    await login(page, "/bantuan");
    const search = page.locator('#konten input[type="search"]');

    // On (the default): / goes to the page's search, where N is just a letter. The key is pressed
    // again until the page has hydrated and the shell listens.
    await expect(async () => {
      await blur(page);
      await page.keyboard.press("/");
      await expect(search).toBeFocused({ timeout: 500 });
    }).toPass();
    await page.keyboard.type("n");
    await expect(search).toHaveValue("n");
    await expect(page).toHaveURL(/\/bantuan/);
    await search.fill("");
    await search.blur();

    // Off: two clicks from anywhere in the shell (05 §7.3).
    await accountButton(page).click();
    await shortcutsItem(page).click();
    await expect.poll(() => shortcutCookie(page)).toBe("off");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.reload();
    await accountButton(page).click();
    await expect(shortcutsItem(page)).toHaveAttribute("aria-checked", "false");
    await page.keyboard.press("Escape");
    // An overlay on its way out still owns the keys: wait until the menu is gone.
    await expect(page.getByRole("menu")).toHaveCount(0);
    await blur(page);
    await page.keyboard.press("/");
    await expect(search).not.toBeFocused();
    await page.keyboard.press("n");
    await page.waitForTimeout(300);
    await expect(page).toHaveURL(/\/bantuan/);

    // On again: N opens Buat klip.
    await accountButton(page).click();
    await shortcutsItem(page).click();
    await expect.poll(() => shortcutCookie(page)).toBe("on");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await blur(page);
    await expect(page).toHaveURL(/\/bantuan/);
    await page.keyboard.press("n");
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test("Bahasa in the account menu: two clicks switch the UI language, and it stays after a reload", async ({ page, uiLocale }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await noJobs(page);
    await login(page, "/bantuan");
    await accountButton(page).click(); // 1
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    const languages = menu.getByRole("menuitemradio");
    if (testInfo.project.name !== "en-smoke" && await languages.count() === 0) {
      // A server with one UI language (production until i18n M9) shows no picker at all.
      await expect(menu.getByRole("group", { name: L("shell.account.language") })).toHaveCount(0);
      test.skip(true, "one UI language on this server: the picker is not rendered");
    }
    // Every enabled language, each named in itself; the current one is checked.
    await expect(languages).toHaveCount(LOCALES.length);
    const current = LOCALES.find((entry) => entry.code === uiLocale);
    const target = LOCALES.find((entry) => entry.code !== uiLocale);
    await expect(menu.getByRole("menuitemradio", { name: current.label, exact: true })).toHaveAttribute("aria-checked", "true");
    for (const item of await languages.all()) await expectTarget(item, "language item");
    // A native form post and a 303 back to this page: a full reload in the new language.
    const posted = page.waitForResponse((response) => response.url().endsWith("/api/locale") && response.request().method() === "POST");
    await menu.getByRole("menuitemradio", { name: target.label, exact: true }).click(); // 2
    expect((await posted).status()).toBe(303);
    await expect(page).toHaveURL((url) => url.pathname === "/bantuan" && !url.searchParams.has("bahasa"));
    await expect(page.locator("html")).toHaveAttribute("lang", target.code);
    await expect(nav(page).getByRole("link", { name: LIn(target.code, "shell.nav.help"), exact: true })).toHaveAttribute("aria-current", "page");
    const cookie = (await page.context().cookies()).find((entry) => entry.name === "potongin_locale");
    expect(cookie?.value).toBe(target.code);
    expect(cookie?.httpOnly).toBe(false);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", target.code);
    await expect(page).toHaveTitle(pageTitleIn(target.code, "help"));
  });

  test("Keluar in the account menu signs out through the hidden form", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await noJobs(page);
    await login(page, "/bantuan");
    await accountButton(page).click();
    await Promise.all([
      page.waitForURL((url) => url.pathname === "/login"),
      page.getByRole("menuitem", { name: L("shell.account.logout"), exact: true }).click(),
    ]);
    // The session is gone: a signed-in page sends the browser back to the login.
    await page.goto("/bantuan");
    await expect(page).toHaveURL(/\/login/);
  });

  test("on a phone Menu opens the drawer, Escape closes it and focus goes back to Menu", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await noJobs(page);
    await login(page, "/bantuan");
    const menu = menuButton(page);
    await expect(menu).toBeVisible();
    await expectTarget(menu, "Menu");
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await expect(nav(page)).toBeHidden();
    expect(await overflow(page)).toBeLessThanOrEqual(0);

    await menu.click();
    await expect(drawer(page)).toBeVisible();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    await expect(nav(page)).toHaveCount(1);
    await expect(drawer(page).getByRole("navigation", { name: L("aria.mainMenu") })).toBeVisible();
    // Focus moves into the drawer (React Aria focuses the dialog), and the first Tab is Buat klip.
    await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);
    await page.keyboard.press("Tab");
    await expect(nav(page).getByRole("link", { name: L("shell.nav.create"), exact: true })).toBeFocused();
    await expect(nav(page).getByRole("link", { name: L("shell.nav.help"), exact: true })).toHaveAttribute("aria-current", "page");
    for (const key of LINKS) await expectTarget(nav(page).getByRole("link", { name: L(key), exact: true }), key);
    await expectTarget(drawer(page).getByRole("button", { name: L("aria.close"), exact: true }), "Tutup");
    // The page behind the drawer takes no focus while it is open.
    expect(await inert(page)).toBe(true);
    expect(await overflow(page)).toBeLessThanOrEqual(0);

    await page.keyboard.press("Escape");
    await expect(drawer(page)).toBeHidden();
    await expect(nav(page)).toBeHidden();
    await expect(menu).toBeFocused();
    expect(await inert(page)).toBe(false);

    // The Tutup button and a tap beside the drawer close it too.
    await menu.click();
    await drawer(page).getByRole("button", { name: L("aria.close"), exact: true }).click();
    await expect(drawer(page)).toBeHidden();
    await expect(menu).toBeFocused();
    await menu.click();
    await expect(drawer(page)).toBeVisible();
    await page.mouse.click(380, 600);
    await expect(drawer(page)).toBeHidden();
    expect(await inert(page)).toBe(false);
  });

  test("on a phone the account menu lives in the drawer", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await noJobs(page);
    await login(page, "/bantuan");
    await menuButton(page).click();
    const account = drawer(page).getByRole("button", { name: L("shell.account.named", { name: settings.username }), exact: true });
    await expectTarget(account, "account button");
    await account.click();
    await expect(shortcutsItem(page)).toBeVisible();
    await expect(page.getByRole("menuitem", { name: L("shell.account.logout"), exact: true })).toBeInViewport();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toBeHidden();
    await expect(drawer(page)).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  test("a drawer left open closes when the window grows past 1024 px", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 900 });
    await noJobs(page);
    await login(page, "/bantuan");
    await menuButton(page).click();
    await expect(drawer(page)).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(drawer(page)).toBeHidden();
    await expect(nav(page)).toBeVisible();
    expect(await inert(page)).toBe(false);
  });

  test("the skip link is the first stop and jumps to the page", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await noJobs(page);
    await login(page, "/bantuan");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: L("shell.skip") });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#konten$/);
  });
});
