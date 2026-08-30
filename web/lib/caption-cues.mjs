import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import { MAX_ARTIFACT_BYTES } from "./candidates.mjs";

export const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_JOB_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_CUES = 100_000;
const CANDIDATE_ID = /^cand_[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CUE_ID = /^cue_[0-9]{6}_[0-9a-f]{16}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class CaptionCuesJobNotFoundError extends Error {}
export class CaptionCuesCandidateNotFoundError extends Error {}
export class CaptionCuesInvalidError extends Error {}
export class CaptionCuesUnavailableError extends Error {
  constructor() { super("caption cue sanitizer unavailable"); }
}

function invalid() { throw new CaptionCuesInvalidError(); }

function exactObject(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const actual = Object.keys(value).sort();
  const fields = [...expected].sort();
  if (actual.length !== fields.length || actual.some((item, index) => item !== fields[index])) invalid();
}

function finite(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) invalid();
}

function safeText(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 100_000 || /[\p{Cc}\p{Cf}\p{Cs}\p{Co}]/u.test(value)) invalid();
}

export function isCaptionJobId(value) {
  return typeof value === "string" && UUID.test(value);
}

export function isCaptionCandidateId(value) {
  return typeof value === "string" && CANDIDATE_ID.test(value);
}

export function validateCaptionCues(value, expectedCandidateId) {
  exactObject(value, ["candidateId", "candidateArtifactSha256", "selectionVersion", "timingProvenance", "wordTiming", "cues"]);
  if (!isCaptionCandidateId(value.candidateId) || (expectedCandidateId && value.candidateId !== expectedCandidateId)) invalid();
  if (typeof value.candidateArtifactSha256 !== "string" || !SHA256.test(value.candidateArtifactSha256)) invalid();
  if (value.selectionVersion !== "selection-v2.0" || value.timingProvenance !== "segment-v1" || value.wordTiming !== false) invalid();
  if (!Array.isArray(value.cues) || value.cues.length > MAX_CUES) invalid();
  let previousEnd = 0;
  const ids = new Set();
  value.cues.forEach((cue, index) => {
    exactObject(cue, ["id", "start", "end", "text", "originalTextSha256"]);
    if (typeof cue.id !== "string" || !CUE_ID.test(cue.id) || ids.has(cue.id)) invalid();
    ids.add(cue.id);
    finite(cue.start);
    finite(cue.end);
    if (cue.end <= cue.start || (index && cue.start < previousEnd)) invalid();
    safeText(cue.text);
    if (typeof cue.originalTextSha256 !== "string" || !SHA256.test(cue.originalTextSha256)) invalid();
    previousEnd = cue.end;
  });
  return value;
}

function timeoutValue(value) {
  const parsed = Number(value ?? process.env.CAPTION_CUES_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
}

function envelope(artifact, transcript, candidateId) {
  const encodedId = Buffer.from(candidateId, "ascii");
  const header = Buffer.alloc(18);
  header.writeBigUInt64BE(BigInt(artifact.length), 0);
  header.writeBigUInt64BE(BigInt(transcript.length), 8);
  header.writeUInt16BE(encodedId.length, 16);
  return Buffer.concat([header, artifact, transcript, encodedId]);
}

export function runCaptionCueSanitizer(artifact, transcript, candidateId, options = {}) {
  if (!Buffer.isBuffer(artifact) || artifact.length > MAX_ARTIFACT_BYTES || !Buffer.isBuffer(transcript) || transcript.length > MAX_TRANSCRIPT_BYTES || !isCaptionCandidateId(candidateId)) {
    return Promise.reject(new CaptionCuesInvalidError());
  }
  const pythonBin = options.pythonBin || process.env.PYTHON_BIN || "python";
  return new Promise((resolve, reject) => {
    const child = execFile(
      /* turbopackIgnore: true */ pythonBin,
      ["-m", "ai_clipper.candidate_cues"],
      { encoding: "buffer", maxBuffer: MAX_OUTPUT_BYTES, timeout: timeoutValue(options.timeoutMs), killSignal: "SIGKILL", windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const message = Buffer.isBuffer(stderr) ? stderr.toString("ascii") : "";
          if (error.code === 3 && message === "candidate_cues_not_found\n") reject(new CaptionCuesCandidateNotFoundError());
          else if (error.code === 2 && message === "candidate_cues_invalid\n") reject(new CaptionCuesInvalidError());
          else reject(new CaptionCuesUnavailableError());
          return;
        }
        try {
          if (!Buffer.isBuffer(stdout) || stdout.length > MAX_OUTPUT_BYTES) invalid();
          const document = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
          resolve(validateCaptionCues(JSON.parse(document), candidateId));
        } catch {
          reject(new CaptionCuesUnavailableError());
        }
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(envelope(artifact, transcript, candidateId));
  });
}

function containedBy(parent, target) {
  const relative = path.relative(parent, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function exactDirectory(target, ErrorType) {
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(target) !== target) throw new ErrorType();
  } catch (error) {
    if (error instanceof ErrorType) throw error;
    throw new ErrorType();
  }
}

async function boundedFile(target, parent, maximum, resolveFdPath, ErrorType) {
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximum || !containedBy(parent, await resolveFdPath(handle.fd))) throw new ErrorType();
    const chunks = [];
    let total = 0;
    while (total <= maximum) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maximum + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maximum) throw new ErrorType();
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (error instanceof ErrorType) throw error;
    throw new ErrorType();
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function readCaptionCues(jobId, candidateId, jobsRoot = process.env.JOBS_ROOT || "/data/jobs", options = {}) {
  if (!isCaptionJobId(jobId) || !isCaptionCandidateId(candidateId)) invalid();
  const resolveFdPath = options.resolveFdPath || ((fd) => realpath(`/proc/self/fd/${fd}`));
  const sanitizerRunner = options.sanitizerRunner || runCaptionCueSanitizer;
  let root;
  try { root = await realpath(path.resolve(jobsRoot)); } catch { throw new CaptionCuesJobNotFoundError(); }
  const job = path.join(root, jobId);
  await exactDirectory(job, CaptionCuesJobNotFoundError);
  await boundedFile(path.join(job, "job.json"), job, MAX_JOB_BYTES, resolveFdPath, CaptionCuesJobNotFoundError);

  const analysis = path.join(job, "analysis");
  const output = path.join(job, "output");
  await exactDirectory(analysis, CaptionCuesInvalidError);
  await exactDirectory(output, CaptionCuesInvalidError);
  const artifact = await boundedFile(path.join(analysis, "candidates.v2.json"), analysis, MAX_ARTIFACT_BYTES, resolveFdPath, CaptionCuesInvalidError);
  const transcript = await boundedFile(path.join(output, "transcript.json"), output, MAX_TRANSCRIPT_BYTES, resolveFdPath, CaptionCuesInvalidError);
  try {
    return validateCaptionCues(await sanitizerRunner(artifact, transcript, candidateId), candidateId);
  } catch (error) {
    if (error instanceof CaptionCuesCandidateNotFoundError || error instanceof CaptionCuesInvalidError || error instanceof CaptionCuesUnavailableError) throw error;
    throw new CaptionCuesUnavailableError();
  }
}
