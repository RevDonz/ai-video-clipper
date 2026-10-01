// Presentation helpers for the project history (/projects) and one project's page
// (/projects/[id]). Client-safe: no Node built-ins.

import { formatTimestamp } from "./selection-v3-view.mjs";

export const STATUS_LABELS = Object.freeze({
  queued: "Menunggu",
  preparing: "Menyiapkan",
  downloading: "Mengunduh",
  processing: "Diproses",
  completed: "Selesai",
  failed: "Gagal",
  deleting: "Menghapus",
});

const FINISHED = new Set(["completed", "failed", "deleting"]);

export function statusLabel(status) {
  return Object.hasOwn(STATUS_LABELS, status) ? STATUS_LABELS[status] : "Status tidak dikenal";
}

/** Whether the worker may still change this job (queued, downloading, processing, ...). */
export function isActiveStatus(status) {
  return !FINISHED.has(status);
}

export function projectProgress(job) {
  const value = Number(job?.progress);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0;
}

function youtubeId(url) {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("v") || parsed.pathname.split("/").filter(Boolean).at(-1) || null;
  } catch {
    return null;
  }
}

export function projectName(job) {
  if (typeof job?.source?.name === "string" && job.source.name.trim()) return job.source.name;
  if (job?.source?.type === "youtube") {
    const id = youtubeId(job.source.url);
    return id ? `YouTube · ${id}` : "Video YouTube";
  }
  return typeof job?.id === "string" && job.id ? `Proyek ${job.id.slice(0, 8)}` : "Proyek";
}

const DATE_FORMAT = new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short" });

export function formatProjectDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.valueOf()) ? DATE_FORMAT.format(date) : "Tanggal tidak tersedia";
}

/** "Klip 03 · 1:21": the clip's number and length, as the card and the download name show it. */
export function clipLabel(clip) {
  const number = `Klip ${String(clip?.index ?? "").padStart(2, "0")}`;
  const length = formatTimestamp(clip?.duration);
  return length ? `${number} · ${length}` : number;
}

/** The history row's second line after the date: the clip count, or where an unfinished job stands. */
export function projectRowDetail(job) {
  const stage = typeof job?.stageDetail === "string" ? job.stageDetail.trim() : "";
  if (job?.status === "completed") return `${Array.isArray(job.clips) ? job.clips.length : 0} klip`;
  if (job?.status === "deleting") return "Sedang dihapus";
  if (job?.status === "failed") return stage || "Berhenti sebelum selesai";
  return stage || "Sedang diproses";
}

// A machine code such as "storage_admission_unavailable" or "llm_error:rate_limited".
const MACHINE_CODE = /^[a-z0-9]+(?:[_:][a-z0-9_.:-]+)+$/;

/**
 * The worker's own message for a failed project, when it adds something to the stage text:
 * words, not a bare code (codes stay in the job file), and not a repeat of the stage text.
 */
export function failureDetail(job) {
  if (job?.status !== "failed" || typeof job.error !== "string") return null;
  const error = job.error.trim();
  if (!error || MACHINE_CODE.test(error)) return null;
  const stage = typeof job.stageDetail === "string" ? job.stageDetail.trim() : "";
  return error === stage ? null : error;
}

export function historySummary(jobs) {
  const list = Array.isArray(jobs) ? jobs : [];
  const clips = list.reduce((total, job) => total + (Array.isArray(job?.clips) ? job.clips.length : 0), 0);
  return clips ? `${list.length} proyek · ${clips} klip` : `${list.length} proyek`;
}

export const PROJECT_FILTERS = Object.freeze([
  Object.freeze({ value: "all", label: "Semua" }),
  Object.freeze({ value: "completed", label: "Selesai" }),
  Object.freeze({ value: "active", label: "Berjalan" }),
  Object.freeze({ value: "failed", label: "Gagal" }),
]);

export function matchesProjectFilter(job, filter) {
  if (filter === "all") return true;
  if (filter === "active") return isActiveStatus(job?.status);
  return job?.status === filter;
}

export function matchesProjectQuery(job, query) {
  const needle = String(query ?? "").trim().toLocaleLowerCase("id-ID");
  if (!needle) return true;
  const clips = Array.isArray(job?.clips) ? job.clips : [];
  return [projectName(job), job?.id, job?.source?.url, ...clips.flatMap((clip) => [clip?.title, clip?.text])]
    .filter((value) => typeof value === "string")
    .some((value) => value.toLocaleLowerCase("id-ID").includes(needle));
}

export class ProjectDetailLoadError extends Error {
  constructor(message, kind = "request") {
    super(message);
    this.name = "ProjectDetailLoadError";
    this.kind = kind;
  }
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

/** The job behind /projects/[id], or where to go when the session expired. */
export async function loadProjectDetail(id, { fetchImpl = fetch, signal } = {}) {
  let response;
  try {
    response = await fetchImpl(`/api/jobs/${encodeURIComponent(id)}`, { cache: "no-store", signal });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new ProjectDetailLoadError("Proyek tidak bisa dimuat. Periksa koneksi, lalu coba lagi.", "network");
  }
  if (response.status === 401) {
    return { type: "redirect", location: `/login?next=${encodeURIComponent(`/projects/${id}`)}` };
  }
  if (response.status === 404) {
    throw new ProjectDetailLoadError("Proyek ini tidak ada atau sudah dihapus.", "not-found");
  }
  const payload = await readJson(response);
  if (!response.ok || !payload?.job || typeof payload.job !== "object") {
    throw new ProjectDetailLoadError("Proyek tidak bisa dimuat. Coba lagi sebentar lagi.");
  }
  return { type: "loaded", job: payload.job };
}
