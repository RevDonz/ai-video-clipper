// The job badge in the shared header (components/JobBadge.jsx): what it says, what it announces
// and when it asks the server again. Client-safe: no Node built-ins.

import { readyClips } from "./clip-status.mjs";
import { isActiveStatus, projectName, projectProgress } from "./project-view.mjs";
import { numberFormat } from "./i18n/format.mjs";
import { SOURCE_LOCALE } from "./i18n/locales.mjs";

/** Dispatched on window by a page that created, cancelled or deleted a job: the badge reads the list now. */
export const JOBS_CHANGED_EVENT = "potongin:jobs-changed";

export const BADGE_POLL = Object.freeze({
  runningMs: 5_000,
  // Nothing runs: the list is read only to notice a job started from another tab or device.
  idleMs: 60_000,
  maxBackoffMs: 300_000,
  // After this many failed requests in a row the badge hides instead of showing an old state.
  hideAfterFailures: 3,
});

const COUNT = numberFormat(SOURCE_LOCALE);
const SHOWN_FINISHED = new Set(["completed", "failed", "cancelled"]);

function validJobs(jobs) {
  return Array.isArray(jobs) ? jobs.filter((job) => job && typeof job.id === "string" && job.id) : [];
}

function createdTime(job) {
  return Date.parse(job.createdAt || job.updatedAt || 0) || 0;
}

const projectHref = (id) => `/projects/${encodeURIComponent(id)}`;
// A clip that failed to render has no file to post, so it is not counted.
const clipCount = (job) => readyClips(job.clips).length;

// The worker runs the queue oldest first, so the job it holds is the oldest one past "queued".
function followedJob(active) {
  return [...active].sort((left, right) => (
    Number(left.status === "queued") - Number(right.status === "queued") || createdTime(left) - createdTime(right)
  ))[0];
}

const LATEST = Object.freeze({
  completed: (job) => ({ text: `Terakhir: ${COUNT.format(clipCount(job))} klip`, short: `${COUNT.format(clipCount(job))} klip`, tone: null }),
  failed: () => ({ text: "Terakhir: gagal", short: "Gagal", tone: "danger" }),
  cancelled: () => ({ text: "Terakhir: dibatalkan", short: "Batal", tone: null }),
});

/**
 * The badge for a jobs list: the running jobs and the percentage of the one being worked on, else
 * the newest finished job; null when there is nothing to show.
 */
export function jobBadgeView(jobs) {
  const list = validJobs(jobs);
  const active = list.filter((job) => isActiveStatus(job.status));
  if (active.length) {
    const job = followedJob(active);
    const percent = `${COUNT.format(projectProgress(job))}%`;
    return {
      kind: "running", jobId: job.id, href: projectHref(job.id), title: projectName(job), tone: null,
      text: `${COUNT.format(active.length)} berjalan · ${percent}`, short: percent,
    };
  }
  // Newest by creation, the order Riwayat lists them in.
  const latest = list
    .filter((job) => SHOWN_FINISHED.has(job.status))
    .reduce((newest, job) => (!newest || createdTime(job) > createdTime(newest) ? job : newest), null);
  if (!latest) return null;
  return { kind: "latest", jobId: latest.id, href: projectHref(latest.id), title: projectName(latest), ...LATEST[latest.status](latest) };
}

const OUTCOME = Object.freeze({
  completed: (job) => `Proyek selesai: ${COUNT.format(clipCount(job))} klip`,
  failed: () => "Proyek gagal",
  cancelled: () => "Proyek dibatalkan",
});

/**
 * What the screen reader hears when the jobs change: only jobs that were running and have now
 * finished. Percentages, a job starting (the user's own action) and the first load stay silent.
 */
export function badgeAnnouncement(previous, next) {
  if (!Array.isArray(previous) || !Array.isArray(next)) return "";
  const wasActive = new Set(validJobs(previous).filter((job) => isActiveStatus(job.status)).map((job) => job.id));
  return validJobs(next)
    .filter((job) => wasActive.has(job.id) && SHOWN_FINISHED.has(job.status))
    .map((job) => OUTCOME[job.status](job))
    .join(". ");
}

export const INITIAL_BADGE_STATE = Object.freeze({ jobs: null, listAt: null, failures: 0, signedOut: false, announcement: "" });

function failed(state) {
  return { ...state, failures: state.failures + 1, announcement: "" };
}

// A poll sent before "Batalkan" answered must not bring a finished job back to life.
function withJob(jobs, job) {
  const list = Array.isArray(jobs) ? jobs : [];
  const current = list.find((item) => item.id === job.id);
  if (!current) return [job, ...list];
  if (!isActiveStatus(current.status) && isActiveStatus(job.status)) return list;
  return list.map((item) => (item.id === job.id ? job : item));
}

/** Events: list (jobs, at), job (job), missing (jobId), failed, signed-out. */
export function badgeReducer(state, event) {
  switch (event?.type) {
    case "list": {
      if (!Array.isArray(event.jobs)) return failed(state);
      const jobs = validJobs(event.jobs);
      return { ...state, jobs, listAt: event.at, failures: 0, signedOut: false, announcement: badgeAnnouncement(state.jobs, jobs) };
    }
    case "job": {
      if (!event.job || typeof event.job.id !== "string" || !event.job.id) return failed(state);
      const jobs = withJob(state.jobs, event.job);
      return { ...state, jobs, failures: 0, announcement: badgeAnnouncement(state.jobs, jobs) };
    }
    case "missing":
      return { ...state, jobs: validJobs(state.jobs).filter((job) => job.id !== event.jobId), failures: 0, announcement: "" };
    case "failed":
      return failed(state);
    case "signed-out":
      return { ...INITIAL_BADGE_STATE, signedOut: true };
    default:
      return state;
  }
}

export function badgeStateView(state) {
  if (state.signedOut || state.failures >= BADGE_POLL.hideAfterFailures) return null;
  return jobBadgeView(state.jobs);
}

/**
 * The next request and its delay, or null while the tab is hidden or the session is gone. While a
 * job runs only that job is read (one small file); the whole list, which carries every clip of
 * every project, is read once per idle interval and after any failure.
 */
export function nextBadgeRequest(state, { visible, now }) {
  if (!visible || state.signedOut) return null;
  const view = jobBadgeView(state.jobs);
  const running = view?.kind === "running";
  const base = running ? BADGE_POLL.runningMs : BADGE_POLL.idleMs;
  const delayMs = state.failures > 0 ? Math.min(base * 2 ** state.failures, BADGE_POLL.maxBackoffMs) : base;
  const listDue = state.listAt === null || now + delayMs - state.listAt >= BADGE_POLL.idleMs;
  if (running && state.failures === 0 && !listDue) return { kind: "job", jobId: view.jobId, delayMs };
  return { kind: "list", delayMs };
}

/** Tells the header badge to read the jobs now. */
export function notifyJobsChanged(target = globalThis.window) {
  target?.dispatchEvent?.(new Event(JOBS_CHANGED_EVENT));
}
