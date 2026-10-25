// Text the dashboard (app/dashboard/page.jsx) shows about jobs, clips and the AI setup.
// Client-safe. The owner's rule: only the current method on screen, no version labels and no
// technical provenance (selection source, prompt or engine versions); old jobs stay viewable.

import { CLIP_LIMITS } from "./clip-limits.mjs";
import { downloadErrorMessage } from "./download-errors.mjs";
import { MAX_SUBTITLE_BYTES } from "./srt.mjs";
import { shownStageDetail, shownWorkerText } from "./stage-detail.mjs";
import { timeRangesProblem } from "./time-ranges.mjs";

export const JOB_STATUS_LABELS = Object.freeze({
  queued: "Dalam antrean",
  preparing: "Menyiapkan video",
  downloading: "Mengunduh dari YouTube",
  processing: "Memproses",
  completed: "Selesai",
  failed: "Gagal",
  cancelled: "Dibatalkan",
  deleting: "Sedang dihapus",
});

// Stages the worker and the engine report for new jobs. Stages of retired modes have no label
// and fall back to the status.
export const JOB_STAGE_LABELS = Object.freeze({
  captions: "Mengambil subtitle YouTube",
  analyzing: "Memeriksa video",
  transcribing: "Membuat transkrip",
  audio: "Menganalisis audio",
  llm: "AI memilih momen",
  selecting: "Memilih momen",
  packaging: "Menyiapkan judul dan hook",
  rendering: "Merender klip",
  finalizing: "Menyimpan hasil",
  completed: "Selesai",
  failed: "Gagal",
  cancelled: "Dibatalkan",
});

const STORAGE_MESSAGES = Object.freeze({
  storage_quota_exhausted: "Penyimpanan server tidak cukup untuk job baru.",
  storage_free_space_low: "Ruang kosong penyimpanan server terlalu rendah.",
  storage_admission_unavailable: "Status penyimpanan server tidak dapat diverifikasi. Coba lagi nanti.",
});

// The help page (help-catalog.mjs) has an entry for each code.
export const STORAGE_ERROR_CODES = Object.freeze(Object.keys(STORAGE_MESSAGES));

export function storageMessage(code) {
  return STORAGE_MESSAGES[code] || STORAGE_MESSAGES.storage_admission_unavailable;
}

/** The video a job came from, as the owner recognises it: file name or YouTube video ID. */
export function jobSourceLabel(job) {
  const source = job?.source;
  if (typeof source?.name === "string" && source.name.trim()) return source.name.trim();
  if (source?.type === "youtube") {
    try {
      const url = new URL(source.url);
      const id = url.searchParams.get("v") || url.pathname.split("/").filter(Boolean).at(-1);
      return id ? `YouTube · ${id}` : "Video YouTube";
    } catch {
      return "Video YouTube";
    }
  }
  if (source?.type === "upload") return "Video unggahan";
  return "Video";
}

export function jobStageText(job) {
  // The transcript step of a job with an uploaded .srt reads that file, not YouTube's subtitles.
  if (job?.stage === "captions" && job.subtitle) return "Membaca subtitle .srt";
  return JOB_STAGE_LABELS[job?.stage] || JOB_STATUS_LABELS[job?.status] || "Memproses";
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
  return index < 0 ? null : `Tahap ${index + 1} dari ${steps.length}`;
}

/** The live line under the progress bar: the worker's own detail, else what the job waits for. */
export function jobActivityText(job) {
  const detail = shownStageDetail(job);
  if (detail) return detail;
  return job?.status === "queued" ? "Menunggu giliran diproses." : "Video sedang diproses.";
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
  return job?.status === "cancelled" ? "Proses dibatalkan sebelum klip selesai." : "Klip muncul di sini setelah selesai dirender.";
}

/** "Klip 2 · 34 detik": number and length only. */
export function clipMetaText(clip) {
  const index = Number.isSafeInteger(clip?.index) && clip.index > 0 ? ` ${clip.index}` : "";
  const seconds = typeof clip?.duration === "number" && Number.isFinite(clip.duration) && clip.duration > 0
    ? ` · ${Math.round(clip.duration)} detik`
    : "";
  return `Klip${index}${seconds}`;
}

