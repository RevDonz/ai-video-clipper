import { expect } from "@playwright/test";

import { downloadErrorMessage } from "../lib/download-errors.mjs";
import { HELP_ENTRIES } from "../lib/help-catalog.mjs";
import { LOCALE_COOKIE, login, settings, skipWithoutCredentials, test } from "./support/harness.mjs";
import { L } from "./support/i18n.mjs";

// The help page (/bantuan, docs/operations/BANTUAN.md), in the project's UI language: every
// name and text comes from the catalog through L(). Read-only: the page needs no server data,
// and the project page's job is faked inside the browser (page.route), so nothing is created or
// changed; only the login is real. Run against a production build (`npm run build` then
// `next start`), like e2e/focus.spec.mjs.

const FAILED_JOB_ID = "7c2e4f50-6172-4c8d-9e0f-a1b2c3d4e5f6";
const BOT_CHECK_LINE = "ERROR: [youtube] AbCdEfGhIjK: Sign in to confirm you’re not a bot. This helps protect our community.";
// The Indonesian message the pages show for a bot check: found whatever the UI language is.
const BOT_CHECK_ID = downloadErrorMessage("download_bot_check").text;

const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const focusedId = (page) => page.evaluate(() => document.activeElement?.id ?? null);
const startsWith = (text) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
const searchBox = (page) => page.getByRole("searchbox", { name: L("help.search.label") });
const searchButton = (page) => page.getByRole("button", { name: L("help.search.submit"), exact: true });
const topicButton = (page, id) => page.getByRole("button", { name: L(`help.guide.topics.${id}.title`), exact: true });

// The search is a client component: typing before hydration would be lost.
async function openHelp(page, path = "/bantuan") {
  await login(page, path);
  await expect(page.getByRole("heading", { level: 1, name: L("help.title") })).toBeVisible();
  await page.waitForFunction(() => document.querySelector("#bantuan-q") && Object.keys(document.querySelector("#bantuan-q")).some((key) => key.startsWith("__react")));
}

test.describe("Bantuan", () => {
  test.beforeEach(() => skipWithoutCredentials(test));

  test("a pasted yt-dlp line opens its entry: the address names it, the entry is marked and takes the focus", async ({ page }) => {
    await openHelp(page);
    await expect(page.getByRole("link", { name: L("shell.nav.help"), exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.locator("article")).toHaveCount(HELP_ENTRIES.length);

    const title = L("help.entries.download_bot_check.title");
    await searchBox(page).fill(BOT_CHECK_LINE);
    await searchBox(page).press("Enter");
    await expect(page).toHaveURL(/\/bantuan#download_bot_check$/);
    await expect.poll(() => focusedId(page)).toBe("download_bot_check");
    await expect(page.locator("article:target")).toHaveAttribute("id", "download_bot_check");
    await expect(page.locator("#bantuan-q-hasil")).toHaveText(`${L("help.search.best")} ${title}`);
    await expect(page.getByRole("article", { name: title })).toBeInViewport();

    // A code alone, then a text nothing fits: the line says so and the focus stays in the box.
    await searchBox(page).fill("GAGAL [quota_exhausted]: Kuota habis");
    await searchButton(page).click();
    await expect(page).toHaveURL(/\/bantuan#llm_quota_exhausted$/);
    await searchBox(page).fill("halo apa kabar");
    await searchBox(page).press("Enter");
    await expect(page.locator("#bantuan-q-hasil")).toHaveText(L("help.search.noMatch"));
    expect(await focusedId(page)).toBe("bantuan-q");
  });

  test("the Indonesian message of a code is found in every UI language", async ({ page }) => {
    await openHelp(page);
    await searchBox(page).fill(BOT_CHECK_ID);
    await searchButton(page).click();
    await expect(page).toHaveURL(/\/bantuan#download_bot_check$/);
    await expect(page.locator("article:target")).toHaveAttribute("id", "download_bot_check");
  });

  test("the guide topics are folded; the one the address names opens by itself, the others on a press", async ({ page }) => {
    await openHelp(page, "/bantuan#editor");
    await expect(topicButton(page, "editor")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText(L("help.guide.topics.editor.intro"))).toBeVisible();
    await expect(topicButton(page, "mulai")).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByText(L("help.guide.topics.mulai.intro"))).toBeHidden();
    await topicButton(page, "mulai").click();
    await expect(page.getByText(L("help.guide.topics.mulai.intro"))).toBeVisible();
    // A later #topic link opens its topic too.
    await page.evaluate(() => { window.location.hash = "tren"; });
    await expect(topicButton(page, "tren")).toHaveAttribute("aria-expanded", "true");
    // The error entries never fold.
    await expect(page.getByRole("article", { name: L("help.entries.llm_http.title") })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: L("help.shortcuts.title") })).toBeVisible();
  });

  test("anchors, the guide and the search work without JavaScript", async ({ browser, uiLocale }) => {
    // Reduced motion: after the anchor jump the search button is far above the view, and the page's
    // smooth scrolling (html { scroll-behavior: smooth }) animates every scroll Playwright makes
    // to reach it, so the button never holds still for the click.
    const context = await browser.newContext({ baseURL: settings.baseURL, javaScriptEnabled: false, reducedMotion: "reduce" });
    if (uiLocale) await context.addCookies([{ name: LOCALE_COOKIE, value: uiLocale, url: new URL(settings.baseURL).origin, sameSite: "Lax", secure: settings.baseURL.startsWith("https:") }]);
    const page = await context.newPage();
    try {
      await login(page, "/bantuan");
      // Another code of an entry is an anchor too.
      await page.goto("/bantuan#storage_admission_lost");
      await expect(page.locator("article:has(:target)")).toHaveAttribute("id", "storage_admission_unavailable");
      // Without JS the guide reads open.
      await expect(page.getByText(L("help.guide.topics.mulai.intro"))).toBeVisible();

      await searchBox(page).fill(BOT_CHECK_LINE);
      await searchButton(page).click();
      await expect(page).toHaveURL(/\/bantuan#download_bot_check$/);
      await expect(page.locator("article:target")).toHaveAttribute("id", "download_bot_check");

      await page.goto(`/bantuan?q=${encodeURIComponent(BOT_CHECK_ID)}`);
      await expect(page).toHaveURL(/\/bantuan#download_bot_check$/);

      await page.goto(`/bantuan?q=${encodeURIComponent("halo apa kabar")}`);
      await expect(page.locator("#bantuan-q-hasil")).toHaveText(L("help.search.noMatch"));
      await expect(searchBox(page)).toHaveValue("halo apa kabar");
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

  test("no horizontal scroll; the search, the guide and the group links are reachable by keyboard", async ({ page }) => {
    await openHelp(page);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await searchBox(page).focus();
    await page.keyboard.press("Tab");
    await expect(searchButton(page)).toBeFocused();
    // The Panduan topics come before the error groups.
    await page.keyboard.press("Tab");
    await expect(topicButton(page, "mulai")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(topicButton(page, "mulai")).toHaveAttribute("aria-expanded", "true");
    const group = page.getByRole("navigation", { name: L("help.errors.groups") }).getByRole("link", { name: startsWith(L("help.groups.unduhan.title")) });
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
    await page.goto("/bantuan#pintasan");
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });
});
