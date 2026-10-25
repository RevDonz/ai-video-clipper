// The process status words (05-ui-dashboard.md §5): job.status to a status.process.<key> of the
// catalog plus the tone of its pill. Client-safe and text-free: components render the key
// (components/ProcessStatus.jsx).

const STATUS_KEYS = Object.freeze({
  queued: "queued",
  preparing: "running",
  downloading: "running",
  processing: "running",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  deleting: "deleting",
});

const TONES = Object.freeze({ completed: "success", failed: "danger" });

/** `{key, tone, running}` of a job's status; an unknown status is "unknown". */
export function processStatus(job) {
  const key = Object.hasOwn(STATUS_KEYS, job?.status) ? STATUS_KEYS[job.status] : "unknown";
  return { key, tone: TONES[key] ?? "default", running: key === "running" };
}
