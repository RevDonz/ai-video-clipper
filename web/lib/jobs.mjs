import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const RENDER_MODES = ["face-track", "fit-blur", "center-crop"];

function finiteNumber(value, fallback, label) {
  const parsed = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be finite`);
  return parsed;
}

export function parseJobOptions(input = {}) {
  const renderMode = input.renderMode || "fit-blur";
  if (!RENDER_MODES.includes(renderMode)) throw new Error("Unsupported render mode");
  const limit = finiteNumber(input.limit, 5, "limit");
  const minDuration = finiteNumber(input.minDuration, 20, "minimum duration");
  const maxDuration = finiteNumber(input.maxDuration, 60, "maximum duration");
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new Error("limit must be an integer between 1 and 10");
  }
  if (minDuration < 5 || maxDuration > 180 || maxDuration < minDuration) {
    throw new Error("duration range must satisfy 5 <= min <= max <= 180");
  }
  return { renderMode, limit, minDuration, maxDuration };
}

export function validateYouTubeUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return host === "youtu.be" || host === "youtube.com" || host === "www.youtube.com";
  } catch {
    return false;
  }
}

export function safeJobFile(jobRoot, relativePath) {
  const root = path.resolve(jobRoot);
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error("Unsafe job file path");
  }
  return target;
}

export function parseByteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header || "");
  if (!match || size <= 0) throw new Error("Invalid byte range");
  let start;
  let end;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isInteger(suffix) || suffix <= 0) throw new Error("Invalid byte range");
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) {
    throw new Error("Invalid byte range");
  }
  return { start, end };
}

export async function atomicWriteJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const pending = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(pending, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(pending, target);
}
