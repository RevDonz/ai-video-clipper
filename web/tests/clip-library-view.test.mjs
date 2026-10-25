// The "Klip" view of Riwayat in the browser: the remembered view, the request the chips and the
// search make, "Muat lagi", the poster card's text and the link to the clip in its project; and
// the project page opening on that clip (?klip=N).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  HISTORY_VIEW_KEY,
  ClipLibraryLoadError,
  clipCardView,
  clipHref,
  clipLibraryHref,
  clipDayGroup,
  groupClipsByDay,
  librarySummary,
  loadClipLibrary,
  mergeClipPages,
  readHistoryView,
  shownSummary,
  startOfWeek,
  writeHistoryView,
} from "../lib/clip-library-view.mjs";
import { clipFromParam, scorePillFor } from "../lib/project-workspace.mjs";
import { textOf } from "./support/catalog-t.mjs";

const JOB_ID = "8c2e4f60-7a1b-4c3d-9e5f-0a1b2c3d4e5f";
const read = (relative) => readFile(new URL(`../${relative}`, import.meta.url), "utf8");

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: (key) => (values.has(key) ? values.get(key) : null), setItem: (key, value) => values.set(key, String(value)), values };
}
const throwing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };

test("the chosen view is remembered per browser; blocked storage only means 'Proyek'", () => {
  const storage = memoryStorage();
  assert.equal(readHistoryView(storage), null);
  assert.equal(writeHistoryView(storage, "clips"), true);
  assert.equal(storage.values.get(HISTORY_VIEW_KEY), "clips");
  assert.equal(readHistoryView(storage), "clips");
  assert.equal(writeHistoryView(storage, "projects"), true);
  assert.equal(readHistoryView(storage), "projects");
  assert.equal(writeHistoryView(storage, "grid"), false);
  assert.equal(readHistoryView(memoryStorage({ [HISTORY_VIEW_KEY]: "grid" })), null);
  assert.equal(readHistoryView(throwing), null);
  assert.equal(writeHistoryView(throwing, "clips"), false);
  assert.equal(readHistoryView(null), null);
  assert.equal(writeHistoryView(null, "clips"), false);
});

test("'Minggu ini' starts on Monday at midnight, local time", () => {
  const monday = (year, month, day) => new Date(year, month, day, 0, 0, 0, 0).getTime();
  // 2026-10-19 is a Monday.
  assert.equal(startOfWeek(new Date(2026, 9, 21, 15, 30)).getTime(), monday(2026, 9, 19), "Wednesday");
  assert.equal(startOfWeek(new Date(2026, 9, 19, 0, 0)).getTime(), monday(2026, 9, 19), "Monday at midnight");
  assert.equal(startOfWeek(new Date(2026, 9, 25, 23, 59)).getTime(), monday(2026, 9, 19), "Sunday night");
  assert.equal(startOfWeek(new Date(2026, 10, 1, 8, 0)).getTime(), monday(2026, 9, 26), "across a month");
});

test("a clip's day group follows the viewer's clock: 'Hari ini' from midnight, 'Minggu ini' from Monday", () => {
  const at = (...parts) => new Date(...parts).toISOString();
  const wednesday = new Date(2026, 9, 21, 15, 30);
  assert.equal(clipDayGroup(at(2026, 9, 21, 0, 0, 0, 0), wednesday), "today", "midnight starts today");
  assert.equal(clipDayGroup(at(2026, 9, 21, 15, 29), wednesday), "today");
  assert.equal(clipDayGroup(at(2026, 9, 20, 23, 59, 59, 999), wednesday), "week", "one millisecond before midnight is yesterday");
  assert.equal(clipDayGroup(at(2026, 9, 19, 0, 0), wednesday), "week", "Monday 00:00");
  assert.equal(clipDayGroup(at(2026, 9, 18, 23, 59, 59, 999), wednesday), "earlier", "Sunday night before");
  // A clock a little ahead of the viewer's still reads as today.
  assert.equal(clipDayGroup(at(2026, 9, 21, 16, 0), wednesday), "today");
  for (const value of [null, undefined, "", "kemarin", 5]) assert.equal(clipDayGroup(value, wednesday), "earlier", String(value));
  // Just after midnight, the evening before is no longer today.
  const justAfter = new Date(2026, 9, 22, 0, 0, 1);
  assert.equal(clipDayGroup(at(2026, 9, 21, 23, 59), justAfter), "week");
  assert.equal(clipDayGroup(at(2026, 9, 22, 0, 0), justAfter), "today");
  // On Monday there is no "rest of the week" yet: Sunday is last week.
  const monday = new Date(2026, 9, 26, 9, 0);
  assert.equal(clipDayGroup(at(2026, 9, 25, 23, 0), monday), "earlier");
  assert.equal(clipDayGroup(at(2026, 9, 26, 0, 5), monday), "today");
});

