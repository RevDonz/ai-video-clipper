import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { lstat, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import {
  CLIP_TEXT_LIMITS,
  atomicWriteJson,
  clipSocialMetadata,
  parseWorkerProgress,
  sanitizeLine,
  sanitizeManifestClipFields,
  sanitizeSelectionV2Summary,
  sanitizeSelectionV3Summary,
  validatePersistedJobOptions,
} from "../lib/jobs.mjs";
import { engineProcessEnv, loadLlmEnv } from "../lib/llm-settings.mjs";
import { LeaseLostError, fencedUpdateJob, publishAttemptAndComplete, validateClaimForExecution } from "../lib/primary-job-queue.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function buildClipperInvocation(job, sourcePath, outputRoot, env = process.env, { captionsDir = null } = {}) {
  if (!job || typeof job !== "object" || !job.options || typeof job.options !== "object" || Array.isArray(job.options)) {
    throw new Error("Invalid persisted job options");
  }
  const options = validatePersistedJobOptions(job.options);
  const args = [
    sourcePath,
    "--output-dir",
    outputRoot,
    "--model",
    env.WHISPER_MODEL || "small",
    "--device",
    env.WHISPER_DEVICE || "cpu",
    "--language",
    env.WHISPER_LANGUAGE || "id",
    "--min-duration",
    String(options.minDuration),
    "--max-duration",
    String(options.maxDuration),
    "--limit",
    String(options.limit),
    "--width",
    "720",
    "--height",
    "1280",
    "--render-mode",
    options.renderMode,
    // Every selection mode writes analysis/ beside output/, so a queue attempt
    // publishes both together (publishAttemptAndComplete) and a legacy run
    // writes straight into the job directory where the web readers look.
    "--artifact-root",
    path.dirname(outputRoot),
  ];
  if (options.selectionMode === "v2-shadow") {
    args.push(
      "--selection-mode", "v2-shadow",
      "--clip-profile", options.clipProfile,
      "--max-candidates", String(options.maxCandidates),
      "--max-media-candidates", String(options.maxMediaCandidates),
      "--media-timeout", String(options.mediaTimeout),
    );
  }
  if (options.selectionMode === "v3") {
    // V3 sizes clips from --min-duration/--max-duration above; clip profiles are V2 only.
    args.push(
      "--selection-mode", "v3",
      "--llm", options.llmMode,
      options.coldOpen ? "--cold-open" : "--no-cold-open",
      options.hookOverlay ? "--hook-overlay" : "--no-hook-overlay",
      "--caption-style", options.captionStyle,
    );
    if (typeof captionsDir === "string" && path.isAbsolute(captionsDir)) args.push("--captions-dir", captionsDir);
  }
  return { command: env.AI_CLIPPER_BIN || "/app/.venv/bin/ai-clipper", args };
}

// --- YouTube captions (Selection V3 fast path) --------------------------------
// Two optional yt-dlp runs after the video download: uploaded (manual) Indonesian
// subtitles and YouTube's automatic captions, both as json3. They never fail the
// job; the engine decides whether the captions are good enough to skip Whisper.

export const CAPTION_LANGUAGES = Object.freeze({ manual: "id,id-ID,in", auto: "id,id-orig" });
const DEFAULT_CAPTIONS_TIMEOUT_MS = 120_000;

export function captionsTimeoutMs(env = process.env) {
  const raw = env.POTONGIN_CAPTIONS_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_CAPTIONS_TIMEOUT_MS;
  const value = Number(raw);
  return /^[1-9]\d*$/.test(raw) && Number.isSafeInteger(value) && value >= 5_000 && value <= 600_000
    ? value
    : DEFAULT_CAPTIONS_TIMEOUT_MS;
}

// --ignore-errors keeps one failing language (an HTTP 429 on "id-ID", say) from
// aborting the rest of that run; whatever .json3 files landed are used.
export function buildCaptionDownloads(url, inputRoot) {
  const captionsRoot = path.join(inputRoot, "captions");
  const common = ["--no-playlist", "--js-runtimes", "node", "--skip-download", "--ignore-errors"];
  return [
    {
      kind: "manual",
      directory: path.join(captionsRoot, "manual"),
      args: [
        ...common, "--write-subs", "--no-write-auto-subs", "--sub-langs", CAPTION_LANGUAGES.manual,
        "--sub-format", "json3", "--output", path.join(captionsRoot, "manual", "source.%(ext)s"), url,
      ],
    },
    {
      kind: "auto",
      directory: path.join(captionsRoot, "auto"),
      args: [
        ...common, "--write-auto-subs", "--no-write-subs", "--sub-langs", CAPTION_LANGUAGES.auto,
        "--sub-format", "json3", "--output", path.join(captionsRoot, "auto", "source.%(ext)s"), url,
      ],
    },
  ];
}

