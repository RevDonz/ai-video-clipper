// GET /api/clips: the "Klip" view of Riwayat. Every rendered clip of every finished project,
// newest project first and in clip order within it, read from serializePublicJob's sanitized job
// only.
// Search (clip title, project name, source URL), "Skor 8+", "Minggu ini" and the "Muat lagi"
// pages run here. Work per request is bounded: job files are cached by (inode, size, mtime), a
// request reads at most `maxReads` changed files and `readBudgetBytes` (newest first, the rest on
// the next request, flagged `partial`), each file at most 2 MiB like the queue's own reads.
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";

import { isFailedClip } from "./clip-status.mjs";
import { CLIP_TEXT_LIMITS, normalizeYouTubeUrl, sanitizeLine, serializePublicJob } from "./jobs.mjs";
import { projectName } from "./project-view.mjs";
import { HIGH_SCORE, shownScore } from "./project-workspace.mjs";
import { ROUTE_PARAMS } from "./security-headers.mjs";
import { clipPosterUrl } from "./selection-v3-view.mjs";

export const CLIP_PAGE_SIZE = 24;
export const MAX_CLIP_PAGE_SIZE = 48;
export const MAX_QUERY_CHARS = 200;
export const MAX_JOB_FILE_BYTES = 2 * 1024 * 1024;
export const READ_BUDGET_BYTES = 24 * 1024 * 1024;
export const MAX_READS_PER_REQUEST = 400;

const JOB_ID = ROUTE_PARAMS.id;
const MAX_CLIP_INDEX = 9999;
const PROJECT_NAME_LIMIT = 160;
const STAT_BATCH = 64;
const LOCALE = "id-ID";
const YOUTUBE_ID = /^[A-Za-z0-9_-]{6,64}$/;
const ISO_MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const CURSOR = /^(0|[1-9]\d{0,15})\.([0-9a-f-]{36})\.([1-9]\d{0,3})$/;
const LIMIT = /^[1-9]\d{0,2}$/;

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** The video id of a YouTube link (watch, youtu.be, shorts, live, embed), or null. */
export function youtubeVideoId(value) {
  if (typeof value !== "string") return null;
  const normalized = normalizeYouTubeUrl(value.trim());
  if (!normalized) return null;
  const url = new URL(normalized);
  const parts = url.pathname.split("/").filter(Boolean);
  let candidate = null;
  if (url.hostname === "youtu.be") candidate = parts.length === 1 ? parts[0] : null;
  else if (parts[0] === "watch" && parts.length === 1) candidate = url.searchParams.get("v");
  else if (["shorts", "live", "embed"].includes(parts[0]) && parts.length === 2) candidate = parts[1];
  return typeof candidate === "string" && YOUTUBE_ID.test(candidate) ? candidate : null;
}

function createdAtMs(job) {
  for (const value of [job.createdAt, job.updatedAt]) {
    const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
    if (Number.isFinite(ms)) return Math.max(0, ms);
  }
  return 0;
}

function sourceUrlOf(job) {
  if (job.source?.type !== "youtube" || typeof job.source.url !== "string") return null;
  return normalizeYouTubeUrl(job.source.url) === job.source.url ? job.source.url : null;
}

/**
 * The listing items of one job file, read from its sanitized form. Only a finished job whose id
 * is its own directory's name; each clip once, numbered 1 to 9999. A clip that failed to render
 * (lib/clip-status.mjs) is left out: it has no video to find or post. `haystack` and `videoId`
 * stay on the server (search); publicItem drops them.
 */
