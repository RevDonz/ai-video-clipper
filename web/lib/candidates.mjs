import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_CANDIDATES = 5000;
const DEFAULT_VALIDATOR_TIMEOUT_MS = 5000;
const MAX_VALIDATOR_TIMEOUT_MS = 30_000;
const SELECTION_VERSION = "selection-v2.0";
const SAFE_PROVENANCE = new Set([SELECTION_VERSION, "media-features-v1"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FEATURE_FIELDS = [
  "hookStrength", "hookRelevance", "standaloneContext", "payoffCompleteness",
  "informationDensity", "emotionEnergy", "dialogueDynamics", "visualActivity",
  "topicValue", "boundaryQuality", "penalty",
];
const PRESENTATION_FIELDS = ["available", "selectionVersion", "provenance", "candidates"];
const CANDIDATE_FIELDS = [
  "id", "start", "end", "duration", "text", "profile", "score", "reasons",
  "topicTerms", "rank", "displayOrder", "features", "scoreBreakdown", "measuredMedia",
];
const BREAKDOWN_FIELDS = [
  "contributions", "activeWeightTotal", "weightedPrePenaltyScore", "penaltyDeduction",
  "diversityDeduction", "finalScore",
];
const CONTRIBUTION_FIELDS = ["name", "value", "weight", "weightedValue", "source"];
const TEXT_CONTRIBUTIONS = new Set([
  "hook_strength", "hook_relevance", "standalone_context", "payoff_completeness",
  "information_density", "topic_value", "boundary_quality",
]);
const MEDIA_CONTRIBUTIONS = new Set([
  "audio_energy", "audio_energy_change", "scene_activity", "motion", "face_activity",
]);
const MEDIA_FIELDS = ["intervalStart", "intervalEnd", "measurements"];
const MEASUREMENT_FIELDS = ["audioEnergy", "energyChange", "sceneActivity", "motion", "faceActivity"];

export class CandidatesJobNotFoundError extends Error {
  constructor() { super("candidate job not found"); }
}
export class CandidatesArtifactInvalidError extends Error {
  constructor() { super("invalid candidates artifact"); }
}

function invalid() {
  throw new CandidatesArtifactInvalidError();
}

function exactObject(value, fields) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) invalid();
}

function finite(value, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER, nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) invalid();
}

function text(value, maximum = 100_000) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) invalid();
}

function stringArray(value, maximumItems, maximumLength) {
  if (!Array.isArray(value) || value.length > maximumItems) invalid();
  value.forEach((item) => text(item, maximumLength));
}

function validateBreakdown(value) {
  exactObject(value, BREAKDOWN_FIELDS);
  if (!Array.isArray(value.contributions) || value.contributions.length > 12) invalid();
  const contributionNames = new Set();
  for (const contribution of value.contributions) {
    exactObject(contribution, CONTRIBUTION_FIELDS);
    text(contribution.name, 64);
    if (!["text", "media"].includes(contribution.source)) invalid();
    const allowed = contribution.source === "text" ? TEXT_CONTRIBUTIONS : MEDIA_CONTRIBUTIONS;
    if (!allowed.has(contribution.name) || contributionNames.has(contribution.name)) invalid();
    contributionNames.add(contribution.name);
    finite(contribution.value, { maximum: 10 });
    finite(contribution.weight, { minimum: Number.MIN_VALUE, maximum: 1000 });
    finite(contribution.weightedValue, { maximum: 10_000 });
  }
  for (const name of BREAKDOWN_FIELDS.slice(1, -1)) finite(value[name], { maximum: 10_000 });
  finite(value.finalScore, { maximum: 10 });
}

function validateMedia(value) {
  if (value === null) return;
  exactObject(value, MEDIA_FIELDS);
  finite(value.intervalStart);
  finite(value.intervalEnd);
  if (value.intervalEnd <= value.intervalStart) invalid();
  exactObject(value.measurements, MEASUREMENT_FIELDS);
  for (const name of MEASUREMENT_FIELDS) finite(value.measurements[name], { maximum: 10, nullable: true });
}

export function validatePresentation(value) {
  exactObject(value, PRESENTATION_FIELDS);
  if (value.available !== true || value.selectionVersion !== SELECTION_VERSION) invalid();
  if (!Array.isArray(value.provenance) || value.provenance.length < 1 || value.provenance.length > SAFE_PROVENANCE.size) invalid();
  if (value.provenance[0] !== SELECTION_VERSION || new Set(value.provenance).size !== value.provenance.length) invalid();
  if (value.provenance.some((item) => !SAFE_PROVENANCE.has(item))) invalid();
  if (!Array.isArray(value.candidates) || value.candidates.length > MAX_CANDIDATES) invalid();

  const ranks = new Set();
  value.candidates.forEach((candidate, index) => {
    exactObject(candidate, CANDIDATE_FIELDS);
    text(candidate.id, 256);
    finite(candidate.start);
    finite(candidate.end);
    finite(candidate.duration);
    if (candidate.end <= candidate.start || candidate.duration !== candidate.end - candidate.start) invalid();
    text(candidate.text);
    if (!["viral-short", "standard", "deep-dive"].includes(candidate.profile)) invalid();
    finite(candidate.score, { maximum: 10 });
    stringArray(candidate.reasons, 100, 2000);
    stringArray(candidate.topicTerms, 100, 200);
    if (!Number.isInteger(candidate.rank) || candidate.rank < 1 || candidate.rank > value.candidates.length) invalid();
    if (ranks.has(candidate.rank)) invalid();
    ranks.add(candidate.rank);
    if (candidate.displayOrder !== index + 1) invalid();
    exactObject(candidate.features, FEATURE_FIELDS);
    FEATURE_FIELDS.forEach((name) => finite(candidate.features[name], { maximum: 10 }));
    validateBreakdown(candidate.scoreBreakdown);
    validateMedia(candidate.measuredMedia);
  });
  return value;
}

