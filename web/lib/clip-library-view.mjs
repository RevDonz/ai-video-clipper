// The "Klip" tab of Proyek (/projects) in the browser: the remembered view, the request behind
// the search, the chips and "Muat lagi", and the poster card's text. Copy comes back as catalog
// descriptors under projects.clips (lib/i18n/descriptor.mjs). Client-safe: no Node built-ins.

import { scorePillFor } from "./project-workspace.mjs";
import { formatTimestamp } from "./selection-v3-view.mjs";
import { d } from "./i18n/descriptor.mjs";
import { dateTimeFormat } from "./i18n/format.mjs";
import { SOURCE_LOCALE } from "./i18n/locales.mjs";

export const HISTORY_VIEWS = Object.freeze(["projects", "clips"]);
export const HISTORY_VIEW_KEY = "potongin-history-view";

const knownView = (value) => (HISTORY_VIEWS.includes(value) ? value : null);

/** window.localStorage, or null where reading it throws (blocked site data, some private windows). */
export function browserStorage() {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** "projects" | "clips" | null; null on any throw or unknown value. */
export function readHistoryView(storage) {
  try {
    return knownView(storage?.getItem(HISTORY_VIEW_KEY) ?? null);
  } catch {
    return null;
  }
}

/** Stores the view; false when the view is unknown or the storage refuses. Never throws. */
export function writeHistoryView(storage, view) {
  if (!knownView(view) || !storage) return false;
  try {
    storage.setItem(HISTORY_VIEW_KEY, view);
    return true;
  } catch {
    return false;
  }
}

/** Monday 00:00 of the week `now` falls in, in the viewer's time zone ("Minggu ini"). */
export function startOfWeek(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start;
}

const DAY_GROUPS = Object.freeze([
  Object.freeze({ key: "today", label: d("projects.clips.day.today") }),
  Object.freeze({ key: "week", label: d("projects.clips.day.week") }),
  Object.freeze({ key: "earlier", label: d("projects.clips.day.earlier") }),
]);

/**
 * "today" from 00:00 of `now`'s day, "week" from Monday 00:00 (startOfWeek), else "earlier", in
 * the viewer's time zone. A moment ahead of `now` is today; a missing or unreadable one is earlier.
 */
export function clipDayGroup(createdAt, now = new Date()) {
  const ms = typeof createdAt === "string" && createdAt ? Date.parse(createdAt) : Number.NaN;
  if (!Number.isFinite(ms)) return "earlier";
  if (ms >= new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) return "today";
  return ms >= startOfWeek(now).getTime() ? "week" : "earlier";
}

/**
 * The grid's groups `{key, label, items}` in a fixed order, only those holding a clip, each in the
 * listing's order (newest first, so the groups follow that order too). `headings` is false when
 * nothing is from this week: one plain grid then, no lone "Lebih lama".
 */
export function groupClipsByDay(items, now = new Date()) {
  const list = Array.isArray(items) ? items : [];
  const byKey = new Map(DAY_GROUPS.map((group) => [group.key, []]));
  for (const item of list) byKey.get(clipDayGroup(item?.createdAt, now)).push(item);
  const groups = DAY_GROUPS.filter((group) => byKey.get(group.key).length)
    .map((group) => ({ key: group.key, label: group.label, items: byKey.get(group.key) }));
  return { headings: groups.some((group) => group.key !== "earlier"), groups };
}

/** The listing request of one page: the search, "Skor 8+", "Minggu ini" and the cursor of "Muat lagi". */
export function clipLibraryHref({ query = "", high = false, week = false, cursor = null, now = new Date() } = {}) {
  const params = new URLSearchParams();
  const q = String(query ?? "").trim();
  if (q) params.set("q", q);
  if (high) params.set("high", "1");
  if (week) params.set("since", startOfWeek(now).toISOString());
  if (cursor) params.set("cursor", cursor);
  const search = params.toString();
  return search ? `/api/clips?${search}` : "/api/clips";
}

export class ClipLibraryLoadError extends Error {
  // `reason` is the descriptor of what to do next (check the connection, try later).
  constructor(reason) {
    super(reason.key);
    this.name = "ClipLibraryLoadError";
    this.reason = reason;
  }
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * One page of the clip grid: `{type: "loaded", clips, matched, total, projects, nextCursor,
 * partial}` or `{type: "redirect", location}` when the session ended; a failure throws
 * ClipLibraryLoadError with the reason to show (an abort is rethrown as is).
 */
export async function loadClipLibrary(options = {}, { fetchImpl = fetch, signal } = {}) {
  let response;
  try {
    response = await fetchImpl(clipLibraryHref(options), { cache: "no-store", signal });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new ClipLibraryLoadError(d("projects.clips.offline"));
  }
  if (response.status === 401) return { type: "redirect", location: `/login?next=${encodeURIComponent("/projects")}` };
  const body = await readJson(response);
  if (!response.ok || !Array.isArray(body?.clips)) throw new ClipLibraryLoadError(d("projects.clips.later"));
  return {
    type: "loaded",
    clips: body.clips,
    matched: Number.isSafeInteger(body.matched) ? body.matched : body.clips.length,
    total: Number.isSafeInteger(body.total) ? body.total : body.clips.length,
    projects: Number.isSafeInteger(body.projects) ? body.projects : 0,
    nextCursor: typeof body.nextCursor === "string" && body.nextCursor ? body.nextCursor : null,
    partial: body.partial === true,
  };
}

const itemKey = (item) => `${item.jobId}#${item.index}`;

/** The grid after "Muat lagi": the next page appended, a clip already shown kept once. */
export function mergeClipPages(current, next) {
  const seen = new Set(current.map(itemKey));
  return [...current, ...next.filter((item) => !seen.has(itemKey(item)))];
}

/** The clip in its project: the project page opens with it in the detail panel. */
export function clipHref(item) {
  return `/projects/${encodeURIComponent(item.jobId)}?klip=${item.index}`;
}

const DAY = Object.freeze({ day: "numeric", month: "short" });
const DAY_YEAR = Object.freeze({ day: "numeric", month: "short", year: "numeric" });

function shortDay(value, now, locale) {
  const date = typeof value === "string" ? new Date(value) : null;
  if (!date || Number.isNaN(date.valueOf())) return null;
  return dateTimeFormat(locale, date.getFullYear() === now.getFullYear() ? DAY : DAY_YEAR).format(date).replace(/\./g, "");
}

/**
 * What a poster card shows, and its one-line description for screen readers. `title` is the
 * clip's own title or the descriptor of its number; `meta` is a list of parts (text or
 * descriptors) the card joins with ", ". `locale` formats the day.
 */
export function clipCardView(item, now = new Date(), locale = SOURCE_LOCALE) {
  const number = String(item.index).padStart(2, "0");
  const length = formatTimestamp(item.duration);
  const pill = scorePillFor(item.score);
  const project = typeof item.projectName === "string" && item.projectName ? item.projectName : null;
  const day = shortDay(item.createdAt, now, locale);
  const label = d("projects.clips.number", { number });
  return {
    number,
    title: item.title || label,
    length,
    pill,
    project,
    day,
    meta: [label, length, pill && d("projects.clips.score", { score: pill.text }), project, day].filter(Boolean),
  };
}

/** Every clip and the projects they come from ("128 klip dari 40 proyek"). */
export function librarySummary({ total, projects }) {
  return total > 0 ? d("projects.clips.summary", { total, projects }) : d("projects.clips.empty");
}

/** How much of the result the grid shows ("24 dari 128 klip"). */
export function shownSummary({ shown, matched }) {
  return shown < matched ? d("projects.clips.shownOf", { shown, matched }) : d("projects.clips.shown", { count: matched });
}
