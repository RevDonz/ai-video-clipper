// The editor's top-bar and stage actions, in one place (docs/plans/2026-10-02-editor-mode-cepat.md
// §9.5): the specs call these instead of clicking the controls, so task A changes only this file
// when the controls move (⋯ Lainnya, the view switch, the stage overlays). Z0 implements them
// against today's UI.

/** "Kembali ke versi AI". */
export async function resetToAi(page) {
  await page.getByRole("button", { name: "Kembali ke versi AI" }).click();
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

/** Opens the "Pintasan keyboard" dialog from its button. */
export async function openShortcutHelp(page) {
  await page.getByRole("button", { name: "Pintasan keyboard" }).click();
}

/**
 * Shows the editor in `view` ("cepat" or "lengkap"). Z0 has no switch on screen yet, so this
 * reloads the page with ?mode=<view>; task A clicks the top-bar switch instead.
 */
export async function switchView(page, view) {
  const url = new URL(page.url());
  url.searchParams.set("mode", view);
  url.searchParams.delete("panel");
  url.searchParams.delete("card");
  await page.goto(`${url.pathname}${url.search}`);
}

/** Toggles "Frame akhir". */
export async function toggleTruthFrame(page) {
  await page.getByRole("button", { name: "Frame akhir" }).click();
}

/** The "Zona aman" toggle (a button with aria-pressed): click it, or check its state. */
export function safeZone(page) {
  return page.getByRole("button", { name: "Zona aman" });
}
