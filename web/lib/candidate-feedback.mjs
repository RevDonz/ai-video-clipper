import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

export const MAX_FEEDBACK_COMMAND_BYTES = 4096;
export const MAX_FEEDBACK_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANDIDATE_ID = /^cand_[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DECISIONS = new Set(["accepted", "rejected", "undecided"]);

export class FeedbackJobNotFoundError extends Error {
  constructor() { super("candidate feedback job not found"); }
}
export class FeedbackRequestInvalidError extends Error {
  constructor() { super("invalid candidate feedback request"); }
}
export class FeedbackConflictError extends Error {
  constructor() { super("candidate feedback idempotency conflict"); }
}
export class FeedbackArtifactInvalidError extends Error {
  constructor() { super("invalid candidate feedback artifact"); }
}
export class FeedbackBackendUnavailableError extends Error {
  constructor() { super("candidate feedback backend unavailable"); }
}
export class FeedbackSelectionChangedError extends Error {
  constructor() { super("candidate selection changed"); }
}
export class FeedbackTimeoutError extends FeedbackBackendUnavailableError {
  constructor() { super("candidate feedback validator timeout"); }
}

function exact(value, fields) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new FeedbackArtifactInvalidError();
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) {
    throw new FeedbackArtifactInvalidError();
  }
}

function validateEvent(value) {
  exact(value, ["eventId", "clientRequestId", "candidateId", "decision", "note", "createdAt"]);
  if (!UUID.test(value.eventId) || !UUID.test(value.clientRequestId) || !CANDIDATE_ID.test(value.candidateId)) {
    throw new FeedbackArtifactInvalidError();
  }
  if (!DECISIONS.has(value.decision) || typeof value.note !== "string" || Array.from(value.note).length > 500) {
    throw new FeedbackArtifactInvalidError();
  }
  if (value.note !== value.note.trim() || /\p{Cc}/u.test(value.note)) {
    throw new FeedbackArtifactInvalidError();
  }
  if (typeof value.createdAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.createdAt)) {
    throw new FeedbackArtifactInvalidError();
  }
  return value;
}

export function validateFeedbackState(value) {
  exact(value, ["available", "selectionVersion", "candidateArtifactSha256", "latestByCandidate", "eventCount"]);
  if (typeof value.available !== "boolean" || value.selectionVersion !== "selection-v2.0" || !SHA256.test(value.candidateArtifactSha256)) {
    throw new FeedbackArtifactInvalidError();
  }
  if (!Number.isInteger(value.eventCount) || value.eventCount < 0 || value.eventCount > 10_000) {
    throw new FeedbackArtifactInvalidError();
  }
  if (value.latestByCandidate === null || typeof value.latestByCandidate !== "object" || Array.isArray(value.latestByCandidate)) {
    throw new FeedbackArtifactInvalidError();
  }
  const entries = Object.entries(value.latestByCandidate);
  if (entries.length > Math.min(value.eventCount, 5000)) throw new FeedbackArtifactInvalidError();
  if (!value.available && (value.eventCount !== 0 || entries.length !== 0)) throw new FeedbackArtifactInvalidError();
  for (const [candidateId, event] of entries) {
    if (!CANDIDATE_ID.test(candidateId)) throw new FeedbackArtifactInvalidError();
    validateEvent(event);
    if (event.candidateId !== candidateId) throw new FeedbackArtifactInvalidError();
  }
  return value;
}

function validateOutput(value, operation) {
  if (operation === "get") return validateFeedbackState(value);
  exact(value, ["created", "event", "state"]);
  if (typeof value.created !== "boolean") throw new FeedbackArtifactInvalidError();
  validateEvent(value.event);
  validateFeedbackState(value.state);
  if (value.created && value.state.latestByCandidate[value.event.candidateId]?.eventId !== value.event.eventId) {
    throw new FeedbackArtifactInvalidError();
  }
  return value;
}

