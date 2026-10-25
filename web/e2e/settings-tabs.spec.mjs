// Pengaturan's tabs and its one save bar (05-ui-dashboard.md §6.10; 08 Fase 3: "Hash lama
// Pengaturan membuka tab yang benar; perubahan belum simpan tidak hilang saat pindah tab").
// The watermark and transcription APIs are faked in the browser (page.route), so nothing on the
// server changes. Every name comes from the catalog, so the spec runs in every UI language.
import { expect } from "@playwright/test";

import { expectFailedRequest, login, skipWithoutCredentials, test } from "./support/harness.mjs";
import { L } from "./support/i18n.mjs";
import { saveBar, saveSettings, settingsTab, unsavedTab } from "./support/settings.mjs";

const OFF = { enabled: false, key: "missing", ownKey: false, llmKey: false, secretConfigured: true, updatedAt: null, problem: null };

async function fakeWatermark(page) {
  const seen = { puts: [] };
  const state = { watermark: null, autoClips: false };
  await page.route("**/api/settings/watermark", async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      seen.puts.push(body);
      state.watermark = { ...body, updatedAtMs: 1_790_000_000_001 };
    }
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "Cache-Control": "no-store" }, body: JSON.stringify(state) });
  });
  return seen;
}

async function fakeTranscription(page, { putStatus = 200 } = {}) {
  const seen = { puts: [] };
  await page.route("**/api/settings/transcription", async (route) => {
    if (route.request().method() === "PUT") {
      seen.puts.push(route.request().postDataJSON());
      if (putStatus !== 200) return route.fulfill({ status: putStatus, contentType: "application/json", body: JSON.stringify({ error: "x", code: "settings_unavailable" }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "Cache-Control": "no-store" }, body: JSON.stringify(OFF) });
  });
  return seen;
}

const region = (page, key) => page.getByRole("region", { name: L(key), exact: true });
const watermarkText = (page) => region(page, "settings.appearance.watermark").getByRole("textbox", { name: L("settings.appearance.watermarkText") });
const transcription = (page) => region(page, "settings.tab.transcription");

test.describe("Pengaturan tabs", () => {
  test.beforeEach(() => skipWithoutCredentials(test));

  test("each old hash opens its tab, and picking a tab writes its hash", async ({ page }) => {
    await login(page, "/settings");
    await expect(settingsTab(page, "ai")).toHaveAttribute("aria-selected", "true");
    const hashes = [["#youtube", "youtube"], ["#tampilan", "appearance"], ["#transkripsi", "transcription"], ["#sistem", "system"], ["#provider-openrouter", "ai"]];
    for (const [hash, id] of hashes) {
      await page.goto(`/settings${hash}`);
      await expect(settingsTab(page, id)).toHaveAttribute("aria-selected", "true");
    }
    await page.goto("/settings#youtube");
    await expect(region(page, "settings.youtube.cookies")).toBeVisible();
    await settingsTab(page, "system").click();
    await expect(page).toHaveURL(/\/settings#sistem$/);
    await expect(region(page, "settings.system.about")).toBeVisible();
    await expect(region(page, "settings.youtube.cookies")).toBeHidden();
  });

  test("an unsaved change survives a tab switch, marks its tab, and Batalkan undoes it", async ({ page }) => {
    const seen = await fakeWatermark(page);
    await login(page, "/settings");
    await settingsTab(page, "appearance").click();
    await expect(saveBar(page)).toHaveCount(0);
    await watermarkText(page).fill("@potongin.klip");
    await expect(saveBar(page)).toContainText(L("settings.bar.unsaved"));
    await expect(unsavedTab(page, "appearance")).toBeVisible();

    await settingsTab(page, "ai").click();
    await expect(watermarkText(page)).toBeHidden();
    await expect(saveBar(page)).toBeVisible();
    await unsavedTab(page, "appearance").click();
    await expect(watermarkText(page)).toHaveValue("@potongin.klip");

    await saveBar(page).getByRole("button", { name: L("settings.bar.discard") }).click();
    await expect(watermarkText(page)).toHaveValue("");
    await expect(saveBar(page)).toHaveCount(0);
    await expect(settingsTab(page, "appearance")).toBeVisible();
    expect(seen.puts).toEqual([]);
  });

  test("Simpan saves every dirty tab in turn, says what failed and moves to it", async ({ page }) => {
    expectFailedRequest(page, 503, "PUT", "/api/settings/transcription"); // the transcription save fails on purpose
    const watermark = await fakeWatermark(page);
    const seen = await fakeTranscription(page, { putStatus: 503 });
    await login(page, "/settings");
    await settingsTab(page, "transcription").click();
    await transcription(page).getByText(L("settings.transcription.groq"), { exact: true }).click();
    await settingsTab(page, "appearance").click();
    await watermarkText(page).fill("@potongin.klip");
    await saveSettings(page);

    await expect(saveBar(page)).toContainText(L("settings.bar.failed", { count: 1 }));
    await expect(unsavedTab(page, "transcription")).toHaveAttribute("aria-selected", "true");
    await expect(transcription(page)).toBeFocused();
    await expect(transcription(page).getByRole("alert")).toHaveText(L("settings.common.error.settingsUnavailable"));
    expect(seen.puts).toEqual([{ enabled: true, apiKey: { action: "keep" } }]);
    expect(watermark.puts).toHaveLength(1);
    await expect(settingsTab(page, "appearance")).toBeVisible();
  });

  test("Pintasan satu tombol in Tampilan is the account menu's preference", async ({ page, context }) => {
    await login(page, "/settings");
    await settingsTab(page, "appearance").click();
    const label = L("shell.account.shortcuts");
    const toggle = page.getByRole("switch", { name: label });
    await expect(toggle).toBeChecked();
    await page.getByRole("region", { name: label }).getByText(label, { exact: true }).click();
    await expect(toggle).not.toBeChecked();
    expect((await context.cookies()).find((cookie) => cookie.name === "potongin_shortcuts")?.value).toBe("off");
    // Not a draft: the save bar has nothing to do with it.
    await expect(saveBar(page)).toHaveCount(0);
  });
});
