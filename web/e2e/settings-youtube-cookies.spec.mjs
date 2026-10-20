// Pengaturan "Cookies YouTube" (docs/operations/UNDUHAN_YOUTUBE.md). /api/settings/youtube-cookies
// is faked in the browser (page.route), so nothing on the server changes; the AI form keeps
// talking to the server. Every cookie value here is a plain made-up word.
import { expect, test as base } from "@playwright/test";

import { login, skipWithoutCredentials, test } from "./support/harness.mjs";

const ENDPOINT = "**/api/settings/youtube-cookies";
const UPLOADED_AT = "2026-10-21T08:00:00.000Z";
const FILE = Buffer.from([
  "# Netscape HTTP Cookie File",
  [".youtube.com", "TRUE", "/", "TRUE", "4102444800", "LOGIN_INFO", "nilai-login-uji"].join("\t"),
  "",
].join("\n"));
const STORED = { count: 42, signedIn: true, uploadedAt: UPLOADED_AT };

/** Fakes the cookies API: GET answers `state`, POST and DELETE change it. */
async function fakeCookies(page, state, { post = null } = {}) {
  const seen = { posts: [], deletes: 0 };
  await page.route(ENDPOINT, async (route) => {
    const request = route.request();
    const method = request.method();
    if (method === "POST") {
      seen.posts.push({ headers: request.headers(), body: request.postDataBuffer() });
      const answer = post ?? { status: 200, body: { cookies: STORED, skipped: { otherSites: 120, expired: 1, invalid: 0 }, problem: null, secretConfigured: true } };
      if (answer.status < 300) Object.assign(state, { cookies: answer.body.cookies, problem: null });
      return route.fulfill({ status: answer.status, contentType: "application/json", body: JSON.stringify(answer.body) });
    }
    if (method === "DELETE") {
      seen.deletes += 1;
      Object.assign(state, { cookies: null, problem: null });
    }
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "Cache-Control": "no-store" }, body: JSON.stringify(state) });
  });
  return seen;
}

const card = (page) => page.getByRole("region", { name: "Cookies YouTube" });

test.describe("Cookies YouTube", () => {
  test.beforeEach(() => skipWithoutCredentials(test));

  test("upload, see the count, replace and remove the cookies", async ({ page }) => {
    const seen = await fakeCookies(page, { cookies: null, problem: null, secretConfigured: true });
    await login(page, "/settings");
    const section = card(page);
    await section.scrollIntoViewIfNeeded();
    await expect(section.getByText("Belum ada cookies")).toBeVisible();
    await expect(section).toContainText("akun Google terpisah");
    await section.locator('input[type="file"]').setInputFiles({ name: "cookies.txt", mimeType: "text/plain", buffer: FILE });
    await expect(section.getByRole("status")).toHaveText("42 cookie YouTube tersimpan. Dibuang: 120 dari situs lain, 1 kedaluwarsa.");
    await expect(section.getByText("42 cookie tersimpan")).toBeVisible();
    await expect(section).toContainText("Diunggah");
    expect(seen.posts).toHaveLength(1);
    expect(seen.posts[0].headers["content-type"]).toBe("text/plain");
    expect(seen.posts[0].body.equals(FILE)).toBe(true);
    await expect(section.getByRole("button", { name: "Ganti file" })).toBeEnabled();
    const remove = section.getByRole("button", { name: "Hapus" });
    await remove.focus();
    await page.keyboard.press("Enter");
    await expect(section.getByText("Belum ada cookies")).toBeVisible();
    expect(seen.deletes).toBe(1);
  });

  test("a file over 1 MB is refused before it is sent", async ({ page }) => {
    const seen = await fakeCookies(page, { cookies: null, problem: null, secretConfigured: true });
    await login(page, "/settings");
    const section = card(page);
    await section.locator('input[type="file"]').setInputFiles({ name: "cookies.txt", mimeType: "text/plain", buffer: Buffer.alloc(1024 * 1024 + 1, 0x41) });
    await expect(section.getByRole("alert")).toHaveText("File terlalu besar. Maksimal 1 MB.");
    expect(seen.posts).toHaveLength(0);
  });

  test("cookies without a login cookie get a warning", async ({ page }) => {
    await fakeCookies(page, { cookies: { ...STORED, count: 3, signedIn: false }, problem: null, secretConfigured: true });
    await login(page, "/settings");
    await expect(card(page)).toContainText("Tidak ada cookie login di file ini.");
  });

  test("without the sealing secret the card says so and keeps upload off", async ({ page }) => {
    await fakeCookies(page, { cookies: null, problem: null, secretConfigured: false });
    await login(page, "/settings");
    const section = card(page);
    await expect(section.getByRole("alert")).toContainText("Kunci enkripsi pengaturan belum tersedia");
    await expect(section.getByRole("button", { name: "Pilih file" })).toBeDisabled();
  });

  test("stored cookies that no longer open ask for a new upload and stay removable", async ({ page }) => {
    await fakeCookies(page, { cookies: STORED, problem: "unreadable", secretConfigured: true });
    await login(page, "/settings");
    const section = card(page);
    await expect(section.getByRole("alert")).toHaveText("Cookies tersimpan tidak bisa dibuka. Unggah ulang.");
    await expect(section.getByRole("button", { name: "Hapus" })).toBeEnabled();
  });
});

// A refused upload and a failed load answer 4xx/5xx on purpose, so these run without the
// harness's API-error check.
base.describe("Cookies YouTube refusals", () => {
  base.beforeEach(() => skipWithoutCredentials(base));

  base("a JSON export is refused with its reason and the stored cookies stay", async ({ page }) => {
    await fakeCookies(page, { cookies: STORED, problem: null, secretConfigured: true }, {
      post: { status: 422, body: { error: "File ini berformat JSON, bukan cookies.txt.", code: "cookies_json" } },
    });
    await login(page, "/settings");
    const section = card(page);
    await section.locator('input[type="file"]').setInputFiles({ name: "cookies.json", mimeType: "application/json", buffer: Buffer.from("[]") });
    await expect(section.getByRole("alert")).toHaveText("File ini berformat JSON. Ekspor ulang sebagai cookies.txt (format Netscape).");
    await expect(section.getByText("42 cookie tersimpan")).toBeVisible();
  });

  base("a failed load says so, and Coba lagi loads the card", async ({ page }) => {
    let calls = 0;
    await page.route(ENDPOINT, (route) => {
      calls += 1;
      const body = calls === 1 ? { error: "x", code: "settings_unavailable" } : { cookies: null, problem: null, secretConfigured: true };
      return route.fulfill({ status: calls === 1 ? 503 : 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    await login(page, "/settings");
    const section = card(page);
    await expect(section.getByRole("alert")).toHaveText(/Cookies YouTube tidak bisa dimuat\./);
    await section.getByRole("button", { name: "Coba lagi" }).click();
    await expect(section.getByText("Belum ada cookies")).toBeVisible();
    expect(calls).toBe(2);
  });
});

test.describe("Cookies YouTube at 390 px", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test.beforeEach(() => skipWithoutCredentials(test));

  test("fits the phone: no horizontal scroll, buttons at least 44 px tall", async ({ page }) => {
    await fakeCookies(page, { cookies: { ...STORED, count: 12345 }, problem: null, secretConfigured: true });
    await login(page, "/settings");
    const section = card(page);
    await section.scrollIntoViewIfNeeded();
    await expect(section.getByRole("button", { name: "Hapus" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    for (const box of await section.getByRole("button").evaluateAll((items) => items.map((item) => item.getBoundingClientRect().toJSON()))) {
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.right).toBeLessThanOrEqual(390);
    }
  });
});