function timeout(value) {
  const parsed = Number(value ?? process.env.CANDIDATE_FEEDBACK_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_TIMEOUT_MS;
  return Math.min(parsed, MAX_TIMEOUT_MS);
}

export function runFeedbackPython(analysisDir, operation, rawBody, options = {}) {
  if (!["get", "put"].includes(operation) || !Buffer.isBuffer(rawBody) || rawBody.length > MAX_FEEDBACK_COMMAND_BYTES) {
    return Promise.reject(new FeedbackRequestInvalidError());
  }
  if (operation === "get" && rawBody.length !== 0) return Promise.reject(new FeedbackRequestInvalidError());
  const python = options.pythonBin || process.env.PYTHON_BIN || "python";
  const execFileImpl = options.execFileImpl || execFile;
  return new Promise((resolve, reject) => {
    const child = execFileImpl(
      /* turbopackIgnore: true */ python,
      ["-m", "ai_clipper.candidate_feedback", "--analysis-dir", analysisDir, "--operation", operation],
      {
        encoding: "buffer",
        maxBuffer: MAX_FEEDBACK_OUTPUT_BYTES,
        timeout: timeout(options.timeoutMs),
        killSignal: "SIGKILL",
        windowsHide: true,
        shell: false,
      },
      (error, stdout) => {
        if (error) {
          if (error.killed || error.signal === "SIGKILL" || error.code === "ETIMEDOUT") reject(new FeedbackTimeoutError());
          else if (error.code === 3) reject(new FeedbackRequestInvalidError());
          else if (error.code === 4) reject(new FeedbackJobNotFoundError());
          else if (error.code === 5) reject(new FeedbackConflictError());
          else if (error.code === 6) reject(new FeedbackArtifactInvalidError());
          else if (error.code === 8) reject(new FeedbackSelectionChangedError());
          else reject(new FeedbackBackendUnavailableError());
          return;
        }
        if (!Buffer.isBuffer(stdout) || stdout.length > MAX_FEEDBACK_OUTPUT_BYTES) {
          reject(new FeedbackArtifactInvalidError());
          return;
        }
        try {
          const document = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
          resolve(validateOutput(JSON.parse(document), operation));
        } catch {
          reject(new FeedbackArtifactInvalidError());
        }
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(rawBody);
  });
}

function isContained(parent, target) {
  const relative = path.relative(parent, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function canonicalRoot(root) {
  try {
    return await realpath(path.resolve(root));
  } catch (error) {
    if (error?.code === "ENOENT") throw new FeedbackJobNotFoundError();
    throw error;
  }
}

export function isFeedbackJobId(value) {
  return typeof value === "string" && UUID.test(value);
}

export async function readCandidateFeedback(
  jobId,
  operation,
  rawBody = Buffer.alloc(0),
  jobsRoot = process.env.JOBS_ROOT || "/data/jobs",
  options = {},
) {
  if (!isFeedbackJobId(jobId) || !["get", "put"].includes(operation) || !Buffer.isBuffer(rawBody)) {
    throw new FeedbackRequestInvalidError();
  }
  if (rawBody.length > MAX_FEEDBACK_COMMAND_BYTES || (operation === "get" && rawBody.length !== 0)) {
    throw new FeedbackRequestInvalidError();
  }
  const root = await canonicalRoot(jobsRoot);
  const job = path.join(root, jobId);
  try {
    const info = await lstat(job);
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(job) !== job) throw new FeedbackJobNotFoundError();
    const jobFile = await lstat(path.join(job, "job.json"));
    if (jobFile.isSymbolicLink() || !jobFile.isFile()) throw new FeedbackJobNotFoundError();
  } catch (error) {
    if (error instanceof FeedbackJobNotFoundError || error?.code === "ENOENT") throw new FeedbackJobNotFoundError();
    throw error;
  }
  const analysis = path.join(job, "analysis");
  try {
    const info = await lstat(analysis);
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(analysis) !== analysis) {
      throw new FeedbackArtifactInvalidError();
    }
    const candidate = path.join(analysis, "candidates.v2.json");
    const candidateInfo = await lstat(candidate);
    if (candidateInfo.isSymbolicLink() || !candidateInfo.isFile()) throw new FeedbackArtifactInvalidError();
    const candidateTarget = await realpath(candidate);
    if (!isContained(analysis, candidateTarget)) throw new FeedbackArtifactInvalidError();
  } catch (error) {
    if (error instanceof FeedbackArtifactInvalidError) throw error;
    if (error?.code === "ENOENT") throw new FeedbackJobNotFoundError();
    throw new FeedbackArtifactInvalidError();
  }
  const runner = options.runner || runFeedbackPython;
  return runner(analysis, operation, rawBody);
}