test("the grid groups clips under 'Hari ini', 'Minggu ini' and 'Lebih lama', in the listing's order", () => {
  const now = new Date(2026, 9, 21, 15, 30);
  const clip = (jobId, index, ...parts) => ({ jobId, index, createdAt: parts.length ? new Date(...parts).toISOString() : null });
  const items = [
    clip("a", 1, 2026, 9, 21, 9, 0), clip("a", 2, 2026, 9, 21, 9, 0),
    clip("b", 1, 2026, 9, 20, 22, 0), clip("c", 1, 2026, 9, 1, 8, 0), clip("d", 1),
  ];
  const keys = (group) => group.items.map((item) => `${item.jobId}#${item.index}`);
  const grouped = groupClipsByDay(items, now);
  assert.equal(grouped.headings, true);
  assert.deepEqual(grouped.groups.map((group) => [group.key, group.label]),
    [["today", { key: "projects.clips.day.today" }], ["week", { key: "projects.clips.day.week" }], ["earlier", { key: "projects.clips.day.earlier" }]]);
  assert.deepEqual(grouped.groups.map((group) => textOf(group.label)), ["Hari ini", "Minggu ini", "Lebih lama"]);
  assert.deepEqual(grouped.groups.map((group) => textOf(group.label, "en")), ["Today", "This week", "Earlier"]);
  assert.deepEqual(grouped.groups.map(keys), [["a#1", "a#2"], ["b#1"], ["c#1", "d#1"]]);
  // Only groups that hold a clip; one group of today still says "Hari ini".
  const today = groupClipsByDay(items.slice(0, 2), now);
  assert.deepEqual(today.groups.map((group) => group.key), ["today"]);
  assert.equal(today.headings, true);
  // Nothing from this week: one plain grid, no heading that only says "older".
  const old = groupClipsByDay(items.slice(3), now);
  assert.equal(old.headings, false);
  assert.deepEqual(old.groups.map(keys), [["c#1", "d#1"]]);
  assert.deepEqual(groupClipsByDay([], now), { headings: false, groups: [] });
  assert.deepEqual(groupClipsByDay(null, now), { headings: false, groups: [] });
  // "Muat lagi" appends older clips: the groups above keep their clips and their place.
  const first = groupClipsByDay(items.slice(0, 3), now);
  const after = groupClipsByDay(mergeClipPages(items.slice(0, 3), items.slice(3)), now);
  assert.deepEqual(after.groups.slice(0, first.groups.length).map(keys), first.groups.map(keys));
});

test("the request carries the search, the chips and the cursor, and nothing when they are off", () => {
  const now = new Date(2026, 9, 21, 15, 30);
  assert.equal(clipLibraryHref({}), "/api/clips");
  assert.equal(clipLibraryHref({ query: "  ", high: false, week: false }), "/api/clips");
  const href = clipLibraryHref({ query: " Rahasia hook ", high: true, week: true, cursor: `1.${JOB_ID}.2`, now });
  const url = new URL(href, "http://local");
  assert.equal(url.pathname, "/api/clips");
  assert.equal(url.searchParams.get("q"), "Rahasia hook");
  assert.equal(url.searchParams.get("high"), "1");
  assert.equal(url.searchParams.get("since"), startOfWeek(now).toISOString());
  assert.equal(url.searchParams.get("cursor"), `1.${JOB_ID}.2`);
});

