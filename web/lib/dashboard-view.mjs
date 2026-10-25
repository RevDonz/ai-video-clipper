// What the dashboard (app/dashboard/page.jsx) shows about jobs, clips and the AI setup, as
// catalog descriptors ({ key, values }, lib/i18n/descriptor.mjs; msg(t, …) gives the text).
// The worker's own stage detail and the job API's time-range text are data and pass as strings.
// Client-safe. The owner's rule: only the current method on screen, no version labels and no
// technical provenance (selection source, prompt or engine versions); old jobs stay viewable.

import { CLIP_LIMITS } from "./clip-limits.mjs";
import { downloadErrorMessage } from "./download-errors.mjs";
import { d } from "./i18n/descriptor.mjs";
import { MAX_SUBTITLE_BYTES } from "./srt.mjs";
import { shownStageDetail, shownWorkerText } from "./stage-detail.mjs";
import { timeRangesProblem } from "./time-ranges.mjs";

const frozen = (table) => Object.freeze(Object.fromEntries(Object.entries(table).map(([id, value]) => [id, Object.freeze(value)])));
const own = (table, key) => (typeof key === "string" && Object.hasOwn(table, key) ? table[key] : null);

/** The job statuses as descriptors. */
export const JOB_STATUS_LABELS = frozen({
  queued: d("dashboard.jobStatus.queued"),
  preparing: d("dashboard.jobStatus.preparing"),
  downloading: d("dashboard.jobStatus.downloading"),
  processing: d("dashboard.jobStatus.processing"),
  completed: d("dashboard.jobStatus.completed"),
  failed: d("dashboard.jobStatus.failed"),
  cancelled: d("dashboard.jobStatus.cancelled"),
  deleting: d("dashboard.jobStatus.deleting"),
});

// Stages the worker and the engine report for new jobs. Stages of retired modes have no label
// and fall back to the status.
export const JOB_STAGE_LABELS = frozen({
  captions: d("dashboard.jobStage.captions"),
  analyzing: d("dashboard.jobStage.analyzing"),
  transcribing: d("dashboard.jobStage.transcribing"),
  audio: d("dashboard.jobStage.audio"),
  llm: d("dashboard.jobStage.llm"),
  selecting: d("dashboard.jobStage.selecting"),
  packaging: d("dashboard.jobStage.packaging"),
  rendering: d("dashboard.jobStage.rendering"),
  finalizing: d("dashboard.jobStage.finalizing"),
  completed: d("dashboard.jobStage.completed"),
  failed: d("dashboard.jobStage.failed"),
  cancelled: d("dashboard.jobStage.cancelled"),
});

// The storage admission codes and their text (errors.storage.<code>); the help page
// (help-catalog.mjs) has an entry for each.
const STORAGE_TEXT = frozen({
  storage_quota_exhausted: d("errors.storage.storage_quota_exhausted"),
  storage_free_space_low: d("errors.storage.storage_free_space_low"),
  storage_admission_unavailable: d("errors.storage.storage_admission_unavailable"),
});
export const STORAGE_ERROR_CODES = Object.freeze(Object.keys(STORAGE_TEXT));
const isStorageCode = (code) => own(STORAGE_TEXT, code) !== null;

/** errors.storage.<code> of a storage code; an unknown code reads as "could not be verified". */
export function storageMessage(code) {
  return own(STORAGE_TEXT, code) ?? STORAGE_TEXT.storage_admission_unavailable;
}

/** The video a job came from, as the owner recognises it: file name or YouTube video ID. */
export function jobSourceLabel(job) {
  const source = job?.source;
  if (typeof source?.name === "string" && source.name.trim()) return source.name.trim();
  if (source?.type === "youtube") {
    try {
      const url = new URL(source.url);
      const id = url.searchParams.get("v") || url.pathname.split("/").filter(Boolean).at(-1);
      return id ? d("dashboard.job.youtubeId", { id }) : d("dashboard.job.youtube");
    } catch {
      return d("dashboard.job.youtube");
    }
  }
  if (source?.type === "upload") return d("dashboard.job.upload");
  return d("dashboard.job.video");
}

