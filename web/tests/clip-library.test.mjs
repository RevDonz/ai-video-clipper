// GET /api/clips: the "Klip" view of Riwayat. Every clip of every finished project, newest
// project first, from sanitized job data only; search, "Skor 8+", "Minggu ini" and "Muat lagi"
// pages on the server, with bounded work per request (a cache keyed by the job file, a read
// budget, a size cap per file).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GET } from "../app/api/clips/route.js";
import { createSessionToken } from "../lib/auth.mjs";
import {
  CLIP_PAGE_SIZE,
  MAX_CLIP_PAGE_SIZE,
  MAX_JOB_FILE_BYTES,
  MAX_QUERY_CHARS,
  clipLibraryRoute,
  createClipLibrary,
  libraryItems,
  parseClipLibraryQuery,
  youtubeVideoId,
} from "../lib/clip-library.mjs";

const AUTH_ENV = {
  APP_USERNAME: "admin",
  APP_PASSWORD: "secret-value",
  APP_SESSION_SECRET: "a-long-random-session-secret-value",
};
const DAY = 86_400_000;
const NOW = Date.parse("2026-10-21T09:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const id = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;

function clip(jobId, index, extra = {}) {
  const base = `/api/jobs/${jobId}/files/output/clip-${String(index).padStart(2, "0")}`;
  return {
    index, start: 10 * index, end: 10 * index + 30, duration: 30.4, score: 7.2, selectionSource: "llm",
    title: `Klip ${index} dari ${jobId.slice(0, 8)}`, text: "transkrip rahasia", description: "Deskripsi.\n\n#fyp", hashtags: ["#fyp"],
    videoUrl: `${base}.mp4`, downloadUrl: `${base}.mp4?download=1`, subtitleUrl: `${base}.srt?download=1`,
    thumbnailUrl: `${base}.jpg`, ...extra,
  };
}

function job(n, { clips = 2, createdAt = NOW - n * DAY, ...extra } = {}) {
  const jobId = id(n);
  return {
    id: jobId, status: "completed", progress: 100, createdAt: iso(createdAt), updatedAt: iso(createdAt),
    source: { type: "upload", name: `Podcast ${n}.mp4` }, sourcePath: `/data/jobs/${jobId}/input/source.mp4`,
    options: { selectionMode: "v3" }, clips: Array.from({ length: clips }, (_, at) => clip(jobId, at + 1)),
    ...extra,
  };
}

async function root(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "potongin-clip-library-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** Writes job.json under its id; `mtime` (ms) orders the reads of a cold cache. */
async function put(directory, record, { mtime = null, raw = null, name = record?.id } = {}) {
  await mkdir(path.join(directory, name), { recursive: true });
  const file = path.join(directory, name, "job.json");
  await writeFile(file, raw ?? JSON.stringify(record));
  if (mtime !== null) await utimes(file, mtime / 1000, mtime / 1000);
  return file;
}

const query = (input = {}) => parseClipLibraryQuery(new URLSearchParams(input));
const keys = (clips) => clips.map((item) => `${item.jobId.slice(0, 8)}#${item.index}`);

test("the listing holds every clip of every finished project, newest project first, clips in order", async (t) => {
  const directory = await root(t);
  await put(directory, job(1, { clips: 2 }));
  await put(directory, job(3, { clips: 1 }));
  await put(directory, job(2, { clips: 3 }));
  await put(directory, job(4, { status: "processing", clips: 0 }));
  await put(directory, job(5, { status: "failed" }));
  await put(directory, job(6, { status: "deleting" }));
  await put(directory, job(7, { clips: 0 }));
  const library = createClipLibrary();
  const page = await library.list(directory, query());
  assert.deepEqual(keys(page.clips), [
    "00000001#1", "00000001#2", "00000002#1", "00000002#2", "00000002#3", "00000003#1",
  ]);
  assert.equal(page.total, 6);
  assert.equal(page.matched, 6);
  assert.equal(page.projects, 3);
  assert.equal(page.nextCursor, null);
  assert.equal(page.partial, false);
});

test("each clip carries only what its poster needs, from the sanitized job", async (t) => {
  const directory = await root(t);
  const record = job(1, { clips: 1 });
  record.clips[0] = clip(record.id, 1, {
    title: "Judul​ dengan\u0007 kontrol\n  dan spasi", score: 8.36, duration: 45.25,
    thumbnailUrl: `/api/jobs/${id(9)}/files/output/clip-01.jpg`,
  });
  record.source = { type: "youtube", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" };
  await put(directory, record);
  const [item] = (await createClipLibrary().list(directory, query())).clips;
  assert.deepEqual(Object.keys(item).sort(), [
    "createdAt", "duration", "index", "jobId", "posterUrl", "projectName", "score", "sourceUrl", "title",
  ]);
  assert.equal(item.jobId, id(1));
  assert.equal(item.index, 1);
  assert.equal(item.title, "Judul dengan kontrol dan spasi");
  assert.equal(item.score, 8.4, "the total as the pill shows it, one decimal");
  assert.equal(item.duration, 45.25);
  assert.equal(item.posterUrl, null, "a poster of another job is dropped by sanitizeStoredClip");
  assert.equal(item.sourceUrl, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(item.projectName, "YouTube · dQw4w9WgXcQ");
  assert.equal(item.createdAt, record.createdAt);
  const text = JSON.stringify(item);
  for (const secret of ["transkrip rahasia", "/data/jobs", "Deskripsi", "#fyp"]) assert.ok(!text.includes(secret), secret);
});

test("a clip keeps its own poster; an unscored clip and an upload have null score and source", async (t) => {
  const directory = await root(t);
  const record = job(1, { clips: 2 });
  record.clips[1] = { ...clip(record.id, 2), selectionSource: undefined, score: 61 };
  await put(directory, record);
  const [first, second] = (await createClipLibrary().list(directory, query())).clips;
  assert.equal(first.posterUrl, `/api/jobs/${id(1)}/files/output/clip-01.jpg`);
  assert.equal(first.sourceUrl, null);
  assert.equal(first.projectName, "Podcast 1.mp4");
  assert.equal(second.score, null, "a score off the 0-10 scale is not shown");
});

test("libraryItems drops clips without a usable number and repeats, and jobs that are not finished", () => {
  const record = job(1, { clips: 0 });
  record.clips = [clip(record.id, 0), clip(record.id, 2), clip(record.id, 2), clip(record.id, 10_000), clip(record.id, 1.5), null, "x", clip(record.id, 3)];
  assert.deepEqual(libraryItems(record, record.id).map((item) => item.index), [2, 3]);
  assert.deepEqual(libraryItems({ ...record, status: "failed" }, record.id), []);
  assert.deepEqual(libraryItems(record, id(2)), [], "the file must belong to its own directory");
  for (const value of [null, [], "job", 7]) assert.deepEqual(libraryItems(value, record.id), []);
});

test("a clip that failed to render is left out: it has no video to find or post", async (t) => {
  const record = job(1, { clips: 0 });
  const failed = { index: 2, status: "failed", errorCode: "render_timeout", score: 9.1, duration: 30, title: "Klip gagal" };
  record.clips = [clip(record.id, 1), failed, clip(record.id, 3)];
  assert.deepEqual(libraryItems(record, record.id).map((item) => item.index), [1, 3]);
  const directory = await root(t);
  await put(directory, record);
  const library = createClipLibrary();
  assert.deepEqual(keys((await library.list(directory, query())).clips), ["00000001#1", "00000001#3"]);
  const high = await library.list(directory, query({ high: "1" }));
  assert.deepEqual(high.clips, [], "'Skor 8+' does not bring it back");
  const search = await library.list(directory, query({ q: "gagal" }));
  assert.deepEqual(search.clips, []);
  assert.equal(search.total, 2, "the total counts the clips that rendered");
});

test("only job directories are read: no other names, no symlinks, no oversized or broken files", async (t) => {
  const directory = await root(t);
  await put(directory, job(1, { clips: 1 }));
  await put(directory, job(2, { clips: 1 }), { name: ".deletions" });
  await put(directory, job(3, { clips: 1 }), { name: "not-a-job" });
  await put(directory, job(4, { clips: 1 }), { raw: "{broken" });
  const big = job(5, { clips: 1 });
  big.padding = "x".repeat(MAX_JOB_FILE_BYTES);
  await put(directory, big);
  const outside = await root(t);
  await put(outside, job(6, { clips: 1 }));
  await symlink(path.join(outside, id(6)), path.join(directory, id(6)));
  const linkedFile = job(7, { clips: 1 });
  await mkdir(path.join(directory, id(7)));
  await put(outside, linkedFile, { name: "elsewhere" });
  await symlink(path.join(outside, "elsewhere", "job.json"), path.join(directory, id(7), "job.json"));
  await mkdir(path.join(directory, id(8)));
  const page = await createClipLibrary().list(directory, query());
  assert.deepEqual(keys(page.clips), ["00000001#1"]);
});

test("a missing jobs root is an empty library", async (t) => {
  const directory = await root(t);
  const page = await createClipLibrary().list(path.join(directory, "absent"), query());
  assert.deepEqual(page, { clips: [], matched: 0, total: 0, projects: 0, nextCursor: null, partial: false });
});

test("'Skor 8+' keeps clips whose shown score is 8,0 or more", async (t) => {
  const directory = await root(t);
  const record = job(1, { clips: 4 });
  for (const [at, score] of [7.9, 7.95, 8, 9.5].entries()) record.clips[at].score = score;
  await put(directory, record);
  const page = await createClipLibrary().list(directory, query({ high: "1" }));
  assert.deepEqual(page.clips.map((item) => item.index), [2, 3, 4]);
  assert.equal(page.matched, 3);
  assert.equal(page.total, 4);
});

test("'Minggu ini' keeps projects made since the given moment", async (t) => {
  const directory = await root(t);
  await put(directory, job(1, { clips: 1, createdAt: NOW - 2 * DAY }));
  await put(directory, job(2, { clips: 1, createdAt: NOW - 9 * DAY }));
  await put(directory, job(3, { clips: 1, createdAt: NOW - 3 * DAY, updatedAt: "x" }));
  const since = iso(NOW - 3 * DAY);
  const page = await createClipLibrary().list(directory, query({ since }));
  assert.deepEqual(keys(page.clips), ["00000001#1", "00000003#1"]);
  const both = await createClipLibrary().list(directory, query({ since, high: "1" }));
  assert.deepEqual(both.clips, []);
});

test("search matches the clip title, the project name or the source URL, in any case", async (t) => {
  const directory = await root(t);
  const first = job(1, { clips: 2 });
  first.clips[0].title = "Rahasia Hook di 3 Detik";
  first.clips[1].title = "Ngopi di Café";
  const second = job(2, { clips: 1, source: { type: "youtube", url: "https://www.youtube.com/watch?v=abcDEF12345" } });
  await put(directory, first);
  await put(directory, second);
  const library = createClipLibrary();
  const find = async (q) => keys((await library.list(directory, query({ q }))).clips);
  assert.deepEqual(await find("rahasia HOOK"), ["00000001#1"]);
  assert.deepEqual(await find("café"), ["00000001#2"]);
  assert.deepEqual(await find("podcast 1"), ["00000001#1", "00000001#2"], "the project name");
  assert.deepEqual(await find("watch?v=abcDEF"), ["00000002#1"], "part of the source URL");
  assert.deepEqual(await find("  "), ["00000001#1", "00000001#2", "00000002#1"], "blank is no search");
  assert.deepEqual(await find("tidak ada"), []);
  // A pasted link in another form finds the same video by its id.
  assert.deepEqual(await find("https://youtu.be/abcDEF12345?si=x"), ["00000002#1"]);
  assert.deepEqual(await find("https://m.youtube.com/watch?v=abcDEF12345&t=30"), ["00000002#1"]);
  assert.deepEqual(await find("https://www.youtube.com/shorts/abcDEF12345"), ["00000002#1"]);
  assert.deepEqual(await find("https://youtu.be/abcdef12345"), [], "video ids are case-sensitive");
});

test("youtubeVideoId reads the id from the link forms YouTube uses", () => {
  assert.equal(youtubeVideoId("https://www.youtube.com/watch?v=abcDEF12345"), "abcDEF12345");
  assert.equal(youtubeVideoId("https://youtube.com/watch?v=abcDEF12345&t=1"), "abcDEF12345");
  assert.equal(youtubeVideoId("https://youtu.be/abcDEF12345"), "abcDEF12345");
  assert.equal(youtubeVideoId("https://music.youtube.com/watch?v=abcDEF12345"), "abcDEF12345");
  for (const form of ["shorts", "live", "embed"]) assert.equal(youtubeVideoId(`https://www.youtube.com/${form}/abcDEF12345`), "abcDEF12345");
  for (const value of ["https://evil.example/watch?v=abcDEF12345", "http://youtu.be/abcDEF12345", "abcDEF12345", "https://youtu.be/", "https://youtu.be/a b", null]) {
    assert.equal(youtubeVideoId(value), null, String(value));
  }
});

test("'Muat lagi' pages follow a cursor; a project made in between does not shift them", async (t) => {
  const directory = await root(t);
  for (const n of [1, 2, 3, 4]) await put(directory, job(n, { clips: 3 }));
  const library = createClipLibrary();
  const first = await library.list(directory, query({ limit: "5" }));
  assert.equal(first.clips.length, 5);
  assert.equal(first.matched, 12);
  assert.equal(typeof first.nextCursor, "string");
  await put(directory, job(0, { clips: 2, createdAt: NOW + DAY }));
  const second = await library.list(directory, query({ limit: "5", cursor: first.nextCursor }));
  const third = await library.list(directory, query({ limit: "5", cursor: second.nextCursor }));
  assert.equal(third.nextCursor, null);
  assert.deepEqual([...keys(first.clips), ...keys(second.clips), ...keys(third.clips)], [
    "00000001#1", "00000001#2", "00000001#3", "00000002#1", "00000002#2",
    "00000002#3", "00000003#1", "00000003#2", "00000003#3", "00000004#1",
    "00000004#2", "00000004#3",
  ]);
  const fresh = await library.list(directory, query({ limit: "5" }));
  assert.deepEqual(keys(fresh.clips).slice(0, 2), ["00000000#1", "00000000#2"], "a new first page shows it");
});

test("the page size defaults to 24 and is never above 48", async (t) => {
  const directory = await root(t);
  for (const n of [1, 2, 3, 4, 5, 6]) await put(directory, job(n, { clips: 10 }));
  const library = createClipLibrary();
  assert.equal(CLIP_PAGE_SIZE, 24);
  assert.equal(MAX_CLIP_PAGE_SIZE, 48);
  assert.equal((await library.list(directory, query())).clips.length, 24);
  assert.equal((await library.list(directory, query({ limit: "48" }))).clips.length, 48);
  assert.equal(query({ limit: "49" }), null);
});

test("the query is checked: search length, flags, moments, cursors and sizes", () => {
  assert.deepEqual(query(), { query: "", high: false, since: null, cursor: null, limit: 24 });
  assert.deepEqual(query({ q: "  hook ", high: "1", since: "2026-10-19T17:00:00.000Z", limit: "12" }), {
    query: "hook", high: true, since: Date.parse("2026-10-19T17:00:00.000Z"), cursor: null, limit: 12,
  });
  assert.equal(query({ since: "2026-10-20T00:00:00+07:00" }).since, Date.parse("2026-10-19T17:00:00.000Z"));
  const cursor = `${NOW}.${id(1)}.3`;
  assert.deepEqual(query({ cursor }).cursor, { createdAtMs: NOW, jobId: id(1), index: 3 });
  assert.equal(MAX_QUERY_CHARS, 200);
  assert.equal(query({ q: "a".repeat(200) }).query.length, 200);
  for (const input of [
    { q: "a".repeat(201) }, { high: "0" }, { high: "true" }, { since: "kemarin" }, { since: "2026-10-20" },
    { since: "2026-13-40T00:00:00Z" }, { cursor: "x" }, { cursor: `${NOW}.${id(1)}.0` }, { cursor: `-1.${id(1)}.1` },
    { cursor: `${NOW}.not-a-job.1` }, { limit: "0" }, { limit: "1.5" }, { limit: "abc" }, { limit: "012" },
  ]) assert.equal(query(input), null, JSON.stringify(input));
  assert.equal(parseClipLibraryQuery(new URLSearchParams("q=a&q=b")), null, "one value per name");
});

test("an unchanged job file is read once; a changed one is read again", async (t) => {
  const directory = await root(t);
  await put(directory, job(1, { clips: 1 }));
  await put(directory, job(2, { clips: 1 }));
  const library = createClipLibrary();
  await library.list(directory, query());
  assert.equal(library.stats().reads, 2);
  await library.list(directory, query({ q: "podcast" }));
  await library.list(directory, query({ high: "1" }));
  assert.equal(library.stats().reads, 2, "searches and filters reuse the cache");
  const changed = job(2, { clips: 2 });
  changed.clips[1].title = "Judul baru";
  await put(directory, changed, { mtime: NOW + 5000 });
  const page = await library.list(directory, query({ q: "judul baru" }));
  assert.equal(library.stats().reads, 3);
  assert.deepEqual(keys(page.clips), ["00000002#2"]);
  await rm(path.join(directory, id(1)), { recursive: true });
  const after = await library.list(directory, query());
  assert.deepEqual(keys(after.clips), ["00000002#1", "00000002#2"], "a deleted project leaves the listing");
  assert.equal(library.stats().cached, 1);
});

test("one request reads within its budget; the rest follows on the next requests", async (t) => {
  const directory = await root(t);
  for (const n of [1, 2, 3, 4, 5]) await put(directory, job(n, { clips: 1 }), { mtime: NOW - n * 1000 });
  const library = createClipLibrary({ maxReads: 2 });
  const first = await library.list(directory, query());
  assert.equal(first.partial, true);
  assert.deepEqual(keys(first.clips), ["00000001#1", "00000002#1"], "the newest files first");
  const second = await library.list(directory, query());
  assert.equal(second.partial, true);
  const third = await library.list(directory, query());
  assert.equal(third.partial, false);
  assert.equal(third.total, 5);
  assert.equal(library.stats().reads, 5);

  const bytes = createClipLibrary({ readBudgetBytes: 1 });
  const one = await bytes.list(directory, query());
  assert.equal(one.clips.length, 1, "a request always reads at least one file");
  assert.equal(one.partial, true);
});

async function call(directory, search = "", { authenticated = true } = {}) {
  const names = ["JOBS_ROOT", ...Object.keys(AUTH_ENV)];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, AUTH_ENV, { JOBS_ROOT: directory });
  try {
    const headers = authenticated ? { Cookie: `potongin_session=${createSessionToken(AUTH_ENV, 2_000_000_000)}` } : {};
    return await GET(new Request(`http://local/api/clips${search}`, { headers }), { params: Promise.resolve({}) });
  } finally {
    for (const [name, value] of Object.entries(previous)) value === undefined ? delete process.env[name] : process.env[name] = value;
  }
}

function assertHeaders(response, label) {
  assert.equal(response.headers.get("cache-control"), "no-store", `${label}: no-store`);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff", `${label}: nosniff`);
}

test("the route needs a session, checks its query and is never cached", async (t) => {
  const directory = await root(t);
  await put(directory, job(1, { clips: 2 }));
  const denied = await call(directory, "", { authenticated: false });
  assert.equal(denied.status, 401);
  assertHeaders(denied, "401");

  const ok = await call(directory, "?limit=1");
  assert.equal(ok.status, 200);
  assertHeaders(ok, "200");
  const body = await ok.json();
  assert.deepEqual(keys(body.clips), ["00000001#1"]);
  assert.equal(body.matched, 2);
  assert.equal(typeof body.nextCursor, "string");

  const invalid = await call(directory, "?limit=500");
  assert.equal(invalid.status, 400);
  assertHeaders(invalid, "400");
  assert.deepEqual(await invalid.json(), { error: "Permintaan tidak valid.", code: "invalid_request" });
});

test("a jobs root that cannot be read answers 503 without naming it", async (t) => {
  const directory = await root(t);
  const file = path.join(directory, "file");
  await writeFile(file, "x");
  const response = await clipLibraryRoute(new Request("http://local/api/clips"), {}, { jobsRoot: file, library: createClipLibrary() });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, "read_failed");
  assert.ok(!JSON.stringify(body).includes(directory));
});
