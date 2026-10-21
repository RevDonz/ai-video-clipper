// Pengaturan "Tentang sistem" (docs/editor/CONTRACTS.md §5.34). GET /api/settings/system is faked
// in the browser (page.route), so the values are fixed; the AI form keeps talking to the server.
// Optional: AXE_CORE_PATH=<axe.min.js> runs axe on the section (skipped without it).
import { expect } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";

import { expectFailedRequest, login, skipWithoutCredentials, test } from "./support/harness.mjs";

const INFO = { ytDlp: "2026.8.19", ffmpeg: null, libass: null, whisperModel: "small", whisperModelCustom: false, commit: "becb712" };
const AXE = process.env.AXE_CORE_PATH && existsSync(process.env.AXE_CORE_PATH) ? readFileSync(process.env.AXE_CORE_PATH, "utf8") : null;

/** Answers the route with `answers` in turn (the last one repeats); returns the call count. */
async function fakeSystem(page, answers) {
  const calls = { count: 0 };
  await page.route("**/api/settings/system", (route) => {
    const answer = answers[Math.min(calls.count, answers.length - 1)];
    calls.count += 1;
    return route.fulfill({ status: answer.status, contentType: "application/json", headers: { "Cache-Control": "no-store" }, body: JSON.stringify(answer.body) });
  });
  return calls;
}

const section = (page) => page.getByRole("region", { name: "Tentang sistem" });

test.describe("Tentang sistem", () => {
  test.beforeEach(() => skipWithoutCredentials(test));

  test("shows the five values, unknown ones as 'tidak diketahui'", async ({ page }) => {
    await fakeSystem(page, [{ status: 200, body: INFO }]);
    await login(page, "/settings");
    const about = section(page);
    await about.scrollIntoViewIfNeeded();
    await expect(about.locator("dt")).toHaveText([/^yt-dlp/, /^FFmpeg/, /^libass/, /^Whisper/, /^Build/]);
    await expect(about.locator("dd")).toHaveText(["2026.8.19", "tidak diketahui", "tidak diketahui", "small", "becb712"]);
    await expect(about.getByRole("button")).toHaveCount(0);
  });

  test("axe finds nothing serious in the section", async ({ page }) => {
    test.skip(!AXE, "set AXE_CORE_PATH to an axe.min.js");
    await fakeSystem(page, [{ status: 200, body: INFO }]);
    await login(page, "/settings");
    await expect(section(page).locator("dd")).toHaveCount(5);
    await page.addScriptTag({ content: AXE });
    const violations = await page.evaluate(async () => {
      const target = document.querySelector('[aria-labelledby="system-title"]');
      const result = await window.axe.run(target, { resultTypes: ["violations"] });
      return result.violations.filter((item) => ["serious", "critical"].includes(item.impact)).map((item) => item.id);
    });
    expect(violations).toEqual([]);
  });
});

test.describe("Tentang sistem after a failed load", () => {
  test.beforeEach(() => skipWithoutCredentials(test));

  test("says so, and Coba lagi loads the values", async ({ page }) => {
    expectFailedRequest(page, 500, "GET", "/api/settings/system"); // the first load fails on purpose
    const calls = await fakeSystem(page, [
      { status: 500, body: { error: "Info sistem tidak bisa dibaca", code: "system_info_failed" } },
      { status: 200, body: INFO },
    ]);
    await login(page, "/settings");
    const about = section(page);
    await expect(about.getByRole("alert")).toHaveText(/Info sistem tidak bisa dimuat\./);
    const retry = about.getByRole("button", { name: "Coba lagi" });
    await retry.focus();
    await page.keyboard.press("Enter");
    await expect(about.locator("dd").first()).toHaveText("2026.8.19");
    expect(calls.count).toBe(2);
  });
});

test.describe("Tentang sistem at 390 px", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test.beforeEach(() => skipWithoutCredentials(test));

  test("fits the phone: no horizontal scroll, every value inside the screen", async ({ page }) => {
    await fakeSystem(page, [{ status: 200, body: { ...INFO, ytDlp: "2026.08.19.232845.dev0" } }]);
    await login(page, "/settings");
    const values = section(page).locator("dd");
    await expect(values).toHaveCount(5);
    await section(page).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    for (const box of await values.evaluateAll((items) => items.map((item) => item.getBoundingClientRect().toJSON()))) {
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(390);
    }
  });
});
