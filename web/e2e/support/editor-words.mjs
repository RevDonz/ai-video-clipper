// The transcript's actions on the selected words, in one place (docs/plans/
// 2026-10-02-editor-mode-cepat.md §9.5): the specs call `wordAction` instead of clicking a
// control. The actions live on the contextual toolbar over the selection (§6.2): the primary
// action, "Jadikan cold open" and "Kata kunci" are its buttons; the rest are items of its
// "Lainnya" menu. "Sembunyikan" is the menu's "Sembunyikan dari caption".

export const WORD_ACTIONS = Object.freeze([
  "Hapus", "Pulihkan", "Edit kata", "Sembunyikan", "Kata kunci", "Mulai di sini", "Akhiri di sini", "Perpanjang ke sini",
  "Jadikan cold open",
]);

const LABELS = Object.freeze({ Sembunyikan: "Sembunyikan dari caption" });

/** Runs one of the nine word actions on the current selection. */
export async function wordAction(page, name) {
  if (!WORD_ACTIONS.includes(name)) throw new Error(`unknown word action: ${name}`);
  const label = LABELS[name] ?? name;
  const toolbar = page.getByRole("toolbar", { name: "Aksi kata terpilih" });
  await toolbar.waitFor({ state: "visible" });
  const button = toolbar.getByRole("button", { name: label, exact: true });
  if (await button.count()) {
    await button.click();
    return;
  }
  await toolbar.getByRole("button", { name: "Lainnya", exact: true }).click();
  const menu = toolbar.getByRole("menu", { name: "Lainnya" });
  const role = label === LABELS.Sembunyikan ? "menuitemcheckbox" : "menuitem";
  await menu.getByRole(role, { name: label }).click();
}
