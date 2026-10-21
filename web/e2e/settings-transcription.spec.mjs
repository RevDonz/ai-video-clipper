// Pengaturan "Transkripsi" (docs/operations/TRANSCRIPTION.md, "Transkripsi lewat Groq").
// /api/settings/transcription is faked in the browser (page.route), so nothing on the server
// changes. Every key here is a made-up value.
import { expect } from "@playwright/test";

import { expectFailedRequest, login, skipWithoutCredentials, test } from "./support/harness.mjs";

const ENDPOINT = "**/api/settings/transcription";
const SAVED_AT = "2026-10-21T09:00:00.000Z";
const KEY = "groq-e2e-key-4444dddd";
const OFF = { enabled: false, key: "missing", ownKey: false, llmKey: false, secretConfigured: true, updatedAt: null, problem: null };

/** Fakes the transcription API: GET answers `state`, PUT applies the body like the server. */
async function fakeTranscription(page, state, { put = null } = {}) {
  const seen = { puts: [] };
  await page.route(ENDPOINT, async (route) => {
    const request = route.request();
    if (request.method() === "PUT") {
      const body = request.postDataJSON();
      seen.puts.push(body);
      if (put) return route.fulfill({ status: put.status, contentType: "application/json", body: JSON.stringify(put.body) });
      const action = body.apiKey?.action ?? "keep";
      const ownKey = action === "replace" ? true : action === "clear" ? false : state.ownKey;
      const key = state.llmKey ? "llm" : ownKey ? "own" : "missing";
      Object.assign(state, { enabled: body.enabled, ownKey, key, updatedAt: SAVED_AT });
    }
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "Cache-Control": "no-store" }, body: JSON.stringify(state) });
  });
  return seen;
}

const card = (page) => page.getByRole("region", { name: "Transkripsi" });
// The key field itself: with a key saved, the "API key Groq" label names the group of its
// Ganti and Hapus buttons instead.
const keyField = (section) => section.getByLabel("API key Groq").and(section.locator("input"));

test.describe("Transkripsi", () => {
  test.beforeEach(() => skipWithoutCredentials(test));

  test("off by default, says where the audio goes, and saves the switch and a key", async ({ page }) => {
    const seen = await fakeTranscription(page, { ...OFF });
    await login(page, "/settings");
    const section = card(page);
    await section.scrollIntoViewIfNeeded();
    const toggle = section.getByRole("checkbox", { name: "Transkrip lewat Groq" });
    await expect(toggle).not.toBeChecked();
    await expect(section).toContainText("Audio video dikirim ke Groq, layanan pihak ketiga.");

    await toggle.check();
    await expect(section.getByRole("status")).toHaveText("Tersimpan. Isi API key Groq supaya Groq bisa dipakai.");
    await expect(section).toContainText("Isi API key Groq. Tanpa key, Whisper di server ini yang dipakai.");
    expect(seen.puts).toEqual([{ enabled: true, apiKey: { action: "keep" } }]);

    await section.getByLabel("API key Groq").fill(KEY);
    await page.keyboard.press("Enter");
    await expect(section.getByRole("status")).toHaveText("API key tersimpan.");
    await expect(section.getByText("API key tersimpan", { exact: true })).toBeVisible();
    expect(seen.puts[1]).toEqual({ enabled: true, apiKey: { action: "replace", value: KEY } });
    await expect(keyField(section)).toHaveCount(0);

    await section.getByRole("button", { name: "Hapus" }).click();
    await expect(section.getByRole("status")).toHaveText("API key dihapus.");
    expect(seen.puts[2]).toEqual({ enabled: true, apiKey: { action: "clear" } });
  });

  test("a Groq key from Pengaturan AI needs no field here", async ({ page }) => {
    await fakeTranscription(page, { ...OFF, enabled: true, key: "llm", llmKey: true, updatedAt: SAVED_AT });
    await login(page, "/settings");
    const section = card(page);
    await expect(section).toContainText("Memakai API key Groq dari Pengaturan AI.");
    await expect(keyField(section)).toHaveCount(0);
    await expect(section.getByRole("checkbox", { name: "Transkrip lewat Groq" })).toBeChecked();
  });

  test("a stored key that no longer opens asks to be filled again", async ({ page }) => {
    await fakeTranscription(page, { ...OFF, enabled: true, key: "unreadable", ownKey: true, updatedAt: SAVED_AT });
    await login(page, "/settings");
    const section = card(page);
    await expect(section.getByRole("alert")).toHaveText("API key Groq tersimpan tidak bisa dibuka. Isi ulang.");
    await section.getByRole("button", { name: "Isi ulang" }).click();
    await expect(section.getByLabel("API key Groq")).toBeVisible();
    await section.getByRole("button", { name: "Batal" }).click();
    await expect(keyField(section)).toHaveCount(0);
  });

  test("without the sealing secret the key field stays off", async ({ page }) => {
    await fakeTranscription(page, { ...OFF, secretConfigured: false });
    await login(page, "/settings");
    const section = card(page);
    await expect(section.getByRole("alert")).toContainText("Kunci enkripsi pengaturan belum tersedia");
    await expect(section.getByLabel("API key Groq")).toBeDisabled();
  });
});

test.describe("Transkripsi refusals", () => {
  test.beforeEach(() => skipWithoutCredentials(test));

  test("a refused key says why and the switch stays as it was", async ({ page }) => {
    expectFailedRequest(page, 422, "PUT", "/api/settings/transcription"); // the key is refused on purpose
    await fakeTranscription(page, { ...OFF }, {
      put: { status: 422, body: { error: "API key harus berupa teks ASCII tanpa spasi (maks. 4096 karakter).", code: "invalid" } },
    });
    await login(page, "/settings");
    const section = card(page);
    await section.getByLabel("API key Groq").fill("dua kata");
    await section.getByRole("button", { name: "Simpan key Groq" }).click();
    await expect(section.getByRole("alert")).toHaveText("API key harus berupa teks ASCII tanpa spasi (maks. 4096 karakter).");
    await expect(section.getByRole("checkbox", { name: "Transkrip lewat Groq" })).not.toBeChecked();
  });

  test("a failed load says so, and Coba lagi loads the card", async ({ page }) => {
    expectFailedRequest(page, 503, "GET", "/api/settings/transcription"); // the first load fails on purpose
    let calls = 0;
    await page.route(ENDPOINT, (route) => {
      calls += 1;
      const body = calls === 1 ? { error: "x", code: "settings_unavailable" } : OFF;
      return route.fulfill({ status: calls === 1 ? 503 : 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    await login(page, "/settings");
    const section = card(page);
    await expect(section.getByRole("alert")).toHaveText(/Pengaturan transkripsi tidak bisa dimuat\./);
    await section.getByRole("button", { name: "Coba lagi" }).click();
    await expect(section.getByRole("checkbox", { name: "Transkrip lewat Groq" })).toBeVisible();
    expect(calls).toBe(2);
  });
});

test.describe("Transkripsi at 390 px", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test.beforeEach(() => skipWithoutCredentials(test));

  test("fits the phone: no horizontal scroll, buttons at least 44 px tall", async ({ page }) => {
    await fakeTranscription(page, { ...OFF, enabled: true, key: "own", ownKey: true, updatedAt: SAVED_AT });
    await login(page, "/settings");
    const section = card(page);
    await section.scrollIntoViewIfNeeded();
    await expect(section.getByRole("button", { name: "Ganti" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    for (const box of await section.getByRole("button").evaluateAll((items) => items.map((item) => item.getBoundingClientRect().toJSON()))) {
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.right).toBeLessThanOrEqual(390);
    }
  });
});
