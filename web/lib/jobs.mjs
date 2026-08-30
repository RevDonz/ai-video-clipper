import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const RENDER_MODES = ["face-track", "fit-blur", "center-crop"];
export const SELECTION_MODES = ["v1", "v2-shadow"];
export const CLIP_PROFILES = ["viral-short", "standard", "deep-dive"];
export const DEFAULT_SHADOW_OPTIONS = Object.freeze({
  clipProfile: "standard",
  maxCandidates: 200,
  maxMediaCandidates: 12,
  mediaTimeout: 30,
});
const WORKER_PROGRESS_PREFIX = "POTONGIN_PROGRESS ";

export function parseWorkerProgress(line) {
  if (typeof line !== "string" || !line.startsWith(WORKER_PROGRESS_PREFIX)) return null;
  try {
    const event = JSON.parse(line.slice(WORKER_PROGRESS_PREFIX.length));
    if (!Number.isInteger(event.progress) || event.progress < 0 || event.progress > 99) return null;
    if (typeof event.stage !== "string" || typeof event.detail !== "string") return null;
    return { progress: event.progress, stage: event.stage, detail: event.detail };
  } catch {
    return null;
  }
}

const INDONESIAN_STOPWORDS = new Set([
  "agar", "akan", "aku", "anda", "atau", "bagi", "bahwa", "banyak", "bisa", "buat",
  "dalam", "dan", "dari", "dengan", "dia", "ini", "itu", "jadi", "jika", "juga",
  "kalau", "kami", "karena", "kita", "lebih", "maka", "mereka", "namun", "orang",
  "pada", "paling", "saja", "sangat", "saya", "sebagai", "seperti", "setiap", "sudah",
  "supaya", "tapi", "telah", "tentang", "tersebut", "tidak", "untuk", "yang", "abis",
  "banget", "belakang", "belum", "boleh", "boom", "baru", "cuma", "dibuat", "dong", "hasil", "info", "langsung",
  "masih", "memang", "mungkin", "pertama", "sekarang", "sedikit", "sebelah", "selesai", "setelah", "setutu",
  "sini", "sana", "teman", "ternyata", "terlihat", "waktu", "wow",
]);

const HOOK_WORDS = [
  "alasan", "cara", "fakta", "harus", "jangan", "kesalahan", "kenapa", "rahasia",
  "ternyata", "tidak sadar", "masalah", "penting", "bisa", "wajib",
];

function cleanTranscript(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^[\s.,!?;:—-]+|[\s—-]+$/g, "")
    .trim();
}

function truncateAtWord(value, maximum) {
  if (value.length <= maximum) return value;
  const shortened = value.slice(0, maximum - 1);
  const boundary = shortened.lastIndexOf(" ");
  return `${shortened.slice(0, boundary > maximum * 0.6 ? boundary : maximum - 1).trim()}…`;
}

function topicHashtags(text) {
  const frequencies = new Map();
  const words = text.toLocaleLowerCase("id-ID").match(/[\p{L}\p{N}]+/gu) || [];
  for (const [index, word] of words.entries()) {
    if (word.length < 5 || INDONESIAN_STOPWORDS.has(word) || /^\d+$/.test(word)) continue;
    const current = frequencies.get(word) || { count: 0, firstIndex: index };
    frequencies.set(word, { count: current.count + 1, firstIndex: current.firstIndex });
  }
  return [...frequencies.entries()]
    .sort((left, right) => right[1].count - left[1].count || left[1].firstIndex - right[1].firstIndex)
    .slice(0, 4)
    .map(([word]) => `#${word[0].toLocaleUpperCase("id-ID")}${word.slice(1)}`);
}

function topicWords(text) {
  return topicHashtags(text).map((tag) => tag.slice(1));
}

export function generateSocialMetadata(transcript) {
  const text = cleanTranscript(transcript);
  const fallbackTitle = "Momen Pilihan dari Video Ini";
  const sentences = text
    ? text.split(/(?<=[.!?])\s+|\n+/).map(cleanTranscript).filter((item) => item.length >= 8)
    : [];
  const ranked = sentences.map((sentence, index) => {
    const lower = sentence.toLocaleLowerCase("id-ID");
    const hooks = HOOK_WORDS.reduce((score, word) => score + (lower.includes(word) ? 3 : 0), 0);
    const question = sentence.includes("?") ? 2 : 0;
    const idealLength = sentence.length >= 24 && sentence.length <= 90 ? 2 : 0;
    return { sentence, score: hooks + question + idealLength - index * 0.15 };
  }).sort((left, right) => right.score - left.score);
  const strongest = ranked[0];
  const topics = topicWords(text);
  const useSentence = strongest && strongest.score >= 3 && strongest.sentence.length <= 110;
  const topicTitle = topics.length
    ? `Hal Menarik tentang ${topics[0]} yang Bikin Penasaran`
    : fallbackTitle;
  const selected = useSentence ? strongest.sentence : topicTitle;
  const plainTitle = selected.replace(/[.!?,;:]+$/g, "").trim();
  const title = truncateAtWord(
    plainTitle ? `${plainTitle[0].toLocaleUpperCase("id-ID")}${plainTitle.slice(1)}` : fallbackTitle,
    72,
  );
  const excerpt = truncateAtWord(text || "Ada insight menarik yang layak kamu simak dari video ini", 210);
  const hashtags = ["#fyp", "#viral", "#shorts", ...topicHashtags(text)];
  const description = `${excerpt}${/[.!?]$/.test(excerpt) ? "" : "."}\n\nSimak sampai akhir—bagian mana yang paling relate buat kamu?\n\n${hashtags.join(" ")}`;
  return { title, description, hashtags, metadataVersion: 5 };
}

