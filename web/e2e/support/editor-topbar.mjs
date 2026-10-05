// The editor's top-bar and stage actions, in one place (docs/plans/2026-10-02-editor-mode-cepat.md
// §9.5): the specs call these instead of clicking the controls, so only this file changes when the
// controls move. Task A moved them: "Kembali ke versi AI" and "Pintasan keyboard" into the ⋯
// Lainnya menu, the view switch into the top bar, Frame akhir and Zona aman beside the stage.
import { expect } from "@playwright/test";

/** Opens the top bar's ⋯ Lainnya and runs its item `name` (the word toolbar has a "Lainnya" too). */
async function moreMenu(page, name) {
  const bar = page.locator('[data-slot="topBar"]');
  await bar.getByRole("button", { name: "Lainnya", exact: true }).click();
  await bar.getByRole("menu", { name: "Lainnya" }).getByRole("menuitem", { name }).click();
}

/** "Kembali ke versi AI" (⋯ Lainnya). */
export async function resetToAi(page) {
  await moreMenu(page, "Kembali ke versi AI");
}

/**
 * Opens "Perlu dicek" and returns its button (focus comes back to it on close). With `count`,
 * the button must read exactly "Perlu dicek (<count>)".
 */
export async function openChecks(page, count = null) {
  const button = page.getByRole("button", { name: count === null ? /^Perlu dicek \(\d+\)$/ : `Perlu dicek (${count})`, exact: count !== null });
  await button.click();
  return button;
}

/** Opens the "Pintasan keyboard" dialog (⋯ Lainnya). */
export async function openShortcutHelp(page) {
  await moreMenu(page, "Pintasan keyboard");
}

/** Shows the editor in `view` ("cepat" or "lengkap") with the top bar's switch. */
export async function switchView(page, view) {
  if (!["cepat", "lengkap"].includes(view)) throw new Error(`unknown view: ${view}`);
  const name = view === "cepat" ? "Cepat" : "Lengkap";
  await page.getByRole("radiogroup", { name: "Tampilan editor" }).getByRole("radio", { name, exact: true }).check();
  await expect(page.locator("[data-editor-root]")).toHaveAttribute("data-editor-view", view);
}

/** Toggles "Frame akhir". */
export async function toggleTruthFrame(page) {
  await page.getByRole("button", { name: "Frame akhir" }).click();
}

/** The "Zona aman" toggle (a button with aria-pressed): click it, or check its state. */
export function safeZone(page) {
  return page.getByRole("button", { name: "Zona aman" });
}