/**
 * A failed job's reason in Indonesian, one suggestion when the failure has a known code (null
 * otherwise), and the worker's raw error for the disclosure; null for a job that did not fail.
 */
export function jobFailureView(job) {
  if (job?.status !== "failed") return null;
  const error = shownWorkerText(job.error);
  if (error && Object.hasOwn(STORAGE_MESSAGES, error)) return { text: STORAGE_MESSAGES[error], hint: null, detail: null };
  const download = downloadErrorMessage(job.errorCode);
  if (download) return { text: download.text, hint: download.hint, detail: error };
  return { text: shownStageDetail(job) || "Proses berhenti karena terjadi kesalahan.", hint: null, detail: error };
}

// --- AI status (GET /api/llm/status) ---------------------------------------------------------

/** What the page keeps when the status route could not be read. */
export const AI_STATUS_UNREADABLE = Object.freeze({ state: "unreadable" });

const HEURISTIC = "Momen dipilih heuristik lokal.";
const AI_STATE_TEXT = Object.freeze({
  disabled: ["muted", `AI dimatikan. ${HEURISTIC}`],
  unconfigured: ["muted", `AI belum diatur. ${HEURISTIC}`],
  unusable: ["warning", `AI belum siap. ${HEURISTIC}`],
  invalid: ["warning", `Pengaturan AI tidak valid. ${HEURISTIC}`],
  unreadable: ["warning", "Status AI tidak terbaca. Job tetap berjalan."],
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
  if (!status || typeof status !== "object") return { tone: "muted", text: "Memeriksa AI…" };
  if (status.state === "active") {
    const names = providerNames(status);
    return { tone: "ok", text: names.length ? `AI aktif: ${names.join(" → ")}` : "AI aktif" };
  }
  const known = AI_STATE_TEXT[status.state];
  if (known) return { tone: known[0], text: known[1] };
  return { tone: "warning", text: "Status AI tidak dikenal. Job tetap berjalan." };
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

// The form's checks give codes (dashboard.problem.<code> in the catalog, rendered by the page);
// the Indonesian texts below are what jobFormProblems() and the older callers read.
const PROBLEM_TEXT = Object.freeze({
  durationOrder: () => "Durasi maksimum tidak boleh kurang dari minimum.",
  linkEmpty: () => "Tempel link YouTube atau pilih file video.",
  linkInvalid: () => "Link harus https:// dari youtube.com atau youtu.be.",
  videoMissing: () => "Pilih file video dulu.",
  videoFormat: () => "Format tidak didukung. Pakai MP4, MOV, MKV atau WEBM.",
  srtType: () => "Subtitle harus file .srt.",
  srtEmpty: () => "File .srt kosong.",
  srtTooLarge: () => "Subtitle .srt maksimal 2 MB.",
  count: ({ min, max }) => `Isi ${min} sampai ${max} klip.`,
  seconds: ({ min, max }) => `Isi ${min} sampai ${max} detik.`,
});

/** The Indonesian text of a problem descriptor `{code, values?, text?}`. */
export function problemText(problem) {
  if (!problem) return null;
  if (typeof problem.text === "string") return problem.text;
  return PROBLEM_TEXT[problem.code]?.(problem.values ?? {}) ?? null;
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

/** The same problems as { field: Indonesian message }. */
export function jobFormProblems(fields = {}) {
  return Object.fromEntries(Object.entries(jobFormProblemCodes(fields)).map(([field, problem]) => [field, problemText(problem)]));
}

/** The message for a refused job POST: storage codes by name, else the API's own Indonesian text. */
export function submitErrorMessage(payload) {
  if (payload && Object.hasOwn(STORAGE_MESSAGES, payload.code)) return STORAGE_MESSAGES[payload.code];
  if (typeof payload?.error === "string" && payload.error.trim()) return payload.error.trim();
  return "Job gagal dibuat. Periksa isian lalu coba lagi.";
}