/** `<inputRoot>/captions` when it holds at least one non-empty .json3 file, else null. */
export async function findCaptionsDir(inputRoot) {
  const captionsRoot = path.join(inputRoot, "captions");
  for (const kind of ["manual", "auto"]) {
    const directory = path.join(captionsRoot, kind);
    let names;
    try { names = await readdir(directory); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith(".json3") || name.startsWith(".")) continue;
      try {
        const info = await lstat(path.join(directory, name));
        if (info.isFile() && info.size > 0) return captionsRoot;
      } catch {
        // A file that vanished or cannot be read is simply not a caption.
      }
    }
  }
  return null;
}

export async function fetchYouTubeCaptions({ url, inputRoot, run, timeoutMs, log = console.warn }) {
  for (const download of buildCaptionDownloads(url, inputRoot)) {
    try {
      await mkdir(download.directory, { recursive: true, mode: 0o700 });
      await run("yt-dlp", download.args, { timeoutMs });
    } catch (error) {
      if (error instanceof LeaseLostError) throw error;
      log(`Subtitle YouTube (${download.kind}) dilewati: ${error?.message || "yt-dlp gagal"}`);
    }
  }
  return findCaptionsDir(inputRoot);
}

// yt-dlp executes YouTube's player JavaScript (--js-runtimes node); it never needs
// the engine's LLM keys, the settings that seal them, or the dashboard's secrets.
const DOWNLOADER_SECRET = /^(?:POTONGIN_LLM|POTONGIN_LLM_.*|POTONGIN_SETTINGS_.*|[A-Z0-9_]*API_KEY|APP_PASSWORD|APP_SESSION_SECRET)$/;

// The engine environment for this job: the LLM settings saved on the
// Pengaturan page (or, without a settings file, the inherited environment),
// minus the dashboard's own credentials.
export async function engineEnvironment(env, log = console.warn) {
  const llm = await loadLlmEnv(env);
  if (llm.problem) log(`Pengaturan AI tidak bisa dibaca (${llm.problem}); LLM dimatikan untuk job ini dan heuristik dipakai.`);
  return engineProcessEnv(llm.env);
}

export function downloaderEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !DOWNLOADER_SECRET.test(name)));
}

// --- Manifest -> job clips ---------------------------------------------------

function manifestNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function jobClipFromManifest(clip, id, position = 0) {
  if (!clip || typeof clip !== "object" || Array.isArray(clip)) throw new Error("Manifest klip tidak valid");
  const filename = path.basename(clip.output);
  const text = sanitizeLine(clip.text, CLIP_TEXT_LIMITS.text) || "";
  const base = {
    index: Number.isSafeInteger(clip.index) && clip.index > 0 ? clip.index : position + 1,
    score: manifestNumber(clip.score),
    start: manifestNumber(clip.start),
    end: manifestNumber(clip.end),
    duration: manifestNumber(clip.duration),
    text,
    videoUrl: `/api/jobs/${id}/files/output/${encodeURIComponent(filename)}`,
    downloadUrl: `/api/jobs/${id}/files/output/${encodeURIComponent(filename)}?download=1`,
    subtitleUrl: `/api/jobs/${id}/files/output/${encodeURIComponent(path.basename(clip.subtitles))}?download=1`,
  };
  const packaging = sanitizeManifestClipFields(clip);
  const merged = { ...base, ...packaging };
  return { ...merged, ...clipSocialMetadata(merged) };
}

export function nextWorkerProgress(current, event) {
  return {
    status: "processing",
    progress: Math.max(current.progress, event.progress),
    stage: event.stage,
    stageDetail: event.detail,
  };
}

export function manifestJobPatch(manifest, clips) {
  const patch = {};
  const selectionV2 = sanitizeSelectionV2Summary(manifest.selection_v2);
  if (selectionV2) patch.selectionV2 = selectionV2;
  const selectionV3 = sanitizeSelectionV3Summary(manifest.selection_v3);
  if (selectionV3) patch.selectionV3 = selectionV3;
  if (clips !== undefined) patch.clips = clips;
  return patch;
}

