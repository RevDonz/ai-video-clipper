// GET /api/jobs/:id/zip[?clips=1,3][&check=1]: the clips of a finished project in one store-only
// ZIP, each saved as "NN-judul.mp4" (A5). Only this job's own output/clip-NN.mp4 files, opened
// through the final-file helpers (no symlink, contained in output/); every file is opened and
// the size checked before the first byte is sent. `check=1` answers {count, bytes, filename}.
// The session, the id and the header set come from secureRoute (route.js).
import { close } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { clipSaveName, formatSize, zipSaveName } from "./clip-download.mjs";
import {
  FinalFileInvalidError,
  FinalFileNotFoundError,
  isBoundedOutputPath,
  openFinalFile,
} from "./final-files.mjs";
import { ZIP32_MAX_BYTES, ZipTooLargeError, storedZipLayout, storedZipStream } from "./zip-store.mjs";

export const DEFAULT_MAX_ZIP_BYTES = 2 * 1024 ** 3;
// Below the classic ZIP's 4 GiB, leaving room for the headers.
export const HARD_MAX_ZIP_BYTES = 0xffff0000;
const closeFd = promisify(close);
const MAX_SELECTION_CHARS = 1000;
const CLIP_NUMBER = /^[1-9]\d{0,3}$/;
const CLIP_FILE = /^clip-\d{1,4}\.mp4$/;

export class ZipConfigError extends Error {}

/** The ZIP size limit: MAX_ZIP_BYTES (a positive whole number of bytes, capped), else 2 GiB. */
export function maxZipBytes(env = process.env) {
  const raw = env.MAX_ZIP_BYTES;
  if (raw === undefined || raw === "") return DEFAULT_MAX_ZIP_BYTES;
  if (typeof raw !== "string" || !/^[1-9]\d{0,15}$/.test(raw)) throw new ZipConfigError("MAX_ZIP_BYTES");
  return Math.min(Number(raw), HARD_MAX_ZIP_BYTES);
}

/**
 * The picked clip numbers, in the project's order: `{indexes}`, or `{code: "invalid_clips"}`
 * (malformed, repeated) or `{code: "unknown_clip", index}`. `raw` null means every clip.
 */
export function parseClipSelection(raw, available) {
  const order = [...new Set(available)];
  if (raw === null || raw === undefined) return { indexes: order };
  if (typeof raw !== "string" || raw.length > MAX_SELECTION_CHARS) return { code: "invalid_clips" };
  const parts = raw.split(",");
  if (!parts.every((part) => CLIP_NUMBER.test(part))) return { code: "invalid_clips" };
  const picked = new Set(parts.map(Number));
  if (picked.size !== parts.length) return { code: "invalid_clips" };
  const known = new Set(order);
  for (const index of picked) if (!known.has(index)) return { code: "unknown_clip", index };
  return { indexes: order.filter((index) => picked.has(index)) };
}