export function jobStageText(job) {
  // The transcript step of a job with an uploaded .srt reads that file, not YouTube's subtitles.
  if (job?.stage === "captions" && job.subtitle) return d("dashboard.jobStage.srt");
  return own(JOB_STAGE_LABELS, job?.stage) || own(JOB_STATUS_LABELS, job?.status) || d("dashboard.jobStage.fallback");
}

// The steps "Tahap n dari m" counts, in the order the engine reports them (pipeline.py; the test
// checks the order against it). A YouTube job starts with its download, subtitles included; the
// transcript step is YouTube's subtitles or the audio, the moments step the AI or the heuristic.
export const JOB_STEPS = Object.freeze([
  Object.freeze({ id: "download", stages: Object.freeze([]), youtube: true }),
  Object.freeze({ id: "video", stages: Object.freeze(["analyzing"]) }),
  Object.freeze({ id: "transcript", stages: Object.freeze(["captions", "transcribing"]) }),
  Object.freeze({ id: "audio", stages: Object.freeze(["audio"]) }),
  Object.freeze({ id: "moments", stages: Object.freeze(["llm", "selecting"]) }),
  Object.freeze({ id: "packaging", stages: Object.freeze(["packaging"]) }),
  Object.freeze({ id: "rendering", stages: Object.freeze(["rendering"]) }),
  Object.freeze({ id: "finalizing", stages: Object.freeze(["finalizing"]) }),
]);

/** "Tahap 4 dari 8" while a job downloads or is processed at a known stage; null otherwise. */
export function jobStepText(job) {
  const steps = JOB_STEPS.filter((step) => !step.youtube || job?.source?.type === "youtube");
  let index = -1;
  if (job?.status === "downloading") index = steps.findIndex((step) => step.id === "download");
  else if (job?.status === "processing") index = steps.findIndex((step) => step.stages.includes(job.stage));
  return index < 0 ? null : d("dashboard.job.step", { n: index + 1, total: steps.length });
}

/** The live line under the progress bar: the worker's own detail, else what the job waits for. */
export function jobActivityText(job) {
  const detail = shownStageDetail(job);
  if (detail) return detail;
  return job?.status === "queued" ? d("dashboard.job.waitingTurn") : d("dashboard.job.working");
}

/**
 * The job's progress as "42%", or null for a failed or cancelled job: its bar stays where it
 * stopped, and the number would read as progress still being made.
 */
export function jobPercentText(job) {
  if (job?.status === "failed" || job?.status === "cancelled") return null;
  const progress = typeof job?.progress === "number" && Number.isFinite(job.progress) ? job.progress : 0;
  return `${Math.round(Math.min(100, Math.max(0, progress)))}%`;
}

export function jobFinished(job) {
  return job?.status === "completed" || job?.status === "failed" || job?.status === "cancelled";
}

/** The line where the clips will appear, for a job that has none (yet). */
export function jobWaitingText(job) {
  return job?.status === "cancelled" ? d("dashboard.job.cancelledEarly") : d("dashboard.job.clipsSoon");
}

/** "Klip 2 · 34 detik": number and length only. */
export function clipMetaText(clip) {
  const index = Number.isSafeInteger(clip?.index) && clip.index > 0 ? clip.index : null;
  const seconds = typeof clip?.duration === "number" && Number.isFinite(clip.duration) && clip.duration > 0
    ? Math.round(clip.duration)
    : null;
  if (index !== null && seconds !== null) return d("dashboard.clipMeta.full", { index, seconds });
  if (index !== null) return d("dashboard.clipMeta.number", { index });
  if (seconds !== null) return d("dashboard.clipMeta.seconds", { seconds });
  return d("dashboard.clipMeta.plain");
}

/**
 * A failed job's reason, one suggestion when the failure has a known code (null otherwise), and
 * the worker's raw error for the disclosure; null for a job that did not fail.
 */
export function jobFailureView(job) {
  if (job?.status !== "failed") return null;
  const error = shownWorkerText(job.error);
  if (isStorageCode(error)) return { text: storageMessage(error), hint: null, detail: null };
  const download = downloadErrorMessage(job.errorCode);
  if (download) return { text: download.text, hint: download.hint, detail: error };
  return { text: shownStageDetail(job) || d("dashboard.job.stopped"), hint: null, detail: error };
}

// --- AI status (GET /api/llm/status) ---------------------------------------------------------

