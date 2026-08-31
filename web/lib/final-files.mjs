import { constants, close, fstat, open } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { parseByteRange } from "./jobs.mjs";
import { descriptorReadableStream } from "./preview-source.mjs";

const openFd = promisify(open);
const closeFd = promisify(close);
const statFd = promisify(fstat);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const MAX_SEGMENTS = 16;
const MAX_SEGMENT_LENGTH = 128;
const MAX_PATH_LENGTH = 1024;
const TYPES = new Map([
  [".mp4", "video/mp4"],
  [".srt", "application/x-subrip; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
]);

export class FinalFileNotFoundError extends Error {}
export class FinalFileInvalidError extends Error {}

export function isFinalJobId(value) {
  return typeof value === "string" && UUID.test(value);
}

export function isBoundedOutputPath(segments) {
  if (!Array.isArray(segments) || segments.length < 2 || segments.length > MAX_SEGMENTS) return false;
  if (segments[0] !== "output" || !segments.every((segment) => (
    typeof segment === "string"
    && segment.length > 0
    && segment.length <= MAX_SEGMENT_LENGTH
    && segment !== "."
    && segment !== ".."
    && SAFE_SEGMENT.test(segment)
  ))) return false;
  return segments.join("/").length <= MAX_PATH_LENGTH;
}

function containedBy(parent, target) {
  const relative = path.relative(parent, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function closeQuietly(fd, closer = closeFd) {
  if (Number.isInteger(fd)) await closer(fd).catch(() => {});
}

async function validateDirectory(target, ErrorType) {
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(target) !== target) throw new ErrorType();
  } catch (error) {
    if (error instanceof ErrorType) throw error;
    throw new ErrorType();
  }
}

export async function openFinalFile(jobId, segments, jobsRoot = process.env.JOBS_ROOT || "/data/jobs", options = {}) {
  if (!isFinalJobId(jobId) || !isBoundedOutputPath(segments)) throw new FinalFileInvalidError();
  const resolveFdPath = options.resolveFdPath || ((fd) => realpath(`/proc/self/fd/${fd}`));
  let canonicalRoot;
  try {
    canonicalRoot = await realpath(path.resolve(jobsRoot));
  } catch {
    throw new FinalFileNotFoundError();
  }

  const jobRoot = path.join(canonicalRoot, jobId);
  const outputRoot = path.join(jobRoot, "output");
  await validateDirectory(jobRoot, FinalFileNotFoundError);
  await validateDirectory(outputRoot, FinalFileNotFoundError);
  let current = outputRoot;
  for (const segment of segments.slice(1, -1)) {
    current = path.join(current, segment);
    await validateDirectory(current, FinalFileNotFoundError);
  }

  const target = path.join(canonicalRoot, jobId, ...segments);
  let fd;
  try {
    fd = await openFd(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await statFd(fd);
    const openedTarget = await resolveFdPath(fd);
    if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 0 || !containedBy(outputRoot, openedTarget)) {
      throw new FinalFileInvalidError();
    }
    const extension = path.extname(target).toLowerCase();
    return {
      fd,
      size: info.size,
      extension,
      contentType: TYPES.get(extension) || "application/octet-stream",
      filename: path.basename(target),
    };
  } catch (error) {
    await closeQuietly(fd);
    if (error instanceof FinalFileInvalidError) throw error;
    if (error?.code === "ENOENT" || error?.code === "ELOOP" || error?.code === "ENOTDIR") {
      throw new FinalFileNotFoundError();
    }
    throw new FinalFileInvalidError();
  }
}

export async function finalFileResponse(
  request,
  jobId,
  segments,
  { head = false, jobsRoot, readerOptions, streamOptions = {}, responseFactory } = {},
) {
  const opened = await openFinalFile(jobId, segments, jobsRoot, readerOptions);
  const closer = streamOptions.closeFd || closeFd;
  let start = 0;
  let end = opened.size - 1;
  let status = 200;
  const download = new URL(request.url).searchParams.get("download") === "1";
  const attachment = download || !TYPES.has(opened.extension);
  const headers = {
    "Accept-Ranges": "bytes",
    "Content-Type": opened.contentType,
    "Content-Disposition": `${attachment ? "attachment" : "inline"}; filename="${opened.filename}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
  const range = head ? null : request.headers.get("range");
  if (range) {
    try {
      const normalizedRange = range.replace(/^bytes=/i, "bytes=");
      ({ start, end } = parseByteRange(normalizedRange, opened.size));
    } catch {
      await closeQuietly(opened.fd, closer);
      return new Response(null, {
        status: 416,
        headers: { ...headers, "Content-Range": `bytes */${opened.size}`, "Content-Length": "0" },
      });
    }
    status = 206;
    headers["Content-Range"] = `bytes ${start}-${end}/${opened.size}`;
  }
  headers["Content-Length"] = String(Math.max(0, end - start + 1));
  if (head || opened.size === 0) {
    await closeQuietly(opened.fd, closer);
    return new Response(null, { status, headers });
  }

  let stream;
  try {
    stream = descriptorReadableStream(opened.fd, start, end, request.signal, streamOptions);
  } catch (error) {
    await closeQuietly(opened.fd, closer);
    throw error;
  }
  try {
    return (responseFactory || ((body, init) => new Response(body, init)))(stream, { status, headers });
  } catch (error) {
    await stream.cancel().catch(() => {});
    throw error;
  }
}
