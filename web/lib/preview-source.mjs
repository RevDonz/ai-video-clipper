import { constants, close, createReadStream, fstat, open, read } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify, TextDecoder } from "node:util";

import { parseByteRange } from "./jobs.mjs";

const openFd = promisify(open);
const closeFd = promisify(close);
const statFd = promisify(fstat);
const readFd = promisify(read);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_JOB_BYTES = 1024 * 1024;
const TYPES = new Map([
  [".mp4", "video/mp4"],
  [".m4v", "video/x-m4v"],
  [".mov", "video/quicktime"],
  [".webm", "video/webm"],
  [".mkv", "video/x-matroska"],
]);

export class PreviewNotFoundError extends Error {}
export class PreviewInvalidError extends Error {}

export function isPreviewJobId(value) {
  return typeof value === "string" && UUID.test(value);
}

function containedBy(parent, target) {
  const relative = path.relative(parent, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function closeQuietly(fd) {
  if (Number.isInteger(fd)) await closeFd(fd).catch(() => {});
}

async function readExactlyBounded(fd, maximum) {
  const chunks = [];
  let total = 0;
  while (total <= maximum) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maximum + 1 - total));
    const { bytesRead } = await readFd(fd, buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total > maximum) throw new PreviewInvalidError();
  return Buffer.concat(chunks, total);
}

async function validateDirectory(target, expectedRealpath, ErrorType) {
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(target) !== expectedRealpath) throw new ErrorType();
  } catch (error) {
    if (error instanceof ErrorType) throw error;
    throw new ErrorType();
  }
}

function validMagic(extension, prefix) {
  if (extension === ".mp4" || extension === ".m4v" || extension === ".mov") {
    return prefix.length >= 8 && prefix.subarray(4, 8).equals(Buffer.from("ftyp"));
  }
  return prefix.length >= 4 && prefix.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
}