export class ProcessTimeoutError extends Error {
  constructor(command, timeoutMs) {
    super(`${command} melewati batas waktu ${Math.round(timeoutMs / 1000)} detik`);
    this.name = "ProcessTimeoutError";
  }
}

export function runFencedProcess({ command, args, env, heartbeatMs, progress, initialProgress = 0, update, spawnImpl = spawn, killImpl = process.kill.bind(process), escalationMs = 5_000, timeoutMs = null }) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { stdio: progress ? ["ignore", "pipe", "pipe"] : "inherit", shell: false, env, detached: true });
    let current = { progress: initialProgress, stage: "analyzing" };
    let updateQueue = Promise.resolve();
    let updateError = null;
    let terminating = false;
    let escalation = null;
    const terminate = (error) => {
      updateError ||= error;
      if (terminating || !child.pid) return;
      terminating = true;
      try { killImpl(-child.pid, "SIGTERM"); } catch (killError) { if (killError.code !== "ESRCH") updateError ||= killError; }
      escalation = setTimeout(() => { escalation = null; try { killImpl(-child.pid, "SIGKILL"); } catch {} }, escalationMs);
      escalation.unref?.();
    };
    const publish = (patch) => {
      updateQueue = updateQueue.then(() => update({ ...patch, activityAt: new Date().toISOString() })).catch(terminate);
    };
    if (progress) {
      const stdout = createInterface({ input: child.stdout });
      stdout.on("line", (line) => {
        const event = parseWorkerProgress(line);
        if (!event) { process.stdout.write(`${line}\n`); return; }
        if (event.progress > current.progress || event.stage !== current.stage) {
          const patch = nextWorkerProgress(current, event);
          current = { ...current, ...patch };
          publish(patch);
        }
      });
      child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    }
    const heartbeat = setInterval(() => publish(progress
      ? nextWorkerProgress(current, { progress: current.progress, stage: current.stage, detail: "Engine AI masih aktif pada tahap ini" })
      : {}), heartbeatMs);
    const deadline = Number.isSafeInteger(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => terminate(new ProcessTimeoutError(command, timeoutMs)), timeoutMs)
      : null;
    deadline?.unref?.();
    child.once("error", (error) => { clearInterval(heartbeat); if (deadline) clearTimeout(deadline); if (escalation) clearTimeout(escalation); reject(error); });
    child.once("close", async (code, signal) => {
      clearInterval(heartbeat);
      if (deadline) clearTimeout(deadline);
      if (escalation) clearTimeout(escalation);
      await updateQueue;
      if (updateError) reject(updateError);
      else if (code === 0) resolve();
      else reject(new Error(`${command} gagal (${signal || `exit ${code}`})`));
    });
  });
}

