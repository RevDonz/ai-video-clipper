// Pengaturan's tabs and save bar for the settings-* specs (05-ui-dashboard.md §6.10), named from
// the catalog so the specs run in every UI language.
import { login } from "./harness.mjs";
import { L } from "./i18n.mjs";

/** A tab by its catalog id (settings.tab.<id>): "ai", "transcription", "appearance", "youtube", "system". */
export const settingsTab = (page, id) => page.getByRole("tab", { name: L(`settings.tab.${id}`), exact: true });

/** The same tab while it holds unsaved changes ("Transkripsi, belum disimpan"). */
export const unsavedTab = (page, id) => page.getByRole("tab", { name: L("settings.unsavedTab", { tab: L(`settings.tab.${id}`) }), exact: true });

/** Logs in on /settings and opens a tab. */
export async function openSettingsTab(page, id) {
  await login(page, "/settings");
  await settingsTab(page, id).click();
}

/** The floating save bar (only there while a card holds unsaved changes). */
export const saveBar = (page) => page.getByRole("region", { name: L("settings.bar.region") });

/** Simpan in the save bar. */
export async function saveSettings(page) {
  await saveBar(page).getByRole("button", { name: L("settings.bar.save"), exact: true }).click();
}