/** What the page keeps when the status route could not be read. */
export const AI_STATUS_UNREADABLE = Object.freeze({ state: "unreadable" });

const AI_STATE_VIEWS = frozen({
  disabled: { tone: "muted", text: d("dashboard.aiStatus.disabled") },
  unconfigured: { tone: "muted", text: d("dashboard.aiStatus.unconfigured") },
  unusable: { tone: "warning", text: d("dashboard.aiStatus.unusable") },
  invalid: { tone: "warning", text: d("dashboard.aiStatus.invalid") },
  unreadable: { tone: "warning", text: d("dashboard.aiStatus.unreadable") },
});
const MAX_SHOWN_PROVIDERS = 4;

function providerNames(status) {
  const order = Array.isArray(status.order) ? status.order.filter((name) => typeof name === "string" && name) : [];
  const providers = Array.isArray(status.providers) ? status.providers : [];
  return order.slice(0, MAX_SHOWN_PROVIDERS).map((name) => {
    const entry = providers.find((item) => item?.name === name);
    return typeof entry?.displayName === "string" && entry.displayName ? entry.displayName : name;
  });
}

/** One line about the AI the next job will use: { tone: "ok" | "muted" | "warning", text }. */
export function aiStatusView(status) {
  if (!status || typeof status !== "object") return { tone: "muted", text: d("dashboard.aiStatus.checking") };
  if (status.state === "active") {
    const names = providerNames(status);
    return { tone: "ok", text: names.length ? d("dashboard.aiStatus.activeNames", { names: names.join(" → ") }) : d("dashboard.aiStatus.active") };
  }
  const known = own(AI_STATE_VIEWS, status.state);
  if (known) return { tone: known.tone, text: known.text };
  return { tone: "warning", text: d("dashboard.aiStatus.unknown") };
}

/**
 * The alert Buat klip shows about the AI, only when something needs doing (rombak 05 §2 P6):
 * "missing" when no AI is set up, "notReady" when the set-up one cannot be used; null when it is
 * active, deliberately off, still being read or unreadable (a job runs either way).
 */
export function aiAlert(status) {
  if (status?.state === "unconfigured") return "missing";
  if (status?.state === "unusable" || status?.state === "invalid") return "notReady";
  return null;
}

/**
 * The mode the focus hints describe: "off" when the next job will pick moments without AI
 * (literal mentions only), else "auto". The worker decides at run time; this only words hints.
 */
export function focusAiMode(status) {
  return ["disabled", "unconfigured", "unusable", "invalid"].includes(status?.state) ? "off" : "auto";
}

// --- Form ------------------------------------------------------------------------------------

// The form's checks give codes; the text of each is dashboard.problem.<code>.
const PROBLEM_TEXT = Object.freeze({
  durationOrder: () => d("dashboard.problem.durationOrder"),
  linkEmpty: () => d("dashboard.problem.linkEmpty"),
  linkInvalid: () => d("dashboard.problem.linkInvalid"),
  videoMissing: () => d("dashboard.problem.videoMissing"),
  videoFormat: () => d("dashboard.problem.videoFormat"),
  srtType: () => d("dashboard.problem.srtType"),
  srtEmpty: () => d("dashboard.problem.srtEmpty"),
  srtTooLarge: () => d("dashboard.problem.srtTooLarge"),
  count: (values) => d("dashboard.problem.count", values),
  seconds: (values) => d("dashboard.problem.seconds", values),
});

/**
 * The text of a problem `{code, values?, text?}`: dashboard.problem.<code> as a descriptor, or a
 * time range problem's own text from the job API (lib/time-ranges.mjs).
 */
export function problemText(problem) {
  if (!problem) return null;
  if (typeof problem.text === "string") return problem.text;
  return own(PROBLEM_TEXT, problem.code)?.(problem.values) ?? null;
}

function durationOrderCode(minimum, maximum) {
  const min = Number(minimum);
  const max = Number(maximum);
  return Number.isFinite(min) && Number.isFinite(max) && min > max ? "durationOrder" : null;
}

export function durationProblem(minimum, maximum) {
  const code = durationOrderCode(minimum, maximum);
  return code ? problemText({ code }) : null;
}