function strictJson(raw) {
  const document = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  let index = 0;
  const whitespace = () => { while (/\s/.test(document[index] || "")) index += 1; };
  const string = () => {
    const start = index;
    if (document[index++] !== '"') throw new SyntaxError("Expected string");
    while (index < document.length) {
      if (document[index] === '"') {
        index += 1;
        return JSON.parse(document.slice(start, index));
      }
      if (document[index] === "\\") index += 1;
      index += 1;
    }
    throw new SyntaxError("Unterminated string");
  };
  const value = () => {
    whitespace();
    if (document[index] === "{") {
      index += 1;
      whitespace();
      const keys = new Set();
      if (document[index] === "}") { index += 1; return; }
      while (true) {
        const key = string();
        if (keys.has(key)) throw new SyntaxError("Duplicate JSON key");
        keys.add(key);
        whitespace();
        if (document[index++] !== ":") throw new SyntaxError("Expected colon");
        value();
        whitespace();
        if (document[index] === "}") { index += 1; return; }
        if (document[index++] !== ",") throw new SyntaxError("Expected comma");
        whitespace();
      }
    }
    if (document[index] === "[") {
      index += 1;
      whitespace();
      if (document[index] === "]") { index += 1; return; }
      while (true) {
        value();
        whitespace();
        if (document[index] === "]") { index += 1; return; }
        if (document[index++] !== ",") throw new SyntaxError("Expected comma");
      }
    }
    if (document[index] === '"') { string(); return; }
    for (const literal of ["true", "false", "null"]) {
      if (document.startsWith(literal, index)) { index += literal.length; return; }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(document.slice(index))?.[0];
    if (!number || !Number.isFinite(Number(number))) throw new SyntaxError("Invalid JSON number");
    index += number.length;
  };
  value();
  whitespace();
  if (index !== document.length) throw new SyntaxError("Trailing JSON data");
  return JSON.parse(document);
}

export async function openPreviewSource(jobId, jobsRoot = process.env.JOBS_ROOT || "/data/jobs", options = {}) {
  if (!isPreviewJobId(jobId)) throw new PreviewInvalidError();
  const resolveFdPath = options.resolveFdPath || ((fd) => realpath(`/proc/self/fd/${fd}`));
  let canonicalRoot;
  try {
    canonicalRoot = await realpath(path.resolve(jobsRoot));
  } catch {
    throw new PreviewNotFoundError();
  }
  const jobRoot = path.join(canonicalRoot, jobId);
  await validateDirectory(jobRoot, jobRoot, PreviewNotFoundError);

  const jobPath = path.join(jobRoot, "job.json");
  let jobFd;
  try {
    jobFd = await openFd(jobPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await statFd(jobFd);
    if (!info.isFile() || info.size > MAX_JOB_BYTES || await resolveFdPath(jobFd) !== jobPath) throw new PreviewNotFoundError();
    const raw = await readExactlyBounded(jobFd, MAX_JOB_BYTES);
    const job = strictJson(raw);
    if (!job || typeof job !== "object" || Array.isArray(job) || job.id !== jobId || typeof job.sourcePath !== "string" || !job.sourcePath) {
      throw new PreviewInvalidError();
    }

    const inputRoot = path.join(jobRoot, "input");
    await validateDirectory(inputRoot, inputRoot, PreviewInvalidError);
    const target = path.resolve(jobRoot, job.sourcePath);
    if (!containedBy(inputRoot, target)) throw new PreviewInvalidError();
    const extension = path.extname(target).toLowerCase();
    const contentType = TYPES.get(extension);
    if (!contentType) throw new PreviewInvalidError();

    let sourceFd;
    try {
      sourceFd = await openFd(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      const sourceInfo = await statFd(sourceFd);
      const openedTarget = await resolveFdPath(sourceFd);
      if (!sourceInfo.isFile() || sourceInfo.size <= 0 || !containedBy(inputRoot, openedTarget)) throw new PreviewInvalidError();
      const prefix = Buffer.allocUnsafe(12);
      const { bytesRead } = await readFd(sourceFd, prefix, 0, prefix.length, 0);
      if (!validMagic(extension, prefix.subarray(0, bytesRead))) throw new PreviewInvalidError();
      return { fd: sourceFd, size: sourceInfo.size, extension, contentType };
    } catch (error) {
      await closeQuietly(sourceFd);
      if (error instanceof PreviewInvalidError) throw error;
      throw new PreviewInvalidError();
    }
  } catch (error) {
    if (error instanceof PreviewNotFoundError || error instanceof PreviewInvalidError) throw error;
    if (error?.code === "ENOENT" || error?.code === "ELOOP") throw new PreviewNotFoundError();
    throw new PreviewInvalidError();
  } finally {
    await closeQuietly(jobFd);
  }
}

export function descriptorReadableStream(fd, start, end, signal, options = {}) {
  const makeReadStream = options.createReadStream || createReadStream;
  const closeDescriptor = options.closeFd || closeFd;
  const nodeStream = makeReadStream("", { fd, autoClose: false, start, end });
  const iterator = nodeStream[Symbol.asyncIterator]();
  let cleanupPromise;
  let controller;
  let abortError;
  const cleanup = () => {
    if (!cleanupPromise) {
      signal?.removeEventListener("abort", abort);
      const closed = nodeStream.closed
        ? Promise.resolve()
        : new Promise((resolve) => nodeStream.once("close", resolve));
      nodeStream.destroy();
      cleanupPromise = closed.then(() => closeDescriptor(fd)).catch((error) => {
        if (error?.code !== "EBADF") throw error;
      });
    }
    return cleanupPromise;
  };
  const abort = () => {
    abortError = new DOMException("The operation was aborted.", "AbortError");
    void cleanup().then(() => controller?.error(abortError), (error) => controller?.error(error));
  };
  return new ReadableStream({
    start(streamController) {
      controller = streamController;
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    },
    async pull(streamController) {
      try {
        const result = await iterator.next();
        if (abortError) {
          await cleanup();
          streamController.error(abortError);
          return;
        }
        if (result.done) {
          await cleanup();
          streamController.close();
        } else {
          streamController.enqueue(new Uint8Array(result.value));
        }
      } catch (error) {
        await cleanup();
        streamController.error(error);
      }
    },
    cancel() {
      return cleanup();
    },
  });
}

export async function previewResponse(request, jobId, { head = false, jobsRoot, readerOptions, streamOptions, responseFactory } = {}) {
  const opened = await openPreviewSource(jobId, jobsRoot, readerOptions);
  let start = 0;
  let end = opened.size - 1;
  let status = 200;
  const headers = {
    "Accept-Ranges": "bytes",
    "Content-Type": opened.contentType,
    "Content-Disposition": `inline; filename="source${opened.extension}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
  const range = request.headers.get("range");
  if (range) {
    try {
      ({ start, end } = parseByteRange(range, opened.size));
    } catch {
      await closeQuietly(opened.fd);
      return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${opened.size}`, "Content-Length": "0" } });
    }
    status = 206;
    headers["Content-Range"] = `bytes ${start}-${end}/${opened.size}`;
  }
  headers["Content-Length"] = String(end - start + 1);
  if (head) {
    await closeQuietly(opened.fd);
    return new Response(null, { status, headers });
  }

  const stream = descriptorReadableStream(opened.fd, start, end, request.signal, streamOptions);
  try {
    return (responseFactory || ((body, init) => new Response(body, init)))(stream, { status, headers });
  } catch (error) {
    await stream.cancel().catch(() => {});
    throw error;
  }
}
