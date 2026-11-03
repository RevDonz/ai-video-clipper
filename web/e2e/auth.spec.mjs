// The user database in a browser (rombak 02 §4, §6; 07 §9.4): the session cookie, a logout that
// ends it on the server, the password page and the account's language on a second device. Read-only
// towards projects; the language change is put back.
import { expect } from "@playwright/test";

import { LOCALE_COOKIE, expectFailedRequest, login, settings, skipWithoutCredentials, test } from "./support/harness.mjs";
import { L } from "./support/i18n.mjs";

const S2 = "__Host-potongin_session";
const V1 = "potongin_session";

async function setLanguage(page, locale) {
  return page.evaluate(async (code) => {
    const response = await fetch("/api/locale", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ locale: code }) });
    return response.status;
  }, locale);
}

test.describe("sessions on the server", () => {
  test.beforeEach(() => skipWithoutCredentials(test));

  test("login sets the __Host- cookie, HttpOnly and Secure, and no v1 cookie", async ({ context, page }) => {
    await login(page, "/bantuan");
    const cookies = await context.cookies();
    const session = cookies.find((cookie) => cookie.name === S2);
    expect(session, "the s2 cookie").toBeTruthy();
    expect(session.value).toMatch(/^s2\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    expect(session.httpOnly).toBe(true);
    expect(session.secure).toBe(true);
    expect(session.sameSite).toBe("Lax");
    expect(session.path).toBe("/");
    expect(cookies.some((cookie) => cookie.name === V1)).toBe(false);
  });

  test("Keluar ends the session on the server: the same cookie, replayed, gets a 401", async ({ context, page, request }) => {
    await login(page, "/bantuan");
    const session = (await context.cookies()).find((cookie) => cookie.name === S2);
    await page.evaluate(async () => {
      const form = document.createElement("form");
      form.method = "post";
      form.action = "/api/auth/logout";
      document.body.append(form);
      form.submit();
    });
    await page.waitForURL((url) => url.pathname === "/login" && url.searchParams.get("keluar") === "1");
    expect((await context.cookies()).some((cookie) => cookie.name === S2)).toBe(false);
    // A copy of the cookie, as a thief would hold it, from outside the browser.
    const replay = await request.get("/api/storage/status", { headers: { Cookie: `${S2}=${session.value}` } });
    expect(replay.status()).toBe(401);
  });

  test("after a logout the login page clears this device's editor drafts", async ({ page }) => {
    await page.goto("/login");
    await page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open("potongin-editor", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("drafts", { keyPath: "key" });
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    }));
    const exists = () => page.evaluate(async () => (await indexedDB.databases()).some((item) => item.name === "potongin-editor"));
    expect(await exists()).toBe(true);
    await page.goto("/login?keluar=1");
    await expect.poll(exists).toBe(false);
  });

  test("the password page shows its three fields and refuses a wrong current password, in the page's language", async ({ page }) => {
    await login(page, "/bantuan");
    await page.goto("/akun/kata-sandi");
    await expect(page.getByRole("heading", { level: 1, name: L("auth.password.title") })).toBeVisible();
    await page.getByLabel(L("auth.password.current")).fill("this-is-not-the-password");
    await page.getByLabel(L("auth.password.next"), { exact: true }).fill("a-new-password-for-the-test");
    await page.getByLabel(L("auth.password.repeat")).fill("a-different-password-entirely");
    await page.getByRole("button", { name: L("auth.password.save") }).click();
    await expect(page.locator("form").getByRole("alert")).toHaveText(L("errors.account.password_mismatch"));
    await page.getByLabel(L("auth.password.repeat")).fill("a-new-password-for-the-test");
    expectFailedRequest(page, 403, "POST", "/api/account/password");
    await page.getByRole("button", { name: L("auth.password.save") }).click();
    await expect(page.locator("form").getByRole("alert")).toHaveText(L("errors.account.password_wrong"));
    await expect(page).toHaveURL((url) => url.pathname === "/akun/kata-sandi");
  });
});

test.describe("the account's language", () => {
  test.beforeEach(() => skipWithoutCredentials(test));

  test("a second device gets the language of the account at login", async ({ browser, baseURL, page }, testInfo) => {
    await login(page, "/bantuan");
    // Only where English is switched on (en-smoke); production and the default gate app run id only.
    const second = await page.evaluate(async () => (await fetch("/api/locale", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ locale: "id" }) })).status);
    expect(second).toBe(200);
    test.skip(testInfo.project.name !== "en-smoke", "English is only on in the en-smoke app");
    expect(await setLanguage(page, "en")).toBe(200);
    const device = await browser.newContext({ baseURL, locale: "id-ID" });
    try {
      const other = await device.newPage();
      await other.goto("/login?next=%2Fbantuan");
      await other.locator('input[name="username"]').fill(settings.username);
      await other.locator('input[name="password"]').fill(settings.password);
      await Promise.all([
        other.waitForURL((url) => url.pathname === "/bantuan"),
        other.locator('form[action="/api/auth/login"] button[type="submit"]').click(),
      ]);
      expect((await device.cookies()).find((cookie) => cookie.name === LOCALE_COOKIE)?.value).toBe("en");
      await expect(other.locator("html")).toHaveAttribute("lang", /^en/);
    } finally {
      await device.close();
      expect(await setLanguage(page, testInfo.project.use.uiLocale ?? "id")).toBe(200);
    }
  });
});
