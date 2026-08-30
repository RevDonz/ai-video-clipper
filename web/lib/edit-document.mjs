import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

export const MAX_EDIT_BODY_BYTES = 2 * 1024 * 1024;
const MAX_COMMAND_BYTES = 3 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANDIDATE_ID = /^cand_[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export class EditRequestInvalidError extends Error {}
export class EditJobNotFoundError extends Error {}
export class EditSemanticInvalidError extends Error {}
export class EditSelectionChangedError extends Error {}
export class EditIdempotencyConflictError extends Error {}
export class EditBackendUnavailableError extends Error {}
export class EditTimeoutError extends EditBackendUnavailableError {}
export class EditConflictError extends Error {
  constructor(current) { super("edit revision conflict"); this.current = current; }
}

export function isEditJobId(value) { return typeof value === "string" && UUID.test(value); }
export function isEditCandidateId(value) { return typeof value === "string" && CANDIDATE_ID.test(value); }
export function isEditIdempotencyKey(value) { return typeof value === "string" && UUID.test(value); }

function exact(value, fields) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new EditSemanticInvalidError();
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) {
    throw new EditSemanticInvalidError();
  }
}

function validateResult(value) {
  exact(value, ["created", "etag", "manifest"]);
  if (typeof value.created !== "boolean" || typeof value.etag !== "string" || !SHA256.test(value.etag)) {
    throw new EditSemanticInvalidError();
  }
  if (value.manifest === null || typeof value.manifest !== "object" || Array.isArray(value.manifest)) {
    throw new EditSemanticInvalidError();
  }
  exact(value.manifest, [
    "edit_manifest_version", "identity", "revision", "parent_revision_sha256", "timeline",
    "visual", "caption_style", "captions", "overlays", "audio", "audit",
  ]);
  if (value.manifest.edit_manifest_version !== "clip-edit-v1.0"
      || !Number.isInteger(value.manifest.revision) || value.manifest.revision < 1
      || value.manifest.identity === null || typeof value.manifest.identity !== "object"
      || !CANDIDATE_ID.test(value.manifest.identity.candidate_id)) {
    throw new EditSemanticInvalidError();
  }
  return value;
}

function decodeOutput(stdout) {
  if (!Buffer.isBuffer(stdout) || stdout.length > MAX_OUTPUT_BYTES) throw new EditSemanticInvalidError();
  try {
    return validateResult(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stdout)));
  } catch (error) {
    if (error instanceof EditSemanticInvalidError) throw error;
    throw new EditSemanticInvalidError();
  }
}

function timeout(value) {
  const parsed = Number(value ?? process.env.EDIT_DOCUMENT_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_TIMEOUT_MS;
  return Math.min(parsed, MAX_TIMEOUT_MS);
}

export function runEditorPython(analysisDir, command, options = {}) {
  let raw;
  try { raw = Buffer.from(JSON.stringify(command)); } catch { return Promise.reject(new EditRequestInvalidError()); }
  if (raw.length === 0 || raw.length > MAX_COMMAND_BYTES) return Promise.reject(new EditRequestInvalidError());
  const python = options.pythonBin || process.env.PYTHON_BIN || "python";
  const execFileImpl = options.execFileImpl || execFile;
  return new Promise((resolve, reject) => {
    const child = execFileImpl(
      /* turbopackIgnore: true */ python,
      ["-m", "ai_clipper.editor_api", "--analysis-dir", analysisDir],
      {
        encoding: "buffer", maxBuffer: MAX_OUTPUT_BYTES, timeout: timeout(options.timeoutMs),
        killSignal: "SIGKILL", windowsHide: true, shell: false,
      },
      (error, stdout) => {
        if (error) {
          if (error.killed || error.signal === "SIGKILL" || error.code === "ETIMEDOUT") reject(new EditTimeoutError());
          else if (error.code === 3) reject(new EditRequestInvalidError());
          else if (error.code === 4) reject(new EditJobNotFoundError());
          else if (error.code === 5) {
            try { reject(new EditConflictError(decodeOutput(stdout))); }
            catch { reject(new EditBackendUnavailableError()); }
          } else if (error.code === 6) reject(new EditSemanticInvalidError());
          else if (error.code === 8) reject(new EditSelectionChangedError());
          else if (error.code === 9) reject(new EditIdempotencyConflictError());
          else reject(new EditBackendUnavailableError());
          return;
        }
        try { resolve(decodeOutput(stdout)); }
        catch (decodeError) { reject(decodeError); }
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(raw);
  });
}

function isContained(parent, target) {
  const relative = path.relative(parent, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function readEditDocument(jobId, candidateId, command,
  jobsRoot = process.env.JOBS_ROOT || "/data/jobs", options = {}) {
  if (!isEditJobId(jobId) || !isEditCandidateId(candidateId)) throw new EditRequestInvalidError();
  let root;
  try { root = await realpath(path.resolve(jobsRoot)); }
  catch (error) {
    if (error?.code === "ENOENT") throw new EditJobNotFoundError();
    throw new EditBackendUnavailableError();
  }
  const job = path.join(root, jobId);
  const analysis = path.join(job, "analysis");
  try {
    const jobInfo = await lstat(job);
    const jobFile = await lstat(path.join(job, "job.json"));
    if (jobInfo.isSymbolicLink() || !jobInfo.isDirectory() || await realpath(job) !== job
        || jobFile.isSymbolicLink() || !jobFile.isFile()) throw new EditJobNotFoundError();
    const analysisInfo = await lstat(analysis);
    if (analysisInfo.isSymbolicLink() || !analysisInfo.isDirectory() || await realpath(analysis) !== analysis) {
      throw new EditSemanticInvalidError();
    }
    const artifact = path.join(analysis, "candidates.v2.json");
    const artifactInfo = await lstat(artifact);
    const artifactTarget = await realpath(artifact);
    if (artifactInfo.isSymbolicLink() || !artifactInfo.isFile() || !isContained(analysis, artifactTarget)) {
      throw new EditSemanticInvalidError();
    }
  } catch (error) {
    if (error instanceof EditJobNotFoundError || error instanceof EditSemanticInvalidError) throw error;
    if (error?.code === "ENOENT") throw new EditJobNotFoundError();
    throw new EditSemanticInvalidError();
  }
  const runner = options.runner || runEditorPython;
  const result = await runner(analysis, command);
  if (result.manifest.identity.candidate_id !== candidateId) throw new EditSemanticInvalidError();
  return result;
}
