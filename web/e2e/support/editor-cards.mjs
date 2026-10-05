// Mode Cepat's cards, in one place (docs/plans/2026-10-02-editor-mode-cepat.md §9.5): the specs
// call `openCard` instead of clicking a card header, so task B changes only this file if the cards
// change. Z0 implements it against its QuickPanel (ids from ui/kit-model.mjs accordionIds).

export const CARD_IDS = Object.freeze(["hook", "caption", "lines", "coldopen", "layout", "extras"]);

/** Opens the card `id` (leaving it open if it is) and returns its body region. */
export async function openCard(page, id) {
  if (!CARD_IDS.includes(id)) throw new Error(`unknown card: ${id}`);
  const header = page.locator(`#card-${id}-button`);
  if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
  return page.locator(`#card-${id}-region`);
}
