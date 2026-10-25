// The project page as a workspace (/projects/[id]): the poster grid and its one detail panel,
// the "Semua", "Skor 8+" and "Diedit" filters, left/right between clips, "Pilih" mode for the ZIP, and the
// notes of clips that fell back.
// Client-safe: no Node built-ins.

import { zipHref } from "./clip-download.mjs";
import { clipCounts, readyClips } from "./clip-status.mjs";
import { d } from "./i18n/descriptor.mjs";
import { clipScoreView, formatTenths } from "./selection-v3-view.mjs";

export const HIGH_SCORE = 8;

/** "4 klip siap diunggah", or "3 dari 4 klip siap diunggah" when a clip failed to render. */
export function clipsHeading(clips, status) {
  const { total, ready, failed } = clipCounts(clips);
  if (status !== "completed") return `${total} klip`;
  return failed ? `${ready} dari ${total} klip siap diunggah` : `${total} klip siap diunggah`;
}

const FILTERS = Object.freeze([
  Object.freeze({ value: "all", label: "Semua", empty: "Belum ada klip." }),
  Object.freeze({ value: "high", label: "Skor 8+", empty: "Belum ada klip dengan skor 8 atau lebih." }),
  Object.freeze({ value: "edited", label: "Diedit", empty: "Belum ada klip yang diedit." }),
  Object.freeze({ value: "outsideFocus", label: "Di luar fokus", empty: "Semua klip cocok dengan fokus." }),
]);

/** The total as the pill shows it (one decimal), so the mark and the number always agree; else null. */
export function shownScore(clip) {
  const total = clipScoreView(clip)?.total;
  return typeof total === "number" ? Math.round(total * 10) / 10 : null;
}

/** The pill for a shown total: `{text: "8,4", high}` (high from 8,0 up), or null without a score. */
export function scorePillFor(total) {
  return typeof total === "number" && Number.isFinite(total) ? { text: formatTenths(total), high: total >= HIGH_SCORE } : null;
}

/** The poster's score pill, or null for an unscored clip. */
export function scorePill(clip) {
  return scorePillFor(shownScore(clip));
}

export function isHighScore(clip) {
  return scorePill(clip)?.high === true;
}

// The engine's per-clip fallbacks (lib/jobs.mjs CLIP_FALLBACKS) as neutral notes: `text` in the
// detail panel, `card` on the poster only when the picture itself changed (descriptors).
const FALLBACK_NOTES = Object.freeze({
  no_face: Object.freeze({ card: Object.freeze(d("layout.names.fill_center")), text: Object.freeze(d("project.fallback.noFace")) }),
  engine_fallback: Object.freeze({ card: null, text: Object.freeze(d("project.fallback.engine")) }),
});

/** `[{code, card, text}]` for the clip's fallbacks, in a fixed order; [] without any. */
export function clipFallbackNotes(clip) {
  const codes = Array.isArray(clip?.fallbacks) ? clip.fallbacks : [];
  return Object.entries(FALLBACK_NOTES)
    .filter(([code]) => codes.includes(code))
    .map(([code, note]) => ({ code, card: note.card, text: note.text }));
}

/**
 * The clip numbers the editor changed (their entry carries the "Diedit" badge), or null when no
 * clip has an editor entry that opens (the listing is off, loading or failed, or the project
 * predates the editor): "Diedit" then has nothing to go on and stays hidden.
 */
export function editedIndexes(clips, entryFor) {
  const list = Array.isArray(clips) ? clips : [];
  const entries = list.map((clip) => [clip.index, entryFor(clip)]);
  const edited = (entry) => entry?.editBadge?.tone === "edited";
  if (!entries.some(([, entry]) => entry?.editHref || edited(entry))) return null;
  return new Set(entries.filter(([, entry]) => edited(entry)).map(([index]) => index));
}

/**
 * The filter chips with their counts, the active one and the clips the grid shows. "Skor 8+"
 * needs a scored clip (a project made before the current selection has none), "Diedit" the
 * `edited` set from editedIndexes; with neither the chips are hidden and every clip shows. A
 * chip that is not offered reads as "Semua". "Di luar fokus" takes the `outside` set of clip
 * numbers (a project with Fokus klip) and shows only when a clip is in it.
 */
export function clipFilterView(clips, filter, edited = null, outside = null) {
  const list = Array.isArray(clips) ? clips : [];
  const shown = {
    all: list,
    high: list.some((clip) => scorePill(clip) !== null) ? list.filter(isHighScore) : null,
    edited: edited instanceof Set ? list.filter((clip) => edited.has(clip.index)) : null,
    outsideFocus: outside instanceof Set && outside.size > 0 ? list.filter((clip) => outside.has(clip.index)) : null,
  };
  const offered = FILTERS.filter((item) => shown[item.value] !== null);
  const active = offered.some((item) => item.value === filter) ? filter : "all";
  return {
    showFilters: offered.length > 1,
    active,
    filters: offered.map((item) => ({
      value: item.value,
      label: item.label,
      count: shown[item.value].length,
      active: item.value === active,
    })),
    visible: shown[active],
  };
}

/**
 * The grid's order (05 §6.4, Terbaik | Urutan video): "best" by the shown score, highest first
 * (unscored clips after); "timeline" by where the clip starts in the video. The clip number
 * breaks ties. Returns a copy; the job's list is not changed.
 */
export function sortClips(clips, sort) {
  const list = Array.isArray(clips) ? [...clips] : [];
  const byIndex = (a, b) => (a?.index ?? 0) - (b?.index ?? 0);
  if (sort === "timeline") {
    const start = (clip) => (Number.isFinite(clip?.sourceStart) ? clip.sourceStart : Number.isFinite(clip?.start) ? clip.start : Number.MAX_VALUE);
    return list.sort((a, b) => start(a) - start(b) || byIndex(a, b));
  }
  const score = (clip) => shownScore(clip) ?? -1;
  return list.sort((a, b) => score(b) - score(a) || byIndex(a, b));
}

/** The query string with `?klip=N` set (a number) or removed (null), the rest kept. */
export function withClipParam(search, index) {
  const params = new URLSearchParams(search ?? "");
  if (Number.isSafeInteger(index) && index > 0) params.set("klip", String(index));
  else params.delete("klip");
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** The line an empty filter shows. */
export function filterEmptyText(filter) {
  return (FILTERS.find((item) => item.value === filter) ?? FILTERS[0]).empty;
}

const CLIP_PARAM = /^[1-9]\d{0,3}$/;

/** The clip a link names (`?klip=3`, from the Riwayat clip grid), or null. */
export function clipFromParam(value) {
  const raw = Array.isArray(value) ? (value.length === 1 ? value[0] : null) : value;
  return typeof raw === "string" && CLIP_PARAM.test(raw) ? Number(raw) : null;
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

/** "Pilih semua": every clip the grid shows that has a file (a failed clip has none to zip). */
export function pickAll(visible) {
  return new Set(readyClips(visible).map((clip) => clip.index));
}

/** Only shown clips with a file stay picked, so a hidden clip never lands in the ZIP unseen. */
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
