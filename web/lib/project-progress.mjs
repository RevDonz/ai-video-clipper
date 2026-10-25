// The progress panel of a project page (05-ui-dashboard.md §6.4): a stepper Unduh · Transkrip ·
// Pilih momen · Render, the queue position and how many clips are ready. Client-safe and
// text-free: the page renders the step ids and counts through the catalog (project.step.*).
//
// The step comes from the stage the worker reports: stageCode from the coded worker (i18n M5),
// job.stage for old jobs. A stage the tables do not know leaves the step where the status puts it.
import { readyClips } from "./clip-status.mjs";

export const PROGRESS_STEPS = Object.freeze(["download", "transcript", "moments", "render"]);

// job.stage (src/ai_clipper/pipeline.py report()) -> step.
const STAGE_STEPS = Object.freeze({
  captions: "transcript",
  analyzing: "transcript",
  transcribing: "transcript",
  audio: "transcript",
  llm: "moments",
  selecting: "moments",
  packaging: "moments",
  rendering: "render",
  finalizing: "render",
});

// stageCode (lib/i18n/stage.mjs STAGE_CODES, 07 §10.4) -> step. Codes that say nothing about the
// step (engine_busy, the end-of-job codes) are left out, so job.stage decides.
const CODE_STEPS = Object.freeze({
  analyze_video: "transcript", engine_prepare: "transcript",
  captions_upload: "transcript", captions_upload_ready: "transcript", captions_check: "transcript", captions_fetch: "transcript",
  transcribe_groq: "transcript", transcribe_groq_progress: "transcript", transcribe_audio: "transcript", transcribe_progress: "transcript",
  audio_analysis: "transcript",
  candidates_generating: "moments", candidates_features: "moments", candidates_shortlist: "moments", candidates_media: "moments",
  candidates_ready: "moments",
  select_llm: "moments", select_heuristic: "moments", select_ranges: "moments", select_moments: "moments", packaging: "moments",
  reframe: "render", render_clip: "render", finalizing: "render", clips_ready: "render", clips_partial: "render",
});

// The download codes by their prefix (04 §A8.1, §B1), the rest by the table.
function codeStep(code) {
  if (typeof code !== "string" || !code) return null;
  if (code.startsWith("fetch_")) return "download";
  return Object.hasOwn(CODE_STEPS, code) ? CODE_STEPS[code] : null;
}

const ACTIVE = new Set(["queued", "preparing", "downloading", "processing"]);

/** Whether the job downloads its source first (a link, not an upload). */
function downloads(job) {
  return job?.source?.type === "youtube" || job?.source?.type === "link";
}

/** The step a running job is in, or null while it waits in the queue (or is not running). */
export function currentStep(job) {
  if (!ACTIVE.has(job?.status) || job.status === "queued") return null;
  const step = codeStep(job.stageCode) ?? STAGE_STEPS[job.stage] ?? null;
  if (job.status === "downloading" || (job.status === "preparing" && downloads(job))) {
    // The worker fetches YouTube subtitles while the job is still downloading.
    return downloads(job) ? "download" : step;
  }
  if (step) return step === "download" && !downloads(job) ? "transcript" : step;
  return downloads(job) && job.status === "preparing" ? "download" : "transcript";
}

/**
 * The stepper: `[{id, state}]` with state "done", "current" or "todo"; an upload has no Unduh
 * step. A queued job has every step to do; a finished one has none shown (null).
 */
export function progressSteps(job) {
  if (!ACTIVE.has(job?.status)) return null;
  const ids = PROGRESS_STEPS.filter((id) => id !== "download" || downloads(job));
  const current = currentStep(job);
  const at = current ? ids.indexOf(current) : -1;
  return ids.map((id, index) => ({ id, state: at < 0 ? "todo" : index < at ? "done" : index === at ? "current" : "todo" }));
}

/**
 * Where a queued job waits (02 §10.3, from Fase 6): `{position, etaSeconds}` (eta null when
 * unknown), `{held: "maintenance"}`, or null without a known position.
 */
export function queueView(job) {
  if (job?.status !== "queued") return null;
  const queue = job.queue && typeof job.queue === "object" ? job.queue : null;
  if (queue?.held === "maintenance") return { held: "maintenance" };
  const position = Number.isSafeInteger(queue?.position) && queue.position > 0 ? queue.position : null;
  if (position === null) return null;
  const eta = Number.isFinite(queue.etaSeconds) && queue.etaSeconds >= 0 ? Math.round(queue.etaSeconds) : null;
  return { position, etaSeconds: eta };
}

/** Clips already rendered while the job still runs (they show in the grid as they come). */
export function readyCount(job) {
  return readyClips(job?.clips).length;
}

/** "± 6 mnt": whole minutes of a wait, at least one. */
export function etaMinutes(seconds) {
  return Number.isFinite(seconds) ? Math.max(1, Math.round(seconds / 60)) : null;
}