/** The clip's own file in this job's output directory ("clip-03.mp4"), from its links; else null. */
export function clipOutputName(clip, jobId) {
  const prefix = `/api/jobs/${jobId}/files/output/`;
  for (const url of [clip?.videoUrl, clip?.downloadUrl]) {
    if (typeof url !== "string" || !url.startsWith(prefix)) continue;
    const encoded = url.slice(prefix.length).split(/[?#]/)[0];
    let name;
    try {
      name = decodeURIComponent(encoded);
    } catch {
      continue;
    }
    if (CLIP_FILE.test(name) && isBoundedOutputPath(["output", name])) return name;
  }
  return null;
}

const MESSAGES = Object.freeze({
  not_found: "Proyek ini tidak ada atau sudah dihapus.",
  not_ready: "Klip proyek ini belum siap diunduh.",
  no_clips: "Proyek ini tidak punya klip untuk diunduh.",
  invalid_clips: "Pilihan klip tidak valid.",
  zip_config_invalid: "Batas ukuran ZIP di server (MAX_ZIP_BYTES) tidak valid.",
  read_failed: "Klip tidak bisa dibaca sekarang. Coba lagi sebentar lagi.",
});

const clipNumber = (index) => String(index).padStart(2, "0");

function refusal(code, status, error = MESSAGES[code]) {
  return Response.json({ error, code }, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

async function readJob(jobsRoot, jobId) {
  try {
    return { job: JSON.parse(await readFile(path.join(path.resolve(jobsRoot), jobId, "job.json"), "utf8")) };
  } catch (error) {
    return { failure: error?.code === "ENOENT" ? refusal("not_found", 404) : refusal("read_failed", 503) };
  }
}

/** A name per entry; a repeated one (two clips with one number) gets "-2", "-3", ... */
function entryNames(clips) {
  const used = new Set();
  return clips.map((clip) => {
    const base = clipSaveName(clip) || `${clipNumber(clip.index)}-klip`;
    let name = `${base}.mp4`;
    for (let n = 2; used.has(name); n += 1) name = `${base}-${n}.mp4`;
    used.add(name);
    return name;
  });
}

async function closeAll(opened, closeFile) {
  await Promise.all(opened.map((item) => closeFile(item.fd).catch(() => {})));
}

/**
 * The route handler. `deps`: `jobsRoot`, `env`, `openFile` (openFinalFile) and `closeFile` for
 * tests; the defaults read JOBS_ROOT and MAX_ZIP_BYTES on each request.
 */
export async function clipsZipRoute(request, { params }, deps = {}) {
  const env = deps.env || process.env;
  const jobsRoot = deps.jobsRoot || env.JOBS_ROOT || "/data/jobs";
  const openFile = deps.openFile || openFinalFile;
  const closeFile = deps.closeFile || closeFd;
  const { id } = await params;

  let limit;
  try {
    limit = maxZipBytes(env);
  } catch {
    return refusal("zip_config_invalid", 500);
  }

  const { job, failure } = await readJob(jobsRoot, id);
  if (failure) return failure;
  if (job?.status !== "completed") return refusal("not_ready", 409);
  const clips = (Array.isArray(job.clips) ? job.clips : []).filter((clip) => Number.isSafeInteger(clip?.index) && clip.index > 0);
  if (!clips.length) return refusal("no_clips", 404);

  const query = new URL(request.url).searchParams;
  const selection = parseClipSelection(query.get("clips"), clips.map((clip) => clip.index));
  if (selection.code === "unknown_clip") return refusal("unknown_clip", 404, `Klip ${clipNumber(selection.index)} tidak ada di proyek ini.`);
  if (selection.code) return refusal(selection.code, 400);
  const wanted = new Set(selection.indexes);
  const picked = clips.filter((clip) => wanted.has(clip.index));
  const names = entryNames(picked);

  const opened = [];
  for (const [position, clip] of picked.entries()) {
    const missing = () => refusal("file_missing", 404, `File Klip ${clipNumber(clip.index)} tidak ditemukan di server.`);
    const file = clipOutputName(clip, id);
    if (!file) {
      await closeAll(opened, closeFile);
      return missing();
    }
    try {
      const handle = await openFile(id, ["output", file], jobsRoot);
      opened.push({ name: names[position], fd: handle.fd, size: handle.size, modified: handle.modified });
    } catch (error) {
      await closeAll(opened, closeFile);
      if (error instanceof FinalFileNotFoundError || error instanceof FinalFileInvalidError) return missing();
      return refusal("read_failed", 503);
    }
  }

  let layout = null;
  try {
    layout = storedZipLayout(opened);
  } catch (error) {
    if (!(error instanceof ZipTooLargeError)) {
      await closeAll(opened, closeFile);
      return refusal("read_failed", 503);
    }
  }
  const total = layout?.total ?? opened.reduce((sum, item) => sum + item.size, 0);
  if (!layout || total > limit || total > ZIP32_MAX_BYTES) {
    await closeAll(opened, closeFile);
    return refusal("zip_too_large", 413,
      `ZIP-nya ${formatSize(total)}, batasnya ${formatSize(limit)}. Pilih lebih sedikit klip, atau unduh satu per satu.`);
  }

  const filename = zipSaveName(job);
  if (query.get("check") === "1") {
    await closeAll(opened, closeFile);
    return Response.json({ count: opened.length, bytes: total, filename }, {
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  }
  const body = storedZipStream(opened, { signal: request.signal, closeImpl: closeFile });
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(total),
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
