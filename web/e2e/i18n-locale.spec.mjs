import { expect } from "@playwright/test";

import { login, settings, test } from "./support/harness.mjs";
import { pageTitle } from "./support/i18n.mjs";

// The UI language of a request (rombak 07 §5, §8): the potongin_locale cookie the harness sets
// (id in desktop-chromium, en in en-smoke), else Accept-Language, else id. <html lang> and the
// page titles follow it, and no cache may keep a page in one language for everyone (Next sets
// Vary itself on app pages, so the guard is Cache-Control: private, no-store).

// Through the HTTP client, not a browser: a browser context sends its own Accept-Language.
async function served(playwright, baseURL, headers) {
  const client = await playwright.request.newContext({ baseURL, extraHTTPHeaders: headers });
  try {
    const response = await client.get("/login");
    expect(response.status()).toBe(200);
    const html = await response.text();
    return { lang: /<html[^>]*\slang="([^"]+)"/.exec(html)?.[1], title: /<title>([^<]*)<\/title>/.exec(html)?.[1] };
  } finally {
    await client.dispose();
  }
}

test.describe("UI language", () => {
  test("the login page opens in the project's language and is not cacheable", async ({ page, uiLocale }) => {
    const response = await page.goto("/login");
    expect(response?.status()).toBe(200);
    await expect(page.locator("html")).toHaveAttribute("lang", uiLocale);
    await expect(page).toHaveTitle(pageTitle(uiLocale, "login"));
    const cacheControl = response.headers()["cache-control"];
    expect(cacheControl).toMatch(/\bprivate\b/);
    expect(cacheControl).toMatch(/\bno-store\b/);
  });

  test("after signing in a page of the app keeps the language", async ({ page, uiLocale }) => {
    test.skip(settings.allowSkip && (!settings.username || !settings.password), "Explicit local safety mode: credentials are absent and E2E_ALLOW_SKIP=1");
    // /bantuan reads no job data itself; the job badge's list is faked.
    await page.route(/\/api\/jobs(?:\?.*)?$/, (route) => route.fulfill({
      status: 200, contentType: "application/json", body: JSON.stringify({ jobs: [], total: 0, editor: false }),
    }));
    await login(page, "/bantuan");
    await expect(page.locator("html")).toHaveAttribute("lang", uiLocale);
    await expect(page).toHaveTitle(pageTitle(uiLocale, "help"));
  });

  test("a visitor without the cookie follows Accept-Language, with \"in\" as Indonesian", async ({ playwright, baseURL }, testInfo) => {
    test.skip(testInfo.project.name !== "en-smoke", "needs a server with POTONGIN_LOCALES=id,en (the en-smoke run)");
    for (const [header, expected] of [["en-GB,en;q=0.9", "en"], ["ms-MY,in;q=0.8", "id"], ["fr-FR", "id"], ["en;q=0, id", "id"]]) {
      const page = await served(playwright, baseURL, { "Accept-Language": header });
      expect(page.lang, header).toBe(expected);
      expect(page.title, header).toBe(pageTitle(expected, "login"));
    }
  });

  test("the cookie wins over Accept-Language", async ({ playwright, baseURL }, testInfo) => {
    test.skip(testInfo.project.name !== "en-smoke", "needs a server with POTONGIN_LOCALES=id,en (the en-smoke run)");
    const indonesian = await served(playwright, baseURL, { "Accept-Language": "en-US,en;q=0.9", Cookie: "potongin_locale=id" });
    expect(indonesian.lang).toBe("id");
    const english = await served(playwright, baseURL, { "Accept-Language": "id-ID,id;q=0.9", Cookie: "potongin_locale=en" });
    expect(english.lang).toBe("en");
  });
});
