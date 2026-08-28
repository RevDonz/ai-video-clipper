import crypto from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { requireAuth } from "../../../lib/auth.mjs";
import {
  atomicWriteJson,
  parseJobOptions,
  validateYouTubeUrl,
} from "../../../lib/jobs.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const jobsRoot = () => path.resolve(process.env.JOBS_ROOT || "/data/jobs");

function publicJob(job) {
  const { sourcePath: _sourcePath, ...safe } = job;
  return safe;
}

export async function GET(request) {
  const denied = requireAuth(request);
  if (denied) return denied;
  await mkdir(jobsRoot(), { recursive: true });
  const entries = await readdir(jobsRoot(), { withFileTypes: true });
  const jobs = [];
  for (const entry of entries.filter((item) => item.isDirectory()).slice(-25).reverse()) {
    try {
      const value = JSON.parse(await readFile(path.join(jobsRoot(), entry.name, "job.json"), "utf8"));
      jobs.push(publicJob(value));
    } catch {
      // Ignore incomplete directories; job state is published atomically.
    }
  }
  return Response.json({ jobs });
}

export async function POST(request) {
  const denied = requireAuth(request);
  if (denied) return denied;
  try {
    const form = await request.formData();
    const options = parseJobOptions({
      renderMode: form.get("renderMode"),
      limit: form.get("limit"),
      minDuration: form.get("minDuration"),
      maxDuration: form.get("maxDuration"),
    });
    const youtubeUrl = String(form.get("youtubeUrl") || "").trim();
    const upload = form.get("video");
    const hasUpload = upload instanceof File && upload.size > 0;
    if ((hasUpload && youtubeUrl) || (!hasUpload && !youtubeUrl)) {
      throw new Error("Pilih tepat satu sumber: upload video atau URL YouTube");
    }
    if (youtubeUrl && !validateYouTubeUrl(youtubeUrl)) {
      throw new Error("URL harus berasal dari youtube.com atau youtu.be");
    }

    const id = crypto.randomUUID();
    const jobRoot = path.join(jobsRoot(), id);
    const inputRoot = path.join(jobRoot, "input");
    await mkdir(inputRoot, { recursive: true });
    let source;
    let sourcePath = null;
    if (hasUpload) {
      const maximum = Number(process.env.MAX_UPLOAD_BYTES || 524288000);
      if (upload.size > maximum) throw new Error("Ukuran upload melewati batas server");
      const extension = path.extname(upload.name).toLowerCase();
      if (![".mp4", ".mov", ".mkv", ".webm", ".m4v"].includes(extension)) {
        throw new Error("Format video tidak didukung");
      }
      sourcePath = path.join(inputRoot, `source${extension}`);
      await writeFile(sourcePath, Buffer.from(await upload.arrayBuffer()));
      source = { type: "upload", name: upload.name, size: upload.size };
    } else {
      source = { type: "youtube", url: youtubeUrl };
    }

    const now = new Date().toISOString();
    const job = {
      id,
      status: "queued",
      progress: 0,
      createdAt: now,
      updatedAt: now,
      source,
      sourcePath,
      options,
      clips: [],
    };
    await atomicWriteJson(path.join(jobRoot, "job.json"), job);

    const logPath = path.join(jobRoot, "worker.log");
    const logFd = openSync(logPath, "a");
    const runner = path.join(process.cwd(), "scripts", "run-job.mjs");
    const child = spawn(process.execPath, [runner, id], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, JOBS_ROOT: jobsRoot() },
    });
    child.unref();
    closeSync(logFd);

    return Response.json({ job: publicJob(job) }, { status: 202 });
  } catch (error) {
    return Response.json({ error: error.message || "Gagal membuat pekerjaan" }, { status: 400 });
  }
}
