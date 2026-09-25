// Preview media and editor resources (plan §4.2 "media" and "resources", §4.1, §9.1; T2.3).
//
// * Media: `GET /api/jobs/:id/clips/:clipId/media/:kind/:name` serves the preview lane's files
//   (plate cells, audio mixes, ASS, derived logos) and the clip's peaks. `kind` is fixed and
//   `name` must match that kind's content-hash pattern, so no user text ever becomes a path.
//   Every directory from the jobs root down is checked (real directory, no symlink, realpath
//   equal); the file is opened with O_NOFOLLOW and its /proc/self/fd target must lie inside the
//   expected directory. HTTP Range is supported. The names are content-addressed, so the
//   responses are `private, max-age=31536000, immutable`; ASS (user text inside) is plain text
//   in a CSP sandbox.
// * Resources: `GET /api/resources/:kind/:name` serves the pinned font files and the pack /
//   hook-design JSON: the same bytes libass reads on the server (R6). A font is served only
//   when it is listed in `resources/fonts/fonts.json` and its bytes hash to the listed sha256.
import { createHash } from "node:crypto";
import { constants, existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { parseByteRange } from "./jobs.mjs";

const CHUNK_BYTES = 256 * 1024;

export const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const CLIP_ID = /^clip_[0-9a-f]{24}$/;
export const IMMUTABLE = "private, max-age=31536000, immutable";

export const MEDIA_KINDS = Object.freeze({
  plates: Object.freeze({ dir: "preview/plates", pattern: /^[0-9a-f]{16}-c[0-9]{7}\.mp4$/, type: "video/mp4" }),
  audio: Object.freeze({ dir: "preview/audio", pattern: /^[0-9a-f]{16}\.flac$/, type: "audio/flac" }),
  ass: Object.freeze({ dir: "preview/ass", pattern: /^[0-9a-f]{16}\.ass$/, type: "text/plain; charset=utf-8", sandbox: true }),
  derived: Object.freeze({
    dir: "preview/derived",
    pattern: /^[0-9a-f]{16}@[1-9][0-9]{0,3}x[1-9][0-9]{0,3}a(?:[2-9][0-9]{2}|1000)\.png$/,
    type: "image/png",
  }),
  peaks: Object.freeze({ dir: "", pattern: /^peaks\.[0-9a-f]{16}\.bin$/, type: "application/octet-stream" }),
});
// Truth frames are not a media kind: the frame route streams them to the request that asked.
export const FRAME_FILE = Object.freeze({ dir: "preview/frames", pattern: /^[0-9a-f]{16}-[0-9]{1,9}-[0-9]{3,4}\.png$/, type: "image/png" });

export const RESOURCE_KINDS = Object.freeze(["fonts", "caption-packs", "hook-designs"]);
const FONT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(ttf|otf)$/;
const VERSIONED_NAME = /^([a-z0-9][a-z0-9-]{0,39})\.v([1-9][0-9]{0,3})\.json$/;
const FONT_TYPES = { ttf: "font/ttf", otf: "font/otf" };
const MAX_RESOURCE_BYTES = 16 * 1024 * 1024;
const MAX_JSON_RESOURCE_BYTES = 1024 * 1024;

class MediaNotFound extends Error {}

/** The spec of a media file (`{dir, pattern, type}`) when `name` is valid for `kind`, else null. */
export function mediaFile(kind, name) {
  if (typeof kind !== "string" || typeof name !== "string" || !Object.hasOwn(MEDIA_KINDS, kind)) return null;
  const spec = MEDIA_KINDS[kind];
  return spec.pattern.test(name) ? spec : null;
}

function contained(parent, target) {
  const relative = path.relative(parent, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function realDirectory(target) {
  let info;
  try { info = await lstat(target); } catch { throw new MediaNotFound(); }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new MediaNotFound();
  let real;
  try { real = await realpath(target); } catch { throw new MediaNotFound(); }
  if (real !== target) throw new MediaNotFound();
}

/**
 * Open `<jobsRoot>/<jobId>/analysis/clips/<clipId>/<spec.dir>/<name>` without following any
 * symlink: `{handle, size, file}` (a FileHandle, closed exactly once by whoever consumes it).
 * Throws MediaNotFound for anything else.
 */
export async function openClipFile(jobsRoot, jobId, clipId, spec, name, options = {}) {
  if (!JOB_ID.test(jobId || "") || !CLIP_ID.test(clipId || "") || !spec?.pattern.test(name || "")) throw new MediaNotFound();
  const resolveFdPath = options.resolveFdPath || ((fd) => realpath(`/proc/self/fd/${fd}`));
  let root;
  try { root = await realpath(path.resolve(jobsRoot)); } catch { throw new MediaNotFound(); }
  let directory = path.join(root, jobId);
  const parts = ["analysis", "clips", clipId, ...(spec.dir ? spec.dir.split("/") : [])];
  await realDirectory(directory);
  for (const part of parts) {
    directory = path.join(directory, part);
    await realDirectory(directory);
  }
  const file = path.join(directory, name);
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    const opened = await resolveFdPath(handle.fd);
    if (!info.isFile() || !Number.isSafeInteger(info.size) || !contained(directory, opened)) throw new MediaNotFound();
    return { handle, size: info.size, file };
  } catch {
    await handle?.close().catch(() => {});
    throw new MediaNotFound();
  }
}

/**
 * The bytes `[start, end]` of an open FileHandle as a web stream; the handle is closed exactly
 * once, at the end, on an error, on cancel or when `signal` aborts. (Node's fs ReadStream
 * closes a borrowed fd on destroy even with autoClose: false, so closing that fd again, as
 * preview-source's descriptorReadableStream does, can close a reused descriptor.)
 */
export function fileHandleStream(handle, start, end, signal) {
  let position = start;
  let closing = null;
  let stream = null;
  const release = () => {
    closing ??= handle.close().catch(() => {});
    return closing;
  };
  const onAbort = () => {
    void release();
    try {
      stream?.error(new DOMException("The operation was aborted.", "AbortError"));
    } catch { /* already closed or errored */ }
  };
  return new ReadableStream({
    start(controller) {
      stream = controller;
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    },
    async pull(controller) {
      try {
        if (closing) return;
        const length = Math.min(CHUNK_BYTES, end - position + 1);
        if (length <= 0) {
          signal?.removeEventListener("abort", onAbort);
          await release();
          controller.close();
          return;
        }
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        if (bytesRead === 0) throw new Error("file shorter than expected");
        position += bytesRead;
        controller.enqueue(new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead));
      } catch (error) {
        signal?.removeEventListener("abort", onAbort);
        await release();
        controller.error(error);
      }
    },
    cancel() {
      signal?.removeEventListener("abort", onAbort);
      return release();
    },
  });
}

function plain(status, message, extra = {}) {
  return new Response(message, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Type": "text/plain; charset=utf-8", ...extra },
  });
}