export function libraryItems(raw, directoryName) {
  if (!isPlainObject(raw) || raw.id !== directoryName || !JOB_ID.test(directoryName) || raw.status !== "completed") return [];
  if (!Array.isArray(raw.clips)) return [];
  let job;
  try {
    job = serializePublicJob({ ...raw, clips: raw.clips.filter(isPlainObject) });
  } catch {
    return [];
  }
  const created = createdAtMs(job);
  const createdAt = created > 0 ? new Date(created).toISOString() : null;
  const name = sanitizeLine(projectName(job), PROJECT_NAME_LIMIT) || "Proyek";
  const sourceUrl = sourceUrlOf(job);
  const videoId = sourceUrl ? youtubeVideoId(sourceUrl) : null;
  const seen = new Set();
  const items = [];
  for (const clip of job.clips) {
    if (isFailedClip(clip)) continue;
    const index = clip.index;
    if (!Number.isSafeInteger(index) || index < 1 || index > MAX_CLIP_INDEX || seen.has(index)) continue;
    seen.add(index);
    const title = sanitizeLine(clip.title, CLIP_TEXT_LIMITS.title);
    const duration = typeof clip.duration === "number" && Number.isFinite(clip.duration) && clip.duration >= 0
      ? Math.round(clip.duration * 1000) / 1000 : null;
    items.push({
      jobId: job.id,
      index,
      title,
      duration,
      posterUrl: clipPosterUrl(clip) ?? null,
      score: shownScore(clip),
      projectName: name,
      sourceUrl,
      createdAt,
      createdAtMs: created,
      videoId,
      haystack: [title, name, sourceUrl].filter(Boolean).join("\n").toLocaleLowerCase(LOCALE),
    });
  }
  return items;
}

function publicItem(item) {
  return {
    jobId: item.jobId,
    index: item.index,
    title: item.title,
    duration: item.duration,
    posterUrl: item.posterUrl,
    score: item.score,
    projectName: item.projectName,
    sourceUrl: item.sourceUrl,
    createdAt: item.createdAt,
  };
}

/** Newest project first (its id breaks a tie), then the clip number. */
function compareItems(left, right) {
  if (left.createdAtMs !== right.createdAtMs) return right.createdAtMs - left.createdAtMs;
  if (left.jobId !== right.jobId) return left.jobId < right.jobId ? 1 : -1;
  return left.index - right.index;
}

const cursorOf = (item) => `${item.createdAtMs}.${item.jobId}.${item.index}`;

function single(params, name) {
  const values = params.getAll(name);
  if (values.length > 1) return { bad: true };
  return { value: values.length ? values[0] : null };
}

/**
 * The listing's query: `{query, high, since, cursor, limit}`, or null when any part is invalid
 * (each name at most once; `q` ≤ 200 characters; `high=1`; `since` an ISO moment; `cursor` from a
 * previous page; `limit` 1 to 48, default 24).
 */
export function parseClipLibraryQuery(params) {
  const fields = Object.fromEntries(["q", "high", "since", "cursor", "limit"].map((name) => [name, single(params, name)]));
  if (Object.values(fields).some((field) => field.bad)) return null;
  const q = fields.q.value === null ? "" : fields.q.value.trim();
  if (Array.from(q).length > MAX_QUERY_CHARS) return null;
  if (fields.high.value !== null && fields.high.value !== "1") return null;
  let since = null;
  if (fields.since.value !== null) {
    since = ISO_MOMENT.test(fields.since.value) ? Date.parse(fields.since.value) : Number.NaN;
    if (!Number.isFinite(since)) return null;
  }
  let cursor = null;
  if (fields.cursor.value !== null) {
    const match = CURSOR.exec(fields.cursor.value);
    if (!match || !JOB_ID.test(match[2])) return null;
    cursor = { createdAtMs: Number(match[1]), jobId: match[2], index: Number(match[3]) };
    if (!Number.isSafeInteger(cursor.createdAtMs)) return null;
  }
  let limit = CLIP_PAGE_SIZE;
  if (fields.limit.value !== null) {
    if (!LIMIT.test(fields.limit.value)) return null;
    limit = Number(fields.limit.value);
    if (limit > MAX_CLIP_PAGE_SIZE) return null;
  }
  return { query: q, high: fields.high.value === "1", since, cursor, limit };
}

function matcher({ query, high, since }) {
  const needle = query.toLocaleLowerCase(LOCALE);
  const videoId = query ? youtubeVideoId(query) : null;
  return (item) => {
    if (high && !(item.score !== null && item.score >= HIGH_SCORE)) return false;
    if (since !== null && item.createdAtMs < since) return false;
    if (!needle) return true;
    // A pasted link finds its video in whatever form the project stored it.
    if (videoId) return item.videoId === videoId;
    return item.haystack.includes(needle);
  };
}

const fileKey = (info) => `${info.ino}:${info.size}:${info.mtimeMs}`;

async function readJobFile(file, maxFileBytes) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxFileBytes) return { key: fileKey(info), size: 0, job: null };
    const text = await handle.readFile("utf8");
    let job = null;
    try { job = JSON.parse(text); } catch { /* a broken file lists nothing until it changes */ }
    return { key: fileKey(info), size: info.size, job };
  } finally {
    await handle.close();
  }
}