test("a page loads; a lost session goes to login; refusals and network errors read as text", async () => {
  const body = { clips: [{ jobId: JOB_ID, index: 1 }], matched: 3, total: 9, projects: 2, nextCursor: "c", partial: false };
  const ok = await loadClipLibrary({}, { fetchImpl: async (href, init) => {
    assert.equal(href, "/api/clips");
    assert.equal(init.cache, "no-store");
    return Response.json(body);
  } });
  assert.deepEqual(ok, { type: "loaded", ...body });

  const login = await loadClipLibrary({}, { fetchImpl: async () => new Response(null, { status: 401 }) });
  assert.deepEqual(login, { type: "redirect", location: `/login?next=${encodeURIComponent("/projects")}` });

  await assert.rejects(loadClipLibrary({}, { fetchImpl: async () => Response.json({ error: "x" }, { status: 503 }) }),
    (error) => error instanceof ClipLibraryLoadError && textOf(error.reason) === "Coba lagi sebentar lagi.");
  await assert.rejects(loadClipLibrary({}, { fetchImpl: async () => Response.json({ clips: "x" }) }), ClipLibraryLoadError);
  await assert.rejects(loadClipLibrary({}, { fetchImpl: async () => { throw new TypeError("offline"); } }),
    (error) => error instanceof ClipLibraryLoadError && /Periksa koneksi/.test(textOf(error.reason)));
  // The alert's title names the failure; the reason under it says what to do.
  assert.equal(textOf({ key: "projects.clips.loadFailed" }), "Klip tidak bisa dimuat");
  const aborted = new DOMException("stop", "AbortError");
  await assert.rejects(loadClipLibrary({}, { fetchImpl: async () => { throw aborted; } }), (error) => error === aborted);
});

test("'Muat lagi' appends the next page once, even when a clip comes twice", () => {
  const a = { jobId: JOB_ID, index: 1 };
  const b = { jobId: JOB_ID, index: 2 };
  const c = { jobId: JOB_ID, index: 3 };
  assert.deepEqual(mergeClipPages([a, b], [b, c]), [a, b, c]);
  assert.deepEqual(mergeClipPages([], [a]), [a]);
});

test("each card links to its clip in its project", () => {
  assert.equal(clipHref({ jobId: JOB_ID, index: 3 }), `/projects/${JOB_ID}?klip=3`);
  assert.equal(clipHref({ jobId: "a b/c", index: 12 }), "/projects/a%20b%2Fc?klip=12");
});

test("the card reads like the project page's poster, plus its project and day", () => {
  const item = {
    jobId: JOB_ID, index: 3, title: "Ngopi di café", duration: 45.6, posterUrl: `/api/jobs/${JOB_ID}/files/output/clip-03.jpg`,
    score: 8.4, projectName: "Podcast 12.mp4", sourceUrl: null, createdAt: new Date(2026, 9, 20, 10, 0).toISOString(),
  };
  const view = clipCardView(item, new Date(2026, 9, 21, 9, 0));
  assert.equal(view.number, "03");
  assert.equal(view.title, "Ngopi di café");
  assert.equal(view.length, "0:45");
  assert.deepEqual(view.pill, { text: "8,4", high: true });
  assert.equal(view.project, "Podcast 12.mp4");
  assert.equal(view.day, "20 Okt");
  const meta = (parts, locale) => parts.map((part) => textOf(part, locale)).join(", ");
  assert.equal(meta(view.meta), "Klip 03, 0:45, skor 8,4, Podcast 12.mp4, 20 Okt");
  assert.equal(clipCardView({ ...item, createdAt: new Date(2025, 0, 2).toISOString() }, new Date(2026, 9, 21)).day, "2 Jan 2025");
  // English names the clip and the day in English.
  const en = clipCardView({ ...item, score: null }, new Date(2026, 9, 21, 9, 0), "en");
  assert.equal(meta(en.meta, "en"), "Clip 03, 0:45, Podcast 12.mp4, Oct 20");

  const bare = clipCardView({ jobId: JOB_ID, index: 1, title: null, duration: null, posterUrl: null, score: null, projectName: "Proyek", createdAt: null });
  assert.equal(textOf(bare.title), "Klip 01");
  assert.equal(bare.length, null);
  assert.equal(bare.pill, null);
  assert.equal(bare.day, null);
  assert.equal(meta(bare.meta), "Klip 01, Proyek");
  for (const value of [meta(view.meta), meta(bare.meta), meta(en.meta, "en")]) assert.doesNotMatch(value, /hot|viral/i);
});