function configuredTimeout(value) {
  const parsed = Number(value ?? process.env.CANDIDATE_VALIDATOR_TIMEOUT_MS ?? DEFAULT_VALIDATOR_TIMEOUT_MS);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_VALIDATOR_TIMEOUT_MS;
  return Math.min(parsed, MAX_VALIDATOR_TIMEOUT_MS);
}

export function runCandidateValidator(artifactBytes, options = {}) {
  if (!Buffer.isBuffer(artifactBytes) || artifactBytes.length > MAX_ARTIFACT_BYTES) {
    return Promise.reject(new CandidatesArtifactInvalidError());
  }
  const pythonBin = options.pythonBin || process.env.PYTHON_BIN || "python";
  const timeout = configuredTimeout(options.timeoutMs);
  return new Promise((resolve, reject) => {
    const child = execFile(
      /* turbopackIgnore: true */ pythonBin,
      ["-m", "ai_clipper.candidate_api"],
      {
        encoding: "buffer",
        maxBuffer: MAX_ARTIFACT_BYTES,
        timeout,
        killSignal: "SIGKILL",
        windowsHide: true,
      },
      (error, stdout) => {
        if (error || !Buffer.isBuffer(stdout) || stdout.length > MAX_ARTIFACT_BYTES) {
          reject(new CandidatesArtifactInvalidError());
          return;
        }
        try {
          const document = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
          resolve(validatePresentation(JSON.parse(document)));
        } catch {
          reject(new CandidatesArtifactInvalidError());
        }
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(artifactBytes);
  });
}

export async function readBoundedArtifact(handle) {
  const chunks = [];
  let total = 0;
  while (total <= MAX_ARTIFACT_BYTES) {
    const remaining = MAX_ARTIFACT_BYTES + 1 - total;
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length) invalid();
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total > MAX_ARTIFACT_BYTES) invalid();
  return Buffer.concat(chunks, total);
}

function containedBy(parent, target) {
  const relative = path.relative(parent, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function regularNoSymlink(target, missingError) {
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") throw missingError;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) throw missingError;
}

export function isCandidateJobId(value) {
  return typeof value === "string" && UUID.test(value);
}

export async function readCandidatesPresentation(jobId, jobsRoot = process.env.JOBS_ROOT || "/data/jobs", options = {}) {
  if (!isCandidateJobId(jobId)) invalid();
  const validatorRunner = options.validatorRunner || runCandidateValidator;
  const resolveFdPath = options.resolveFdPath || ((fd) => realpath(`/proc/self/fd/${fd}`));
  const root = path.resolve(jobsRoot);
  let canonicalRoot;
  try {
    canonicalRoot = await realpath(root);
  } catch (error) {
    if (error?.code === "ENOENT") throw new CandidatesJobNotFoundError();
    throw error;
  }

  const jobRoot = path.join(canonicalRoot, jobId);
  const missingJob = new CandidatesJobNotFoundError();
  try {
    const jobInfo = await lstat(jobRoot);
    if (jobInfo.isSymbolicLink() || !jobInfo.isDirectory()) throw missingJob;
    if (await realpath(jobRoot) !== jobRoot) throw missingJob;
    await regularNoSymlink(path.join(jobRoot, "job.json"), missingJob);
  } catch (error) {
    if (error?.code === "ENOENT") throw missingJob;
    throw error;
  }

  const analysisRoot = path.join(jobRoot, "analysis");
  try {
    const analysisInfo = await lstat(analysisRoot);
    if (analysisInfo.isSymbolicLink() || !analysisInfo.isDirectory()) invalid();
    if (await realpath(analysisRoot) !== analysisRoot) invalid();
  } catch (error) {
    if (error?.code === "ENOENT") return { available: false, candidates: [] };
    if (error instanceof CandidatesArtifactInvalidError) throw error;
    invalid();
  }

  let handle;
  try {
    handle = await open(path.join(analysisRoot, "candidates.v2.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === "ENOENT") return { available: false, candidates: [] };
    invalid();
  }

  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_ARTIFACT_BYTES) invalid();
    const openedTarget = await resolveFdPath(handle.fd);
    if (!containedBy(analysisRoot, openedTarget)) invalid();
    const artifactBytes = await readBoundedArtifact(handle);
    try {
      return validatePresentation(await validatorRunner(artifactBytes));
    } catch {
      invalid();
    }
  } catch (error) {
    if (error instanceof CandidatesArtifactInvalidError) throw error;
    invalid();
  } finally {
    await handle.close().catch(() => {});
  }
}
