// The transcript's actions on the selected words, in one place (docs/plans/
// 2026-10-02-editor-mode-cepat.md §9.5): the specs call `wordAction` instead of clicking a chip,
// so task D changes only this file when the chips become the contextual toolbar. Z0 implements it
// against today's chip row.

export const WORD_ACTIONS = Object.freeze([
  "Hapus", "Pulihkan", "Edit kata", "Sembunyikan", "Kata kunci", "Mulai di sini", "Akhiri di sini", "Perpanjang ke sini",
  "Jadikan cold open",
]);

/** Runs one of the nine word actions on the current selection. */
export async function wordAction(page, name) {
  if (!WORD_ACTIONS.includes(name)) throw new Error(`unknown word action: ${name}`);
  await page.getByRole("toolbar", { name: "Aksi kata" }).getByRole("button", { name }).click();
}
