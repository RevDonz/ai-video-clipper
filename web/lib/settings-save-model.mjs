// Pengaturan's one save bar (05-ui-dashboard.md §6.10), DOM-free. Each card that keeps a draft
// registers `{ id, tab, dirty, save }`; `save()` resolves `{ ok }` and shows its own field errors.
// Simpan runs the dirty cards one after another in page order (tab, then registration), so the
// requests never race each other; a failed card does not stop the rest.
import { SETTINGS_TABS } from "./settings-tabs.mjs";

const tabRank = (tab) => {
  const rank = SETTINGS_TABS.indexOf(tab);
  return rank < 0 ? SETTINGS_TABS.length : rank;
};

/** The tabs that hold at least one dirty card, in page order. */
export function dirtyTabs(cards) {
  return new Set(dirtyCards(cards).map((card) => card.tab));
}

/** The dirty cards in the order Simpan saves them. */
export function dirtyCards(cards) {
  return cards
    .map((card, index) => ({ card, index }))
    .filter(({ card }) => card.dirty)
    .sort((a, b) => tabRank(a.card.tab) - tabRank(b.card.tab) || a.index - b.index)
    .map(({ card }) => card);
}

/** Saves the dirty cards in turn: `{ saved: [id], failed: [{ id, tab }] }`. */
export async function saveDirtyCards(cards, { onCard } = {}) {
  const saved = [];
  const failed = [];
  for (const card of dirtyCards(cards)) {
    onCard?.(card);
    let ok = false;
    try {
      ok = (await card.save())?.ok === true;
    } catch {
      ok = false;
    }
    if (ok) saved.push(card.id);
    else failed.push({ id: card.id, tab: card.tab });
  }
  return { saved, failed };
}

/** What the bar says after Simpan: "saved", "partial" (with the first failed card) or "none". */
export function saveOutcome({ saved, failed }) {
  if (failed.length) return { kind: "partial", failedCount: failed.length, first: failed[0] };
  return { kind: saved.length ? "saved" : "none", failedCount: 0, first: null };
}