export async function main(argv = process.argv, env = process.env) {
  const id = argv[2];
  if (!UUID.test(id || "")) throw new Error("Invalid job ID");
  const jobsRoot = path.resolve(env.JOBS_ROOT || "/data/jobs");
  const jobRoot = path.join(jobsRoot, id);
  const jobPath = path.join(jobRoot, "job.json");
  const leaseToken = argv[3];
  let initialJob = JSON.parse(await readFile(jobPath, "utf8"));
  const queueManaged = Boolean(initialJob.queue);
  const leaseMs = Number(env.PRIMARY_LEASE_MS);
  if (queueManaged && (typeof leaseToken !== "string" || !Number.isSafeInteger(leaseMs) || leaseMs < 5_000)) {
    throw new LeaseLostError("A valid primary job lease is required");
  }
  if (queueManaged) {
    initialJob = (await validateClaimForExecution({ jobsRoot, claim: { job: { id }, token: leaseToken } })).job;
  }
  const heartbeatMs = queueManaged ? Math.max(1_000, Math.floor(leaseMs / 3)) : 15_000;
  const attemptId = queueManaged ? crypto.createHash("sha256").update(leaseToken).digest("hex") : null;
  const attemptRoot = queueManaged ? path.join(jobRoot, ".attempts", attemptId) : jobRoot;
  const outputRoot = path.join(attemptRoot, "output");
  await mkdir(attemptRoot, { recursive: true, mode: 0o700 });

  async function readJob() {
    return JSON.parse(await readFile(jobPath, "utf8"));
  }

  async function update(patch) {
    if (queueManaged) {
      return fencedUpdateJob({ jobsRoot, id, token: leaseToken, leaseMs, patch });
    }
    const current = await readJob();
    if (current.queue !== undefined) throw new LeaseLostError("Legacy primary runner was superseded by queue migration");
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await atomicWriteJson(jobPath, next);
    return next;
  }

  function run(command, args, { timeoutMs = null, processEnv = env } = {}) {
    return runFencedProcess({ command, args, env: processEnv, heartbeatMs, progress: false, update, timeoutMs });
  }

  function runWithProgress(command, args, initialProgress, processEnv = env) {
    return runFencedProcess({ command, args, env: processEnv, heartbeatMs, progress: true, initialProgress, update });
  }

  try {
    let job = await update({ status: "preparing", progress: 5, error: null });
    let sourcePath = job.sourcePath;
    let captionsDir = null;
    if (job.source.type === "youtube") {
      await update({ status: "downloading", progress: 10 });
      const downloadRoot = queueManaged ? path.join(attemptRoot, "input") : path.join(jobRoot, "input");
      await mkdir(downloadRoot, { recursive: true, mode: 0o700 });
      const template = path.join(downloadRoot, "source.%(ext)s");
      await run("yt-dlp", [
        "--no-playlist", "--js-runtimes", "node",
        "--format", "bv*[height<=720]+ba/b[height<=720]",
        "--merge-output-format", "mp4", "--output", template, job.source.url,
      ], { processEnv: downloaderEnv(env) });
      const files = await readdir(downloadRoot);
      const sourceFile = files.find((name) => name.startsWith("source.") && !name.endsWith(".part"));
      if (!sourceFile) throw new Error("Video YouTube selesai diunduh tetapi file sumber tidak ditemukan");
      sourcePath = path.join(downloadRoot, sourceFile);
      if (job.options?.selectionMode === "v3") {
        await update({ sourcePath, progress: 20, stage: "captions", stageDetail: "Mengambil subtitle YouTube (opsional)" });
        captionsDir = await fetchYouTubeCaptions({
          url: job.source.url,
          inputRoot: downloadRoot,
          timeoutMs: captionsTimeoutMs(env),
          run: (command, args, options) => run(command, args, { ...options, processEnv: downloaderEnv(env) }),
        });
      }
      job = await update({ sourcePath, status: "processing", progress: 25, stage: "analyzing", stageDetail: "Menyiapkan engine AI" });
    } else {
      job = await update({ status: "processing", progress: 20, stage: "analyzing", stageDetail: "Menyiapkan engine AI" });
    }

    const invocation = buildClipperInvocation(job, sourcePath, outputRoot, env, { captionsDir });
    await runWithProgress(invocation.command, invocation.args, job.progress, await engineEnvironment(env));

    const manifest = JSON.parse(await readFile(path.join(outputRoot, "manifest.json"), "utf8"));
    if (manifest.status !== "completed" || !manifest.clips?.length) {
      throw new Error(sanitizeLine(manifest.error, 500) || "Engine tidak menghasilkan klip");
    }
    const clips = manifest.clips.map((clip, position) => jobClipFromManifest(clip, id, position));
    const completedPatch = {
      status: "completed",
      progress: 100,
      stage: "completed",
      stageDetail: "Semua klip siap digunakan",
      ...manifestJobPatch(manifest, clips),
      completedAt: new Date().toISOString(),
    };
    if (queueManaged) await publishAttemptAndComplete({ jobsRoot, id, token: leaseToken, attemptOutput: outputRoot, patch: completedPatch });
    else await update(completedPatch);
  } catch (error) {
    if (error instanceof LeaseLostError) throw error;
    let pipelineSummary = {};
    try {
      const failedManifest = JSON.parse(await readFile(path.join(outputRoot, "manifest.json"), "utf8"));
      pipelineSummary = manifestJobPatch(failedManifest);
    } catch {
      // The pipeline may fail before publishing an output manifest.
    }
    await update({
      status: "failed",
      progress: 100,
      stage: "failed",
      stageDetail: "Proses berhenti karena terjadi kesalahan",
      ...pipelineSummary,
      error: error.message || "Worker gagal",
    });
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
