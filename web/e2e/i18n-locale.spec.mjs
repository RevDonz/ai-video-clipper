import { expect } from "@playwright/test";

import { login, settings, test } from "./support/harness.mjs";
import { pageTitle } from "./support/i18n.mjs";

// The UI language of a request (rombak 07 §5, §8): the potongin_locale cookie the harness sets
// (id in desktop-chromium, en in en-smoke), else Accept-Language, else id. <html lang> and the
// page titles follow it, and no shared cache may keep a page in one language for everyone.

test.describe("UI language", () => {
  test("the login page opens in the project's language and is not cacheable", async ({ page, uiLocale }) => {
    const response = await page.goto("/login");
    expect(response?.status()).toBe(200);
    await expect(page.locator("html")).toHaveAttribute("lang", uiLocale);
    await expect(page).toHaveTitle(pageTitle(uiLocale, "login"));
    const headers = response.headers();
    expect(headers["cache-control"]).toMatch(/\bprivate\b/);
    expect(headers["cache-control"]).toMatch(/\bno-store\b/);
    expect(headers.vary ?? "").toMatch(/\bCookie\b/i);
    expect(headers.vary ?? "").toMatch(/\bAccept-Language\b/i);
  });

  test("after signing in the dashboard keeps the language", async ({ page, uiLocale }) => {
    test.skip(settings.allowSkip && (!settings.username || !settings.password), "Explicit local safety mode: credentials are absent and E2E_ALLOW_SKIP=1");
    await login(page, "/dashboard");
    await expect(page.locator("html")).toHaveAttribute("lang", uiLocale);
    await expect(page).toHaveTitle(pageTitle(uiLocale, "dashboard"));
  });

  test("a visitor without the cookie follows Accept-Language, with \"in\" as Indonesian", async ({ browser, baseURL }, testInfo) => {
    test.skip(testInfo.project.name !== "en-smoke", "needs a server with POTONGIN_LOCALES=id,en (the en-smoke run)");
    for (const [header, expected] of [["en-GB,en;q=0.9", "en"], ["ms-MY,in;q=0.8", "id"], ["fr-FR", "id"], ["en;q=0, id", "id"]]) {
      const context = await browser.newContext({ baseURL, locale: "en-US", extraHTTPHeaders: { "Accept-Language": header } });
      try {
        const page = await context.newPage();
        await page.goto("/login");
        await expect(page.locator("html"), header).toHaveAttribute("lang", expected);
        await expect(page, header).toHaveTitle(pageTitle(expected, "login"));
      } finally {
        await context.close();
      }
    }
  });

  test("the cookie wins over Accept-Language", async ({ browser, baseURL }, testInfo) => {
    test.skip(testInfo.project.name !== "en-smoke", "needs a server with POTONGIN_LOCALES=id,en (the en-smoke run)");
    const context = await browser.newContext({ baseURL, extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" } });
    try {
      await context.addCookies([{ name: "potongin_locale", value: "id", url: baseURL, sameSite: "Lax", secure: baseURL.startsWith("https:") }]);
      const page = await context.newPage();
      await page.goto("/login");
      await expect(page.locator("html")).toHaveAttribute("lang", "id");
    } finally {
      await context.close();
    }
  });
});