/** Stream an opened file with Range support and the given headers. */
export async function openedFileResponse(request, opened, { type, cacheControl, head = false, extraHeaders = {} }) {
  const headers = {
    "Accept-Ranges": "bytes",
    "Content-Type": type,
    "Cache-Control": cacheControl,
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    ...extraHeaders,
  };
  let start = 0;
  let end = opened.size - 1;
  let status = 200;
  const range = head ? null : request.headers.get("range");
  if (range && opened.size > 0) {
    try {
      ({ start, end } = parseByteRange(range.replace(/^bytes=/i, "bytes="), opened.size));
    } catch {
      await opened.handle.close().catch(() => {});
      return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${opened.size}`, "Content-Length": "0" } });
    }
    status = 206;
    headers["Content-Range"] = `bytes ${start}-${end}/${opened.size}`;
  }
  headers["Content-Length"] = String(Math.max(0, end - start + 1));
  if (head || opened.size === 0) {
    await opened.handle.close().catch(() => {});
    return new Response(null, { status, headers });
  }
  return new Response(fileHandleStream(opened.handle, start, end, request.signal), { status, headers });
}

/** The media response of `kind/name` for a clip (404 for anything that is not served). */
export async function clipMediaResponse(request, { jobsRoot = process.env.JOBS_ROOT, jobId, clipId, kind, name, head = false, onServed } = {}) {
  const spec = mediaFile(kind, name);
  if (!spec || !jobsRoot) return plain(404, "Not found");
  let opened;
  try {
    opened = await openClipFile(jobsRoot, jobId, clipId, spec, name);
  } catch {
    return plain(404, "Not found");
  }
  try { onServed?.(opened.file); } catch { /* access bookkeeping never fails a response */ }
  return openedFileResponse(request, opened, {
    type: spec.type,
    cacheControl: IMMUTABLE,
    head,
    extraHeaders: spec.sandbox ? { "Content-Security-Policy": "sandbox" } : {},
  });
}

// --- resources ---------------------------------------------------------------------------------

/** The resources directory: POTONGIN_RESOURCES_DIR, else `<cwd>/resources` (the image's /app),
 * else `<cwd>/../resources` (development: the web app runs from web/). */
export function resourcesDir(env = process.env, cwd = process.cwd()) {
  const configured = env.POTONGIN_RESOURCES_DIR;
  if (typeof configured === "string" && path.isAbsolute(configured)) return configured;
  const local = path.join(cwd, "resources");
  if (existsSync(path.join(local, "fonts", "fonts.json"))) return local;
  return path.resolve(cwd, "..", "resources");
}

/** `{file, type, sha256?}` of a resource, or null when `kind/name` is not a served resource. */
export function resourceFile(kind, name, dir = resourcesDir()) {
  if (typeof kind !== "string" || typeof name !== "string" || !RESOURCE_KINDS.includes(kind)) return null;
  if (kind === "fonts") {
    const match = FONT_NAME.exec(name);
    if (!match) return null;
    let manifest;
    try {
      manifest = JSON.parse(readFileSyncBounded(path.join(dir, "fonts", "fonts.json")));
    } catch {
      return null;
    }
    const entry = Array.isArray(manifest?.fonts) ? manifest.fonts.find((font) => font?.file === name) : undefined;
    if (!entry || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) return null;
    return { file: path.join(dir, "fonts", name), root: path.join(dir, "fonts"), type: FONT_TYPES[match[1]], sha256: entry.sha256 };
  }
  const match = VERSIONED_NAME.exec(name);
  if (!match) return null;
  const file = path.join(dir, kind, match[1], `v${match[2]}.json`);
  try {
    if (!lstatSync(file).isFile()) return null;
  } catch {
    return null;
  }
  return { file, root: path.join(dir, kind), type: "application/json; charset=utf-8" };
}

function readFileSyncBounded(file, limit = MAX_JSON_RESOURCE_BYTES) {
  const info = statSync(file);
  if (!info.isFile() || info.size > limit) throw new Error("resource too large");
  return readFileSync(file, "utf8");
}

const verifiedFonts = new Map(); // file → "size:mtime:sha" of bytes already hashed

/** The resource response (404 unless it is a pinned font or a pack / hook-design file). */
export async function resourceResponse(request, { kind, name, dir = resourcesDir(), head = false } = {}) {
  const target = resourceFile(kind, name, dir);
  if (!target) return plain(404, "Not found");
  let bytes;
  try {
    const [realFile, realRoot] = await Promise.all([
      realpath(/* turbopackIgnore: true */ target.file), realpath(/* turbopackIgnore: true */ target.root)]);
    if (!contained(realRoot, realFile)) return plain(404, "Not found");
    const info = await lstat(/* turbopackIgnore: true */ target.file);
    const limit = kind === "fonts" ? MAX_RESOURCE_BYTES : MAX_JSON_RESOURCE_BYTES;
    if (info.isSymbolicLink() || !info.isFile() || info.size > limit) return plain(404, "Not found");
    bytes = await readFile(/* turbopackIgnore: true */ target.file);
    if (target.sha256) {
      const stamp = `${info.size}:${info.mtimeMs}:${target.sha256}`;
      if (verifiedFonts.get(target.file) !== stamp) {
        if (createHash("sha256").update(bytes).digest("hex") !== target.sha256) return plain(404, "Not found");
        verifiedFonts.set(target.file, stamp);
      }
    }
  } catch {
    return plain(404, "Not found");
  }
  const headers = {
    "Content-Type": target.type,
    "Cache-Control": IMMUTABLE,
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Length": String(bytes.length),
  };
  return new Response(head ? null : bytes, { status: 200, headers });
}
