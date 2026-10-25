// The one-layout editor's transcript (rombak 06 §6, Editor F2): its two views, Kata (the word
// list) and Baris (one field per caption line), and the one drawer that holds Rapikan and Ejaan.
// Pure; TranscriptHead.jsx, ReviewDrawer.jsx and LinesView.jsx shape the words from the catalog.

/** The transcript's views in their order: Kata, then Baris. */
export const TRANSCRIPT_MODES = Object.freeze(["words", "lines"]);

/** A view id, Kata for anything that is not Baris. */
export function transcriptMode(value) {
  return value === "lines" ? "lines" : "words";
}

/** The drawer's tabs in their order. */
export const REVIEW_TABS = Object.freeze(["cleanup", "spelling"]);

/** The tabs the drawer shows: Rapikan, and Ejaan only with the editor's LLM. */
export function reviewTabs({ llmEnabled = false } = {}) {
  return llmEnabled ? [...REVIEW_TABS] : ["cleanup"];
}

/**
 * What a drawer tab opens, one review at a time: `{ tab, cleanup, spelling }`. Ejaan without the
 * LLM opens Rapikan; anything else closes the drawer.
 */
export function openReview(tab, { llmEnabled = false } = {}) {
  const tabs = reviewTabs({ llmEnabled });
  const next = tabs.includes(tab) ? tab : tab === "spelling" ? "cleanup" : null;
  return { tab: next, cleanup: next === "cleanup", spelling: next === "spelling" };
}

/**
 * The number a button or tab shows next to its name, or null for none yet: Rapikan once its list
 * is loaded (`cleanupEntries`), Ejaan once the check is done (`spellingPhase`, `spellingRows`).
 */
export function reviewCount(tab, { cleanupEntries = null, spellingPhase = null, spellingRows = 0 } = {}) {
  if (tab === "cleanup") return Number.isInteger(cleanupEntries) ? cleanupEntries : null;
  if (tab === "spelling") return spellingPhase === "done" && Number.isInteger(spellingRows) ? spellingRows : null;
  return null;
}

/**
 * The caption-hidden words a Baris line keeps around it (captionRows' `hiddenIds`): retyping
 * them brings them back, so the line says so.
 */
export function hiddenInRow(row) {
  return Array.isArray(row?.hiddenIds) ? row.hiddenIds.length : 0;
}
