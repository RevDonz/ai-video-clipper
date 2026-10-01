// The worker's own stage and error texts, as the pages may show them. Client-safe.

// Old jobs that ran in a retired mode report stages such as "Kandidat bayangan V2 siap".
// Version wording stays in the job file, never on screen.
const VERSION_WORDING = /\bV\d\b|\bshadow\b|\bSelection\b/i;

/** The text when it is fit to show: non-empty after trimming and naming no version, else null. */
export function shownWorkerText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && !VERSION_WORDING.test(text) ? text : null;
}

/** The job's stage detail when it is fit to show, else null. */
export function shownStageDetail(job) {
  return shownWorkerText(job?.stageDetail);
}