/**
 * The listing with its cache. One instance per server process (the route's default); a call with
 * another jobs root starts a fresh cache.
 */
export function createClipLibrary({ readBudgetBytes = READ_BUDGET_BYTES, maxReads = MAX_READS_PER_REQUEST, maxFileBytes = MAX_JOB_FILE_BYTES } = {}) {
  let cacheRoot = null;
  let cache = new Map();
  let sorted = null;
  let reads = 0;

  async function refresh(jobsRoot) {
    const root = path.resolve(jobsRoot);
    if (root !== cacheRoot) {
      cacheRoot = root;
      cache = new Map();
      sorted = null;
    }
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      entries = [];
    }
    const ids = entries.filter((entry) => entry.isDirectory() && JOB_ID.test(entry.name)).map((entry) => entry.name);
    const present = new Set(ids);
    for (const id of cache.keys()) {
      if (!present.has(id)) {
        cache.delete(id);
        sorted = null;
      }
    }

    const stale = [];
    for (let at = 0; at < ids.length; at += STAT_BATCH) {
      const batch = ids.slice(at, at + STAT_BATCH);
      const infos = await Promise.all(batch.map((id) => lstat(path.join(root, id, "job.json")).catch(() => null)));
      batch.forEach((id, position) => {
        const info = infos[position];
        if (!info?.isFile()) {
          if (cache.delete(id)) sorted = null;
          return;
        }
        if (cache.get(id)?.key !== fileKey(info)) stale.push({ id, size: info.size, mtimeMs: info.mtimeMs });
      });
    }

    stale.sort((left, right) => right.mtimeMs - left.mtimeMs);
    let used = 0;
    let done = 0;
    let pending = 0;
    for (const item of stale) {
      const size = Math.min(item.size, maxFileBytes);
      if (done > 0 && (done >= maxReads || used + size > readBudgetBytes)) {
        pending += 1;
        continue;
      }
      done += 1;
      let result;
      try {
        result = await readJobFile(path.join(root, item.id, "job.json"), maxFileBytes);
      } catch {
        if (cache.delete(item.id)) sorted = null;
        continue;
      }
      reads += 1;
      used += result.size;
      cache.set(item.id, { key: result.key, items: libraryItems(result.job, item.id) });
      sorted = null;
    }
    return { pending };
  }

  function allItems() {
    if (!sorted) sorted = [...cache.values()].flatMap((entry) => entry.items).sort(compareItems);
    return sorted;
  }

  /** One page: `{clips, matched, total, projects, nextCursor, partial}`. */
  async function list(jobsRoot, query) {
    const { pending } = await refresh(jobsRoot);
    const items = allItems();
    const matched = items.filter(matcher(query));
    const start = query.cursor ? matched.findIndex((item) => compareItems(item, query.cursor) > 0) : 0;
    const from = start < 0 ? matched.length : start;
    const page = matched.slice(from, from + query.limit);
    const more = from + page.length < matched.length;
    return {
      clips: page.map(publicItem),
      matched: matched.length,
      total: items.length,
      projects: new Set(items.map((item) => item.jobId)).size,
      nextCursor: more && page.length ? cursorOf(page.at(-1)) : null,
      partial: pending > 0,
    };
  }

  return { list, refresh, stats: () => ({ reads, cached: cache.size }) };
}

const sharedLibrary = createClipLibrary();

const MESSAGES = Object.freeze({
  invalid_request: "Permintaan tidak valid.",
  read_failed: "Klip tidak bisa dibaca sekarang. Coba lagi sebentar lagi.",
});

function answer(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

/** The route handler behind secureRoute. `deps`: `jobsRoot` and `library` for tests. */
export async function clipLibraryRoute(request, _context, deps = {}) {
  const jobsRoot = deps.jobsRoot || process.env.JOBS_ROOT || "/data/jobs";
  const library = deps.library || sharedLibrary;
  const query = parseClipLibraryQuery(new URL(request.url).searchParams);
  if (!query) return answer({ error: MESSAGES.invalid_request, code: "invalid_request" }, 400);
  try {
    return answer(await library.list(jobsRoot, query));
  } catch {
    return answer({ error: MESSAGES.read_failed, code: "read_failed" }, 503);
  }
}