test("the pill comes from the shown total: one decimal, a mark from 8,0", () => {
  assert.deepEqual(scorePillFor(8), { text: "8,0", high: true });
  assert.deepEqual(scorePillFor(7.9), { text: "7,9", high: false });
  for (const value of [null, undefined, Number.NaN, "8"]) assert.equal(scorePillFor(value), null);
});

test("the summaries count clips and projects without inventing anything", () => {
  assert.equal(textOf(librarySummary({ total: 128, projects: 40 })), "128 klip dari 40 proyek");
  assert.equal(textOf(librarySummary({ total: 1, projects: 1 })), "1 klip dari 1 proyek");
  assert.equal(textOf(librarySummary({ total: 0, projects: 0 })), "Belum ada klip");
  assert.equal(textOf(shownSummary({ shown: 24, matched: 128 })), "24 dari 128 klip");
  assert.equal(textOf(shownSummary({ shown: 3, matched: 3 })), "3 klip");
  assert.equal(textOf(librarySummary({ total: 1, projects: 1 }), "en"), "1 clip from 1 project");
  assert.equal(textOf(librarySummary({ total: 128, projects: 40 }), "en"), "128 clips from 40 projects");
  assert.equal(textOf(shownSummary({ shown: 1, matched: 1 }), "en"), "1 clip");
});

test("the project page opens on the clip a link names", () => {
  assert.equal(clipFromParam("3"), 3);
  assert.equal(clipFromParam("9999"), 9999);
  for (const value of [undefined, null, "", "0", "03", "-1", "1.5", "10000", "x", ["3", "4"]]) assert.equal(clipFromParam(value), null, String(value));
  assert.equal(clipFromParam(["3"]), 3);
});

test("Proyek switches between 'Proyek' and 'Klip' tabs and remembers the choice", async () => {
  const page = await read("app/projects/page.jsx");
  // The tabs are HeroUI Tabs named from the catalog; the URL (?tab=) wins over the remembered one.
  assert.match(page, /<Tabs\.List aria-label=\{t\("tab\.label"\)\}>/);
  assert.match(page, /<Tabs\.Tab id="projects">\{t\("tab\.projects"\)\}<\/Tabs\.Tab>/);
  assert.match(page, /<Tabs\.Tab id="clips">\{t\("tab\.clips"\)\}<\/Tabs\.Tab>/);
  const projects = JSON.parse(await read("messages/id/projects.json"));
  assert.equal(projects.tab.projects, "Proyek");
  assert.equal(projects.tab.clips, "Klip");
  assert.match(page, /parsed\.tab \?\? readHistoryView\(browserStorage\(\)\)/);
  assert.match(page, /writeHistoryView\(browserStorage\(\), next\)/);
  assert.match(page, /<ClipLibrary\b/);
  const library = await read("components/ClipLibrary.jsx");
  assert.match(library, /href=\{clipHref\(item\)\}/);
  assert.match(library, /tc\("loadMore"\)/);
  assert.match(library, /tc\("score8"\)/);
  assert.match(library, /tc\("thisWeek"\)/);
  assert.equal(projects.clips.loadMore, "Muat lagi");
  assert.equal(projects.clips.score8, "Skor 8+");
  assert.equal(projects.clips.thisWeek, "Minggu ini");
  // Grouped by day with the moment the first page loaded, so "Muat lagi" never regroups what shows.
  assert.match(library, /groupClipsByDay\(page\.clips, page\.loadedAt\)/);
  assert.match(library, /<PosterThumb\b/);
  assert.doesNotMatch(library, /\bhot\b|viral/i);
  // The project page and the clip grid draw the same poster.
  const project = await read("app/projects/[id]/page.jsx");
  assert.match(project, /<PosterThumb\b/);
  assert.match(project, /<PosterText\b/);
  assert.match(project, /clipFromParam\(/);
  for (const source of [page, library, project]) {
    assert.doesNotMatch(source, /—/, "no em dash (R-02)");
    assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
  }
});