// The job API accepts https links from these hosts only (lib/jobs.mjs YOUTUBE_HOSTS).
const YOUTUBE_HOSTS = new Set(["youtu.be", "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);

/** "linkEmpty", "linkInvalid", or null for a link the job API takes. */
export function youtubeUrlCode(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "linkEmpty";
  try {
    const url = new URL(text);
    if (url.protocol === "https:" && YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return null;
  } catch {
    // Not a URL at all: same code.
  }
  return "linkInvalid";
}

// The upload route takes these extensions only (app/api/jobs/route.js VIDEO_EXTENSIONS). A file
// picked through "All files" or dropped on the page skips the input's accept list.
const VIDEO_FILE = /\.(?:mp4|mov|mkv|webm|m4v)$/i;

/** "videoMissing", "videoFormat", or null for a file the upload route takes. */
export function videoFileCode(file) {
  if (!file) return "videoMissing";
  return typeof file.name === "string" && VIDEO_FILE.test(file.name) ? null : "videoFormat";
}

/** Why `file` cannot be sent as the job's video, or null. */
export function videoFileProblem(file) {
  const code = videoFileCode(file);
  return code ? problemText({ code }) : null;
}

/**
 * "srtType", "srtEmpty", "srtTooLarge", or null (also for no file). The job API checks the
 * content (lib/srt.mjs); this only catches what the browser already knows.
 */
export function subtitleFileCode(file) {
  if (!file) return null;
  if (typeof file.name !== "string" || !/\.srt$/i.test(file.name)) return "srtType";
  if (!(file.size > 0)) return "srtEmpty";
  return file.size > MAX_SUBTITLE_BYTES ? "srtTooLarge" : null;
}

/** Why `file` cannot go with the video as its subtitle, or null (also for no file). */
export function subtitleFileProblem(file) {
  const code = subtitleFileCode(file);
  return code ? problemText({ code }) : null;
}

function inRange(value, minimum, maximum, integer = false) {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d+(?:\.\d+)?$/.test(text)) return false;
  const number = Number(text);
  return (!integer || Number.isInteger(number)) && number >= minimum && number <= maximum;
}

/**
 * Problems of the job form as { field: {code, values?} }, empty when it can be sent. Mirrors the
 * job API's checks. A time range problem carries the job API's own Indonesian `text` (lib/time-ranges.mjs).
 */
export function jobFormProblemCodes({ sourceType, youtubeUrl, video, subtitle = null, limit, minDuration, maxDuration, timeRanges = "" } = {}) {
  const problems = {};
  const put = (field, code, values) => { if (code) problems[field] = values ? { code, values } : { code }; };
  if (sourceType === "upload") {
    put("video", videoFileCode(video));
    put("subtitle", subtitleFileCode(subtitle));
  } else {
    put("youtubeUrl", youtubeUrlCode(youtubeUrl));
  }
  const { count, seconds } = CLIP_LIMITS;
  const range = { min: seconds.min, max: seconds.max };
  if (!inRange(limit, count.min, count.max, true)) put("limit", "count", { min: count.min, max: count.max });
  if (!inRange(minDuration, seconds.min, seconds.max)) put("minDuration", "seconds", range);
  if (!inRange(maxDuration, seconds.min, seconds.max)) put("maxDuration", "seconds", range);
  if (!problems.minDuration && !problems.maxDuration) put("maxDuration", durationOrderCode(minDuration, maxDuration));
  // Rentang waktu: the job API's own check and message; the count only once it is a count.
  const ranges = timeRangesProblem(timeRanges, problems.limit ? null : Number(limit));
  if (ranges) problems.timeRanges = { code: "ranges", text: ranges };
  return problems;
}

/** The same problems as { field: descriptor (or the job API's text) }. */
export function jobFormProblems(fields = {}) {
  return Object.fromEntries(Object.entries(jobFormProblemCodes(fields)).map(([field, problem]) => [field, problemText(problem)]));
}

/**
 * The message for a refused job POST: a storage code by name, else the API's own text (the
 * fallback the page shows when its code has no catalog entry), else dashboard.submit.failed.
 */
export function submitErrorMessage(payload) {
  if (isStorageCode(payload?.code)) return storageMessage(payload.code);
  if (typeof payload?.error === "string" && payload.error.trim()) return payload.error.trim();
  return d("dashboard.submit.failed");
}
