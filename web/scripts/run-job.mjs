import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import {
  atomicWriteJson,
  generateSocialMetadata,
  parseWorkerProgress,
  sanitizeSelectionV2Summary,
  validatePersistedJobOptions,
} from "../lib/jobs.mjs";
import { LeaseLostError, fencedUpdateJob, publishAttemptAndComplete, validateClaimForExecution } from "../lib/primary-job-queue.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function buildClipperInvocation(job, sourcePath, outputRoot, env = process.env) {
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
  ];
  if (options.selectionMode === "v2-shadow") {
    args.push(
      "--selection-mode", "v2-shadow",
      "--artifact-root", path.dirname(outputRoot),
      "--clip-profile", options.clipProfile,
      "--max-candidates", String(options.maxCandidates),
      "--max-media-candidates", String(options.maxMediaCandidates),
      "--media-timeout", String(options.mediaTimeout),
    );
  }
  return { command: env.AI_CLIPPER_BIN || "/app/.venv/bin/ai-clipper", args };
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
  if (clips !== undefined) patch.clips = clips;
  return patch;
}

export function runFencedProcess({ command, args, env, heartbeatMs, progress, initialProgress = 0, update, spawnImpl = spawn, killImpl = process.kill.bind(process), escalationMs = 5_000 }) {
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
    child.once("error", (error) => { clearInterval(heartbeat); if (escalation) clearTimeout(escalation); reject(error); });
    child.once("close", async (code, signal) => {
      clearInterval(heartbeat);
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

  function run(command, args) {
    return runFencedProcess({ command, args, env, heartbeatMs, progress: false, update });
  }

  function runWithProgress(command, args, initialProgress) {
    return runFencedProcess({ command, args, env, heartbeatMs, progress: true, initialProgress, update });
  }

  try {
    let job = await update({ status: "preparing", progress: 5, error: null });
    let sourcePath = job.sourcePath;
    if (job.source.type === "youtube") {
      await update({ status: "downloading", progress: 10 });
      const downloadRoot = queueManaged ? path.join(attemptRoot, "input") : path.join(jobRoot, "input");
      await mkdir(downloadRoot, { recursive: true, mode: 0o700 });
      const template = path.join(downloadRoot, "source.%(ext)s");
      await run("yt-dlp", [
        "--no-playlist", "--js-runtimes", "node",
        "--format", "bv*[height<=720]+ba/b[height<=720]",
        "--merge-output-format", "mp4", "--output", template, job.source.url,
      ]);
      const files = await readdir(downloadRoot);
      const sourceFile = files.find((name) => name.startsWith("source.") && !name.endsWith(".part"));
      if (!sourceFile) throw new Error("Video YouTube selesai diunduh tetapi file sumber tidak ditemukan");
      sourcePath = path.join(downloadRoot, sourceFile);
      job = await update({ sourcePath, status: "processing", progress: 25, stage: "analyzing", stageDetail: "Menyiapkan engine AI" });
    } else {
      job = await update({ status: "processing", progress: 20, stage: "analyzing", stageDetail: "Menyiapkan engine AI" });
    }

    const invocation = buildClipperInvocation(job, sourcePath, outputRoot, env);
    await runWithProgress(invocation.command, invocation.args, job.progress);

    const manifest = JSON.parse(await readFile(path.join(outputRoot, "manifest.json"), "utf8"));
    if (manifest.status !== "completed" || !manifest.clips?.length) {
      throw new Error(manifest.error || "Engine tidak menghasilkan klip");
    }
    const clips = manifest.clips.map((clip) => {
      const filename = path.basename(clip.output);
      return {
        index: clip.index,
        score: clip.score,
        start: clip.start,
        end: clip.end,
        duration: clip.duration,
        text: clip.text,
        videoUrl: `/api/jobs/${id}/files/output/${encodeURIComponent(filename)}`,
        downloadUrl: `/api/jobs/${id}/files/output/${encodeURIComponent(filename)}?download=1`,
        subtitleUrl: `/api/jobs/${id}/files/output/${encodeURIComponent(path.basename(clip.subtitles))}?download=1`,
        ...generateSocialMetadata(clip.text),
      };
    });
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
