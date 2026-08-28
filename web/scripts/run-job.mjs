import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { atomicWriteJson, generateSocialMetadata } from "../lib/jobs.mjs";

const id = process.argv[2];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
if (!UUID.test(id || "")) throw new Error("Invalid job ID");
const jobsRoot = path.resolve(process.env.JOBS_ROOT || "/data/jobs");
const jobRoot = path.join(jobsRoot, id);
const jobPath = path.join(jobRoot, "job.json");

async function readJob() {
  return JSON.parse(await readFile(jobPath, "utf8"));
}

async function update(patch) {
  const current = await readJob();
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  await atomicWriteJson(jobPath, next);
  return next;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", shell: false, env: process.env });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} gagal (${signal || `exit ${code}`})`));
    });
  });
}

try {
  let job = await update({ status: "preparing", progress: 5, error: null });
  let sourcePath = job.sourcePath;
  if (job.source.type === "youtube") {
    await update({ status: "downloading", progress: 10 });
    const template = path.join(jobRoot, "input", "source.%(ext)s");
    await run("yt-dlp", [
      "--no-playlist",
      "--js-runtimes",
      "node",
      "--format",
      "bv*[height<=720]+ba/b[height<=720]",
      "--merge-output-format",
      "mp4",
      "--output",
      template,
      job.source.url,
    ]);
    const files = await readdir(path.join(jobRoot, "input"));
    const sourceFile = files.find((name) => name.startsWith("source.") && !name.endsWith(".part"));
    if (!sourceFile) throw new Error("Video YouTube selesai diunduh tetapi file sumber tidak ditemukan");
    sourcePath = path.join(jobRoot, "input", sourceFile);
    job = await update({ sourcePath, status: "processing", progress: 25 });
  } else {
    job = await update({ status: "processing", progress: 20 });
  }

  const outputRoot = path.join(jobRoot, "output");
  await run("ai-clipper", [
    sourcePath,
    "--output-dir",
    outputRoot,
    "--model",
    process.env.WHISPER_MODEL || "small",
    "--device",
    process.env.WHISPER_DEVICE || "cpu",
    "--language",
    process.env.WHISPER_LANGUAGE || "id",
    "--min-duration",
    String(job.options.minDuration),
    "--max-duration",
    String(job.options.maxDuration),
    "--limit",
    String(job.options.limit),
    "--width",
    "720",
    "--height",
    "1280",
    "--render-mode",
    job.options.renderMode,
  ]);

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
  await update({ status: "completed", progress: 100, clips, completedAt: new Date().toISOString() });
} catch (error) {
  await update({ status: "failed", progress: 100, error: error.message || "Worker gagal" });
  process.exitCode = 1;
}
