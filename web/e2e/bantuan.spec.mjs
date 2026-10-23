import { expect } from "@playwright/test";

import { HELP_ENTRIES } from "../lib/help-catalog.mjs";
import { login, settings, skipWithoutCredentials, test } from "./support/harness.mjs";

// The help page (/bantuan, docs/operations/BANTUAN.md). Read-only: the page needs no server
// data, and the project page's job is faked inside the browser (page.route), so nothing is
// created or changed; only the login is real. Run against a production build (`npm run build`
// then `next start`), like e2e/focus.spec.mjs.

const FAILED_JOB_ID = "7c2e4f50-6172-4c8d-9e0f-a1b2c3d4e5f6";
const BOT_CHECK_LINE = "ERROR: [youtube] AbCdEfGhIjK: Sign in to confirm you’re not a bot. This helps protect our community.";

const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const focusedId = (page) => page.evaluate(() => document.activeElement?.id ?? null);

// The search is a client component: typing before hydration would be lost.
async function openHelp(page) {
  await login(page, "/bantuan");
  await expect(page.getByRole("heading", { level: 1, name: "Bantuan" })).toBeVisible();
  await page.waitForFunction(() => document.querySelector("#bantuan-q") && Object.keys(document.querySelector("#bantuan-q")).some((key) => key.startsWith("__react")));
}

test.describe("Bantuan", () => {
  test.beforeEach(() => skipWithoutCredentials(test));

  test("a pasted yt-dlp line opens its entry: the address names it, the entry is marked and takes the focus", async ({ page }) => {
    await openHelp(page);
    await expect(page.getByRole("link", { name: "Bantuan", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.locator("article")).toHaveCount(HELP_ENTRIES.length);

    await page.getByLabel("Pesan error").fill(BOT_CHECK_LINE);
    await page.getByLabel("Pesan error").press("Enter");
    await expect(page).toHaveURL(/\/bantuan#download_bot_check$/);
    await expect.poll(() => focusedId(page)).toBe("download_bot_check");
    await expect(page.locator("article:target")).toHaveAttribute("id", "download_bot_check");
    await expect(page.locator("#bantuan-q-hasil")).toHaveText("Paling cocok: YouTube menahan unduhan dari server");
    await expect(page.getByRole("article", { name: "YouTube menahan unduhan dari server" })).toBeInViewport();

    // A code alone, then a text nothing fits: the line says so and the focus stays in the box.
    await page.getByLabel("Pesan error").fill("GAGAL [quota_exhausted]: Kuota habis");
    await page.getByRole("button", { name: "Cari" }).click();
    await expect(page).toHaveURL(/\/bantuan#llm_quota_exhausted$/);
    await page.getByLabel("Pesan error").fill("halo apa kabar");
    await page.getByLabel("Pesan error").press("Enter");
    await expect(page.locator("#bantuan-q-hasil")).toHaveText(/Belum ada entri yang cocok/);
    expect(await focusedId(page)).toBe("bantuan-q");
  });

  test("anchors and the search work without JavaScript", async ({ browser }) => {
    // Reduced motion: after the anchor jump the search button is far above the view, and the page's
    // smooth scrolling (html { scroll-behavior: smooth }) animates every scroll Playwright makes
    // to reach it, so the button never holds still for the click.
    const context = await browser.newContext({ baseURL: settings.baseURL, javaScriptEnabled: false, reducedMotion: "reduce" });
    const page = await context.newPage();
    try {
      await login(page, "/bantuan");
      // Another code of an entry is an anchor too.
      await page.goto("/bantuan#storage_admission_lost");
      await expect(page.locator("article:has(:target)")).toHaveAttribute("id", "storage_admission_unavailable");

      await page.getByLabel("Pesan error").fill(BOT_CHECK_LINE);
      await page.getByRole("button", { name: "Cari" }).click();
      await expect(page).toHaveURL(/\/bantuan#download_bot_check$/);
      await expect(page.locator("article:target")).toHaveAttribute("id", "download_bot_check");

      await page.goto(`/bantuan?q=${encodeURIComponent("halo apa kabar")}`);
      await expect(page.locator("#bantuan-q-hasil")).toHaveText(/Belum ada entri yang cocok/);
      await expect(page.getByLabel("Pesan error")).toHaveValue("halo apa kabar");
    } finally {
      await context.close();
    }
  });

  test("a failed download on the project page links to its entry", async ({ page }) => {
    const job = {
      id: FAILED_JOB_ID, status: "failed", progress: 100, stage: "failed", errorCode: "download_bot_check",
      stageDetail: "YouTube sedang menahan unduhan dari server ini.", error: "[youtube] AbCdEfGhIjK: Sign in to confirm you’re not a bot.",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      source: { type: "youtube", url: "https://www.youtube.com/watch?v=AbCdEfGhIjK" }, options: {}, clips: [],
    };
    await page.route(new RegExp(`/api/jobs/${FAILED_JOB_ID}(?:/.*)?$`), (route) => {
      const { pathname } = new URL(route.request().url());
      const body = pathname.endsWith("/clips") ? { clips: [] } : { job };
      return route.fulfill({ status: 200, contentType: "application/json", headers: { "Cache-Control": "no-store" }, body: JSON.stringify(body) });
    });
    await login(page, "/projects");
    await page.goto(`/projects/${FAILED_JOB_ID}`);
    const help = page.getByRole("link", { name: "Cara memperbaiki" });
    await expect(help).toHaveAttribute("href", "/bantuan#download_bot_check");
    await help.click();
    await expect(page).toHaveURL(/\/bantuan#download_bot_check$/);
    await expect(page.locator("article:target")).toHaveAttribute("id", "download_bot_check");
  });
});

test.describe("Bantuan at 390 px", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test.beforeEach(() => skipWithoutCredentials(test));

  test("no horizontal scroll; the search and the group links are reachable by keyboard", async ({ page }) => {
    await openHelp(page);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await page.getByLabel("Pesan error").focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Cari" })).toBeFocused();
    // The Panduan topics come before the error groups.
    await page.keyboard.press("Tab");
    await expect(page.getByRole("navigation", { name: "Topik panduan" }).getByRole("link", { name: "Membuat klip pertama" })).toBeFocused();
    const group = page.getByRole("navigation", { name: "Kelompok bantuan" }).getByRole("link", { name: /^Unduhan YouTube/ });
    let reached = false;
    for (let step = 0; step < 60 && !reached; step += 1) {
      await page.keyboard.press("Tab");
      reached = await group.evaluate((element) => element === document.activeElement);
    }
    expect(reached).toBe(true);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#grup-unduhan$/);
    await page.goto("/bantuan#llm_context_length");
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });
});
