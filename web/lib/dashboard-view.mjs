// Text the dashboard (app/dashboard/page.jsx) shows about jobs, clips and the AI setup.
// Client-safe. The owner's rule: only the current method on screen, no version labels and no
// technical provenance (selection source, prompt or engine versions); old jobs stay viewable.

export const JOB_STATUS_LABELS = Object.freeze({
  queued: "Dalam antrean",
  preparing: "Menyiapkan video",
  downloading: "Mengunduh dari YouTube",
  processing: "Memproses",
  completed: "Selesai",
  failed: "Gagal",
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
});

const STORAGE_MESSAGES = Object.freeze({
  storage_quota_exhausted: "Penyimpanan server tidak cukup untuk job baru.",
  storage_free_space_low: "Ruang kosong penyimpanan server terlalu rendah.",
  storage_admission_unavailable: "Status penyimpanan server tidak dapat diverifikasi. Coba lagi nanti.",
});

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
  return JOB_STAGE_LABELS[job?.stage] || JOB_STATUS_LABELS[job?.status] || "Memproses";
}

/** The live line under the progress bar: the worker's own detail, else what the job waits for. */
export function jobActivityText(job) {
  const detail = typeof job?.stageDetail === "string" ? job.stageDetail.trim() : "";
  if (detail) return detail;
  return job?.status === "queued" ? "Menunggu giliran worker." : "Worker sedang memproses video.";
}

export function jobFinished(job) {
  return job?.status === "completed" || job?.status === "failed";
}

/** "Klip 2 · 34 detik": number and length only. */
export function clipMetaText(clip) {
  const index = Number.isSafeInteger(clip?.index) && clip.index > 0 ? ` ${clip.index}` : "";
  const seconds = typeof clip?.duration === "number" && Number.isFinite(clip.duration) && clip.duration > 0
    ? ` · ${Math.round(clip.duration)} detik`
    : "";
  return `Klip${index}${seconds}`;
}

/** A failed job's reason in Indonesian, plus the worker's raw error for the disclosure, or null. */
export function jobFailureView(job) {
  if (job?.status !== "failed") return null;
  const error = typeof job.error === "string" && job.error.trim() ? job.error.trim() : null;
  if (error && Object.hasOwn(STORAGE_MESSAGES, error)) return { text: STORAGE_MESSAGES[error], detail: null };
  const stageDetail = typeof job.stageDetail === "string" && job.stageDetail.trim() ? job.stageDetail.trim() : null;
  return { text: stageDetail || "Proses berhenti karena terjadi kesalahan.", detail: error };
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
 * The mode the focus hints describe: "off" when the next job will pick moments without AI
 * (literal mentions only), else "auto". The worker decides at run time; this only words hints.
 */
export function focusAiMode(status) {
  return ["disabled", "unconfigured", "unusable", "invalid"].includes(status?.state) ? "off" : "auto";
}

// --- Form ------------------------------------------------------------------------------------

export function durationProblem(minimum, maximum) {
  const min = Number(minimum);
  const max = Number(maximum);
  if (Number.isFinite(min) && Number.isFinite(max) && min > max) return "Durasi maksimum tidak boleh kurang dari minimum.";
  return null;
}

// The job API accepts https links from these hosts only (lib/jobs.mjs validateYouTubeUrl).
const YOUTUBE_HOSTS = new Set(["youtu.be", "youtube.com", "www.youtube.com"]);

function youtubeUrlProblem(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "Tempel link YouTube dulu.";
  try {
    const url = new URL(text);
    if (url.protocol === "https:" && YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return null;
  } catch {
    // Not a URL at all: same message.
  }
  return "Link harus https:// dari youtube.com atau youtu.be.";
}

function inRange(value, minimum, maximum, integer = false) {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d+(?:\.\d+)?$/.test(text)) return false;
  const number = Number(text);
  return (!integer || Number.isInteger(number)) && number >= minimum && number <= maximum;
}

/**
 * Problems of the job form as { field: message }, empty when it can be sent. Mirrors the job
 * API's checks, so the owner sees Indonesian messages instead of the browser's.
 */
export function jobFormProblems({ sourceType, youtubeUrl, video, limit, minDuration, maxDuration } = {}) {
  const problems = {};
  if (sourceType === "upload") {
    if (!video) problems.video = "Pilih file video dulu.";
  } else {
    const problem = youtubeUrlProblem(youtubeUrl);
    if (problem) problems.youtubeUrl = problem;
  }
  if (!inRange(limit, 1, 10, true)) problems.limit = "Isi 1 sampai 10 klip.";
  if (!inRange(minDuration, 5, 180)) problems.minDuration = "Isi 5 sampai 180 detik.";
  if (!inRange(maxDuration, 5, 180)) problems.maxDuration = "Isi 5 sampai 180 detik.";
  if (!problems.minDuration && !problems.maxDuration) {
    const order = durationProblem(minDuration, maxDuration);
    if (order) problems.maxDuration = order;
  }
  return problems;
}

/** The message for a refused job POST: storage codes by name, else the API's own Indonesian text. */
export function submitErrorMessage(payload) {
  if (payload && Object.hasOwn(STORAGE_MESSAGES, payload.code)) return STORAGE_MESSAGES[payload.code];
  if (typeof payload?.error === "string" && payload.error.trim()) return payload.error.trim();
  return "Job gagal dibuat. Periksa isian lalu coba lagi.";
}
