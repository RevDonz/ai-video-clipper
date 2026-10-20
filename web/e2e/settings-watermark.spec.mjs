// Pengaturan "Teks watermark bawaan" (docs/editor/CONTRACTS.md §5.43). /api/settings/watermark is
// faked in the browser (page.route), so nothing on the server changes; the AI form keeps talking
// to the server.
import { expect, test as base } from "@playwright/test";

import { login, skipWithoutCredentials, test } from "./support/harness.mjs";

const MARK = { text: "@potongin.klip", pos: "bottom_right", size_pm: 1200, opacity_pm: 700, updatedAtMs: 1_790_000_000_000 };

/** Fakes the settings watermark API: GET answers `state`, PUT and DELETE change it. */
async function fakeWatermark(page, state) {
  const seen = { puts: [], deletes: 0 };
  await page.route("**/api/settings/watermark", async (route) => {
    const method = route.request().method();
    if (method === "PUT") {
      const body = route.request().postDataJSON();
      seen.puts.push(body);
      state.watermark = { ...body, updatedAtMs: 1_790_000_000_001 };
    } else if (method === "DELETE") {
      seen.deletes += 1;
      state.watermark = null;
    }
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "Cache-Control": "no-store" }, body: JSON.stringify(state) });
  });
  return seen;
}

const card = (page) => page.getByRole("region", { name: "Teks watermark bawaan" });

test.describe("Teks watermark bawaan", () => {
  test.beforeEach(() => skipWithoutCredentials(test));

  test("type, place, size and fade it, save, then remove it", async ({ page }) => {
    const seen = await fakeWatermark(page, { watermark: null, autoClips: false });
    await login(page, "/settings");
    const section = card(page);
    await section.scrollIntoViewIfNeeded();
    await expect(section).toContainText("File klip otomatis tetap tanpa teks watermark");
    const text = section.getByRole("textbox", { name: "Teks" });
    await expect(text).toHaveValue("");
    await expect(section.getByRole("combobox", { name: "Posisi" })).toHaveValue("top_center");
    // An empty text is refused on the page, before anything is sent.
    await section.getByRole("button", { name: "Simpan" }).click();
    await expect(section.getByRole("alert")).toHaveText("Tulis teks watermark dulu.");
    expect(seen.puts).toHaveLength(0);
    await text.fill("  @potongin.klip ");
    await expect(section).toContainText("14/40 karakter");
    await section.getByRole("combobox", { name: "Posisi" }).selectOption({ label: "Kanan bawah" });
    const size = section.getByRole("slider", { name: /Ukuran/ });
    await size.focus();
    for (let step = 0; step < 4; step += 1) await page.keyboard.press("ArrowRight");
    await expect(section).toContainText("Ukuran 120%");
    const opacity = section.getByRole("slider", { name: /Opasitas/ });
    await opacity.focus();
    for (let step = 0; step < 15; step += 1) await page.keyboard.press("ArrowLeft");
    await expect(section).toContainText("Opasitas 70%");
    await section.getByRole("button", { name: "Simpan" }).click();
    await expect(section.getByRole("status")).toHaveText("Teks watermark bawaan tersimpan.");
    expect(seen.puts).toEqual([{ text: "@potongin.klip", pos: "bottom_right", size_pm: 1200, opacity_pm: 700 }]);
    await expect(section.getByRole("button", { name: "Simpan" })).toBeDisabled();
    const remove = section.getByRole("button", { name: "Hapus" });
    await remove.focus();
    await page.keyboard.press("Enter");
    await expect(section.getByRole("status")).toContainText("Teks watermark bawaan dihapus.");
    await expect(text).toHaveValue("");
    expect(seen.deletes).toBe(1);
  });

  test("a saved watermark fills the form; with automatic clips on the editor's engine the copy says they carry it", async ({ page }) => {
    await fakeWatermark(page, { watermark: MARK, autoClips: true });
    await login(page, "/settings");
    const section = card(page);
    await expect(section.getByRole("textbox", { name: "Teks" })).toHaveValue("@potongin.klip");
    await expect(section.getByRole("combobox", { name: "Posisi" })).toHaveValue("bottom_right");
    await expect(section).toContainText("Ukuran 120%");
    await expect(section).toContainText("Opasitas 70%");
    await expect(section).toContainText("Ikut di file klip otomatis");
    await expect(section).not.toContainText("tanpa teks watermark");
  });
});

// A faked 500 is the point of this test, so it runs without the harness's API-error check.
base.describe("Teks watermark bawaan after a failed load", () => {
  base.beforeEach(() => skipWithoutCredentials(base));

  base("says so, and Coba lagi loads the card", async ({ page }) => {
    let calls = 0;
    await page.route("**/api/settings/watermark", (route) => {
      calls += 1;
      const body = calls === 1 ? { error: "x", code: "settings_unavailable" } : { watermark: null, autoClips: false };
      return route.fulfill({ status: calls === 1 ? 503 : 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    await login(page, "/settings");
    const section = card(page);
    await expect(section.getByRole("alert")).toHaveText(/Teks watermark bawaan tidak bisa dimuat\./);
    await section.getByRole("button", { name: "Coba lagi" }).click();
    await expect(section.getByRole("textbox", { name: "Teks" })).toBeVisible();
    expect(calls).toBe(2);
  });
});

test.describe("Teks watermark bawaan at 390 px", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test.beforeEach(() => skipWithoutCredentials(test));

  test("fits the phone: no horizontal scroll, controls at least 44 px tall", async ({ page }) => {
    await fakeWatermark(page, { watermark: { ...MARK, text: "x".repeat(40) }, autoClips: false });
    await login(page, "/settings");
    const section = card(page);
    await section.scrollIntoViewIfNeeded();
    await expect(section.getByRole("button", { name: "Hapus" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    const controls = section.locator("button, input, select");
    for (const box of await controls.evaluateAll((items) => items.map((item) => item.getBoundingClientRect().toJSON()))) {
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.right).toBeLessThanOrEqual(390);
    }
  });
});
