// The project page as a workspace (/projects/[id]): the poster grid and its one detail panel,
// the "Semua" and "Skor 8+" filters, left/right between clips, and "Pilih" mode for the ZIP.
// Client-safe: no Node built-ins.

import { zipHref } from "./clip-download.mjs";
import { clipScoreView, formatTenths } from "./selection-v3-view.mjs";

export const HIGH_SCORE = 8;

const FILTERS = Object.freeze([
  Object.freeze({ value: "all", label: "Semua" }),
  Object.freeze({ value: "high", label: "Skor 8+" }),
]);

// The total as the pill shows it (one decimal), so the mark and the number always agree.
function shownTotal(clip) {
  const total = clipScoreView(clip)?.total;
  return typeof total === "number" ? Math.round(total * 10) / 10 : null;
}

/** The poster's score pill: `{text: "8,4", high}` (high from 8,0 up), or null for an unscored clip. */
export function scorePill(clip) {
  const total = shownTotal(clip);
  return total === null ? null : { text: formatTenths(total), high: total >= HIGH_SCORE };
}

export function isHighScore(clip) {
  return scorePill(clip)?.high === true;
}

/**
 * The filter chips with their counts and the clips the grid shows. Without any scored clip (a
 * project made before the current selection) the chips are hidden and every clip shows.
 */
export function clipFilterView(clips, filter) {
  const list = Array.isArray(clips) ? clips : [];
  const showFilters = list.some((clip) => scorePill(clip) !== null);
  const active = showFilters && filter === "high" ? "high" : "all";
  const high = list.filter(isHighScore);
  return {
    showFilters,
    filters: FILTERS.map((item) => ({
      value: item.value,
      label: item.label,
      count: item.value === "high" ? high.length : list.length,
      active: item.value === active,
    })),
    visible: active === "high" ? high : list,
  };
}

/** The clip shown in the detail panel: `selected` while the grid shows it, else the first shown. */
export function keepSelection(visible, selected) {
  if (!Array.isArray(visible) || !visible.length) return null;
  return visible.some((clip) => clip.index === selected) ? selected : visible[0].index;
}

/** The clip `delta` (−1 or 1) away from the selection among the shown clips; stays at both ends. */
export function stepSelection(visible, selected, delta) {
  const current = keepSelection(visible, selected);
  if (current === null) return null;
  const at = visible.findIndex((clip) => clip.index === current);
  return visible[Math.max(0, Math.min(visible.length - 1, at + Math.sign(delta)))].index;
}

/** "2/3" of the stepper: `{position, total, first, last}`, or null without a shown clip. */
export function clipPosition(visible, selected) {
  const current = keepSelection(visible, selected);
  if (current === null) return null;
  const at = visible.findIndex((clip) => clip.index === current);
  return { position: at + 1, total: visible.length, first: at === 0, last: at === visible.length - 1 };
}

const OWN_ARROWS = new Set(["INPUT", "TEXTAREA", "SELECT", "VIDEO", "AUDIO"]);
const OWN_ARROW_ROLES = new Set(["slider", "spinbutton", "listbox", "menu", "menubar", "tablist", "radiogroup", "textbox", "grid"]);

/**
 * −1 for ArrowLeft, 1 for ArrowRight, 0 otherwise: no modifier, not while typing, and not where
 * the focused control uses the arrows itself (fields, a video's seek bar, sliders).
 */
export function arrowDelta(event) {
  if (!event || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return 0;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.defaultPrevented || event.isComposing) return 0;
  const target = event.target;
  if (target) {
    if (OWN_ARROWS.has(String(target.tagName || "").toUpperCase()) || target.isContentEditable) return 0;
    const role = target.role ?? target.getAttribute?.("role");
    if (OWN_ARROW_ROLES.has(role)) return 0;
  }
  return event.key === "ArrowLeft" ? -1 : 1;
}

export function togglePick(picks, index) {
  const next = new Set(picks);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  return next;
}

/** "Pilih semua": every clip the grid shows. */
export function pickAll(visible) {
  return new Set((Array.isArray(visible) ? visible : []).map((clip) => clip.index));
}

/** Only shown clips stay picked, so a hidden clip never lands in the ZIP unseen. */
export function prunePicks(picks, visible) {
  const shown = pickAll(visible);
  return new Set([...picks].filter((index) => shown.has(index)));
}

/** The picked clip numbers in the project's order. */
export function pickedInOrder(clips, picks) {
  return (Array.isArray(clips) ? clips : []).map((clip) => clip.index).filter((index) => picks.has(index));
}

export function pickSummary(count) {
  return `${count} dipilih`;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Asks the ZIP route whether the archive can be made (its size and name) before the browser
 * downloads it, so a refusal reads as a message on the page: `{type: "ok", count, bytes,
 * filename, href}`, `{type: "redirect", location}` or `{type: "error", message}`.
 */
export async function checkZip(jobId, indexes, { fetchImpl = fetch, signal } = {}) {
  let response;
  try {
    response = await fetchImpl(zipHref(jobId, indexes, { check: true }), { cache: "no-store", signal });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    return { type: "error", message: "ZIP tidak bisa disiapkan. Periksa koneksi, lalu coba lagi." };
  }
  if (response.status === 401) {
    return { type: "redirect", location: `/login?next=${encodeURIComponent(`/projects/${jobId}`)}` };
  }
  const body = await readJson(response);
  if (response.ok && Number.isSafeInteger(body?.count) && Number.isSafeInteger(body?.bytes) && typeof body?.filename === "string") {
    return { type: "ok", count: body.count, bytes: body.bytes, filename: body.filename, href: zipHref(jobId, indexes) };
  }
  if (!response.ok && typeof body?.error === "string" && body.error) return { type: "error", message: body.error };
  return { type: "error", message: "ZIP tidak bisa disiapkan. Coba lagi sebentar lagi." };
}