export function enrichJobSocialMetadata(job) {
  return {
    ...job,
    clips: (job.clips || []).map((clip) => {
      if (clip.metadataVersion === 5 && clip.title && clip.description && clip.hashtags?.length) return clip;
      return { ...clip, ...generateSocialMetadata(clip.text) };
    }),
  };
}

export function sortJobsNewest(jobs) {
  return [...jobs].sort((left, right) => {
    const leftTime = Date.parse(left.createdAt || left.updatedAt || 0) || 0;
    const rightTime = Date.parse(right.createdAt || right.updatedAt || 0) || 0;
    return rightTime - leftTime;
  });
}

const CANONICAL_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

function formNumber(value, fallback, label) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
    return value;
  }
  if (typeof value !== "string" || !CANONICAL_DECIMAL.test(value)) {
    throw new Error(`${label} must be a canonical decimal number`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be finite`);
  return parsed;
}

function persistedNumber(value, label, integer = false) {
  if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    throw new Error(`Invalid persisted job options: ${label} must be ${integer ? "a finite integer" : "a finite number"}`);
  }
  return value;
}

export function validatePersistedJobOptions(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid persisted job options");
  }
  const renderMode = input.renderMode;
  if (typeof renderMode !== "string" || !RENDER_MODES.includes(renderMode)) {
    throw new Error("Invalid persisted job options: unsupported render mode");
  }
  const limit = persistedNumber(input.limit, "limit", true);
  const minDuration = persistedNumber(input.minDuration, "minimum duration");
  const maxDuration = persistedNumber(input.maxDuration, "maximum duration");
  if (limit < 1 || limit > 10) throw new Error("Invalid persisted job options: limit out of range");
  if (minDuration < 5 || maxDuration > 180 || maxDuration < minDuration) {
    throw new Error("Invalid persisted job options: duration range out of range");
  }
  const options = { renderMode, limit, minDuration, maxDuration };
  if (input.selectionMode === undefined) return options;
  if (typeof input.selectionMode !== "string" || !SELECTION_MODES.includes(input.selectionMode)) {
    throw new Error("Invalid persisted job options: unsupported selection mode");
  }
  options.selectionMode = input.selectionMode;
  if (input.selectionMode === "v1") {
    if (["clipProfile", "maxCandidates", "maxMediaCandidates", "mediaTimeout"].some((key) => input[key] !== undefined)) {
      throw new Error("Invalid persisted job options: V2 options require v2-shadow mode");
    }
    return options;
  }
  const clipProfile = input.clipProfile;
  if (typeof clipProfile !== "string" || !CLIP_PROFILES.includes(clipProfile)) {
    throw new Error("Invalid persisted job options: unsupported clip profile");
  }
  const maxCandidates = persistedNumber(input.maxCandidates, "max candidates", true);
  const maxMediaCandidates = persistedNumber(input.maxMediaCandidates, "max media candidates", true);
  const mediaTimeout = persistedNumber(input.mediaTimeout, "media timeout");
  if (maxCandidates < 1 || maxCandidates > 5000) {
    throw new Error("Invalid persisted job options: max candidates out of range");
  }
  if (maxMediaCandidates < 1 || maxMediaCandidates > Math.min(maxCandidates, 100)) {
    throw new Error("Invalid persisted job options: max media candidates out of range");
  }
  if (mediaTimeout <= 0 || mediaTimeout > 300) {
    throw new Error("Invalid persisted job options: media timeout out of range");
  }
  return { ...options, clipProfile, maxCandidates, maxMediaCandidates, mediaTimeout };
}

export function parseJobOptions(input = {}) {
  const renderMode = input.renderMode || "fit-blur";
  if (!RENDER_MODES.includes(renderMode)) throw new Error("Unsupported render mode");
  const limit = formNumber(input.limit, 5, "limit");
  const minDuration = formNumber(input.minDuration, 20, "minimum duration");
  const maxDuration = formNumber(input.maxDuration, 60, "maximum duration");
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new Error("limit must be an integer between 1 and 10");
  }
  if (minDuration < 5 || maxDuration > 180 || maxDuration < minDuration) {
    throw new Error("duration range must satisfy 5 <= min <= max <= 180");
  }
  const options = { renderMode, limit, minDuration, maxDuration };
  const selectionFields = ["selectionMode", "clipProfile", "maxCandidates", "maxMediaCandidates", "mediaTimeout"];
  const hasSelectionOptions = selectionFields.some((key) => input[key] !== undefined && input[key] !== null && input[key] !== "");
  if (!hasSelectionOptions) return options;

  if (typeof input.selectionMode !== "string" || !SELECTION_MODES.includes(input.selectionMode)) {
    throw new Error("Unsupported selection mode");
  }
  options.selectionMode = input.selectionMode;
  if (input.selectionMode === "v1") {
    if (selectionFields.slice(1).some((key) => input[key] !== undefined && input[key] !== null && input[key] !== "")) {
      throw new Error("V2 selection options require v2-shadow mode");
    }
    return options;
  }

  const clipProfile = input.clipProfile ?? DEFAULT_SHADOW_OPTIONS.clipProfile;
  if (typeof clipProfile !== "string" || !CLIP_PROFILES.includes(clipProfile)) {
    throw new Error("Unsupported clip profile");
  }
  const maxCandidates = formNumber(input.maxCandidates, DEFAULT_SHADOW_OPTIONS.maxCandidates, "max candidates");
  const maxMediaCandidates = formNumber(input.maxMediaCandidates, DEFAULT_SHADOW_OPTIONS.maxMediaCandidates, "max media candidates");
  const mediaTimeout = formNumber(input.mediaTimeout, DEFAULT_SHADOW_OPTIONS.mediaTimeout, "media timeout");
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 5000) {
    throw new Error("max candidates must be an integer between 1 and 5000");
  }
  if (!Number.isInteger(maxMediaCandidates) || maxMediaCandidates < 1 || maxMediaCandidates > Math.min(maxCandidates, 100)) {
    throw new Error("max media candidates must be an integer no greater than min(max candidates, 100)");
  }
  if (mediaTimeout <= 0 || mediaTimeout > 300) {
    throw new Error("media timeout must satisfy 0 < timeout <= 300");
  }
  return { ...options, clipProfile, maxCandidates, maxMediaCandidates, mediaTimeout };
}

const SELECTION_V2_ANALYSIS_ID = /^[0-9a-f]{32}$/;
const SELECTION_V2_WARNING = /^(?:artifact_archive_failed|candidate \d+(?::\d+)?: (?:media_unavailable|media_analysis_warnings=\d+))$/;
const MAX_SELECTION_V2_WARNINGS = 100;
const MAX_SELECTION_V2_WARNING_LENGTH = 160;

export function sanitizeSelectionV2Summary(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (raw.mode !== "v2-shadow" || !["completed", "failed"].includes(raw.status)) return null;
  if (typeof raw.analysis_id !== "string" || !SELECTION_V2_ANALYSIS_ID.test(raw.analysis_id)) return null;
  if (raw.selection_version !== "selection-v2.0") return null;
  if (!Number.isInteger(raw.candidate_count) || raw.candidate_count < 0 || raw.candidate_count > 5000) return null;
  if (raw.artifact !== "analysis/candidates.v2.json") return null;
  if (!Array.isArray(raw.warnings) || raw.warnings.length > MAX_SELECTION_V2_WARNINGS) return null;
  if (raw.warnings.some((warning) => (
    typeof warning !== "string"
    || warning.length > MAX_SELECTION_V2_WARNING_LENGTH
    || !SELECTION_V2_WARNING.test(warning)
  ))) return null;
  if (raw.error !== undefined && raw.error !== "shadow_failed") return null;

  const summary = {
    mode: raw.mode,
    status: raw.status,
    analysis_id: raw.analysis_id,
    selection_version: raw.selection_version,
    candidate_count: raw.candidate_count,
    artifact: raw.artifact,
    warnings: [...raw.warnings],
  };
  if (raw.error !== undefined) summary.error = raw.error;
  return summary;
}

export function serializePublicJob(job) {
  const {
    sourcePath: _sourcePath,
    selectionV2: rawSelectionV2,
    selection_v2: _legacyRawSelectionV2,
    ...safe
  } = job;
  const options = safe.options && typeof safe.options === "object" && !Array.isArray(safe.options)
    ? { ...safe.options, selectionMode: safe.options.selectionMode || "v1" }
    : { selectionMode: "v1" };
  const selectionV2 = sanitizeSelectionV2Summary(rawSelectionV2);
  return enrichJobSocialMetadata({ ...safe, options, ...(selectionV2 ? { selectionV2 } : {}) });
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
