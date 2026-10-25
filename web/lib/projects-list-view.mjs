// Proyek (/projects, 05-ui-dashboard.md §6.8) in the browser: the tab, status filter and search
// kept in the URL (?tab=proyek|klip, ?status=semua|diproses|selesai|gagal, ?q=), the filter
// counts, the status pill, the clip count and the batch delete. Copy is returned as catalog
// descriptors (lib/i18n/descriptor.mjs). Client-safe: no Node built-ins.

import { historyOffersEdit } from "./clip-entry-view.mjs";
import { readyClips } from "./clip-status.mjs";
import { d } from "./i18n/descriptor.mjs";
import { isActiveStatus, projectProgress } from "./project-view.mjs";

export const PROJECT_TABS = Object.freeze(["projects", "clips"]);
export const PROJECT_STATUS_FILTERS = Object.freeze(["all", "running", "done", "failed"]);
export const PROJECT_PAGE_SIZE = 25;
export const DELETE_CONCURRENCY = 4;
const QUERY_LIMIT = 200;

// The words in the address bar are Indonesian and stay so in every UI language (07 §5: slugs
// and query values are language-neutral).
const TAB_PARAM = Object.freeze({ projects: "proyek", clips: "klip" });
const STATUS_PARAM = Object.freeze({ all: "semua", running: "diproses", done: "selesai", failed: "gagal" });
const fromParam = (map, value) => Object.keys(map).find((key) => map[key] === value) ?? null;

/** `{tab, status, q}` from a query string; tab is null when the URL names none (the remembered one applies). */
export function parseProjectsQuery(search) {
  const params = search instanceof URLSearchParams ? search : new URLSearchParams(String(search ?? ""));
  return {
    tab: fromParam(TAB_PARAM, params.get("tab")),
    status: fromParam(STATUS_PARAM, params.get("status")) ?? "all",
    q: (params.get("q") ?? "").slice(0, QUERY_LIMIT),
  };
}

/** The address of a view: only what differs from the default; the clip tab drops the project filter. */
export function projectsHref({ tab = "projects", status = "all", q = "" } = {}) {
  const params = new URLSearchParams();
  if (tab === "clips") params.set("tab", TAB_PARAM.clips);
  else {
    if (status !== "all" && STATUS_PARAM[status]) params.set("status", STATUS_PARAM[status]);
    const query = String(q ?? "").trim();
    if (query) params.set("q", query);
  }
  const search = params.toString();
  return search ? `/projects?${search}` : "/projects";
}

/** The one filter a job falls under besides Semua, or null (cancelled, deleting). */
export function statusFilterOf(job) {
  const status = job?.status;
  if (status === "completed") return "done";
  if (status === "failed") return "failed";
  if (status === "cancelled" || status === "deleting") return null;
  return isActiveStatus(status) ? "running" : null;
}

export function matchesStatusFilter(job, filter) {
  return filter === "all" || statusFilterOf(job) === filter;
}

export function projectCounts(jobs) {
  const counts = { all: 0, running: 0, done: 0, failed: 0 };
  for (const job of Array.isArray(jobs) ? jobs : []) {
    counts.all += 1;
    const filter = statusFilterOf(job);
    if (filter) counts[filter] += 1;
  }
  return counts;
}

const PROCESS_KEY = Object.freeze({
  queued: "queued",
  preparing: "running",
  downloading: "running",
  processing: "running",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  deleting: "deleting",
});
const PROCESS_WORD = Object.freeze({
  queued: d("status.process.queued"),
  running: d("status.process.running"),
  completed: d("status.process.completed"),
  failed: d("status.process.failed"),
  cancelled: d("status.process.cancelled"),
  deleting: d("status.process.deleting"),
  unknown: d("status.process.unknown"),
});
const TONE = Object.freeze({ completed: "success", failed: "danger" });

/** The pill: `{label, tone, running}`; a running job shows its progress next to the word. */
export function projectStatusView(job) {
  const word = PROCESS_KEY[job?.status] ?? "unknown";
  const status = PROCESS_WORD[word];
  const running = word === "queued" || word === "running";
  const label = word === "running" ? d("projects.status.progress", { status, percent: projectProgress(job) }) : status;
  return { label, tone: TONE[word] ?? "default", running };
}

/** How many clips a finished project has to watch; null while it is not finished. */
export function projectClipCount(job) {
  return job?.status === "completed" ? readyClips(job.clips).length : null;
}

/** The clip "Edit klip" opens (the first rendered one), or null when the project offers no edit. */
export function editableClipIndex(job, editor) {
  if (!historyOffersEdit(job, editor)) return null;
  const index = readyClips(job.clips)[0]?.index;
  return Number.isInteger(index) ? index : null;
}

/**
 * Deletes `ids` with `remove(id)` → `{ok, removed}`, at most DELETE_CONCURRENCY at once.
 * `removed` lists the projects gone at once, `marked` those the server is still removing
 * (status "deleting"), `failed` those refused or unreachable. Never throws.
 */
export async function deleteProjects(ids, remove, { concurrency = DELETE_CONCURRENCY } = {}) {
  const list = Array.isArray(ids) ? [...ids] : [];
  const outcome = new Map();
  let next = 0;
  async function lane() {
    while (next < list.length) {
      const id = list[next];
      next += 1;
      try {
        const result = await remove(id);
        outcome.set(id, result?.ok ? (result.removed === false ? "marked" : "removed") : "failed");
      } catch {
        outcome.set(id, "failed");
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, lane));
  const pick = (kind) => list.filter((id) => outcome.get(id) === kind);
  return { removed: pick("removed"), marked: pick("marked"), failed: pick("failed") };
}

/** The toast after a delete: all gone, some refused, or none. A project still being removed counts as gone. */
export function deleteToast({ removed = [], marked = [], failed = [] } = {}) {
  const ok = removed.length + marked.length;
  if (!failed.length) return { variant: "success", title: d("projects.delete.done", { count: ok }) };
  if (!ok) return { variant: "danger", title: d("projects.delete.failed", { count: failed.length }) };
  return { variant: "warning", title: d("projects.delete.partial", { ok, failed: failed.length }) };
}
