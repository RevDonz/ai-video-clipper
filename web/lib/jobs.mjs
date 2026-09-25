import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { CLIP_THUMBNAIL_URL } from "./selection-v3-view.mjs";

export const RENDER_MODES = ["face-track", "fit-blur", "center-crop"];
export const SELECTION_MODES = ["v1", "v2-shadow", "v3"];
export const CLIP_PROFILES = ["viral-short", "standard", "deep-dive"];
export const LLM_MODES = ["auto", "off"];
export const CAPTION_STYLES = ["karaoke", "classic"];
export const DEFAULT_SHADOW_OPTIONS = Object.freeze({
  clipProfile: "standard",
  maxCandidates: 200,
  maxMediaCandidates: 12,
  mediaTimeout: 30,
});
export const DEFAULT_V3_OPTIONS = Object.freeze({
  llmMode: "auto",
  coldOpen: true,
  hookOverlay: true,
  captionStyle: "karaoke",
});
const V2_OPTION_KEYS = ["clipProfile", "maxCandidates", "maxMediaCandidates", "mediaTimeout"];
const V3_OPTION_KEYS = ["llmMode", "coldOpen", "hookOverlay", "captionStyle"];
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

// Clips selected by Selection V3 arrive with the engine's own packaging (title,
// description and hashtags). They are kept; only a missing description or
// hashtag list is filled from the transcript. The description keeps the
// established convention of ending with the hashtag line, so every "Salin
// caption" button copies `${title}\n\n${description}` unchanged.
const PACKAGED_SOURCES = new Set(["llm", "heuristic"]);

export function hasEnginePackaging(clip) {
  return Boolean(clip) && PACKAGED_SOURCES.has(clip.selectionSource)
    && typeof clip.title === "string" && clip.title.trim() !== "";
}

function hashtagLine(hashtags) {
  return hashtags.join(" ");
}

function withHashtagLine(body, hashtags) {
  if (!hashtags.length) return body;
  const lower = body.toLocaleLowerCase("id-ID");
  if (hashtags.every((tag) => lower.includes(tag.toLocaleLowerCase("id-ID")))) return body;
  return body ? `${body}\n\n${hashtagLine(hashtags)}` : hashtagLine(hashtags);
}

export function clipSocialMetadata(clip) {
  if (!hasEnginePackaging(clip)) return generateSocialMetadata(clip?.text);
  const hashtags = Array.isArray(clip.hashtags) && clip.hashtags.length ? clip.hashtags : null;
  const description = typeof clip.description === "string" && clip.description.trim() ? clip.description : null;
  const generated = hashtags && description ? null : generateSocialMetadata(clip.text);
  const tags = hashtags || generated.hashtags;
  const body = description || (generated.description.endsWith(hashtagLine(generated.hashtags))
    ? generated.description.slice(0, -hashtagLine(generated.hashtags).length).trimEnd()
    : generated.description);
  return { title: clip.title, description: withHashtagLine(body, tags), hashtags: [...tags], metadataVersion: 5 };
}

export function enrichJobSocialMetadata(job) {
  return {
    ...job,
    clips: (job.clips || []).map((clip) => {
      if (hasEnginePackaging(clip)) return { ...clip, ...clipSocialMetadata(clip) };
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

function formBoolean(value, fallback, label) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${label} must be true or false`);
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
  const persisted = (keys) => keys.some((key) => input[key] !== undefined);
  if (input.selectionMode !== "v2-shadow" && persisted(V2_OPTION_KEYS)) {
    throw new Error("Invalid persisted job options: V2 options require v2-shadow mode");
  }
  if (input.selectionMode !== "v3" && persisted(V3_OPTION_KEYS)) {
    throw new Error("Invalid persisted job options: V3 options require v3 mode");
  }
  if (input.selectionMode === "v1") return options;
  if (input.selectionMode === "v3") {
    if (typeof input.llmMode !== "string" || !LLM_MODES.includes(input.llmMode)) {
      throw new Error("Invalid persisted job options: unsupported LLM mode");
    }
    if (typeof input.coldOpen !== "boolean") throw new Error("Invalid persisted job options: cold open must be a boolean");
    if (typeof input.hookOverlay !== "boolean") throw new Error("Invalid persisted job options: hook overlay must be a boolean");
    if (typeof input.captionStyle !== "string" || !CAPTION_STYLES.includes(input.captionStyle)) {
      throw new Error("Invalid persisted job options: unsupported caption style");
    }
    return {
      ...options,
      llmMode: input.llmMode,
      coldOpen: input.coldOpen,
      hookOverlay: input.hookOverlay,
      captionStyle: input.captionStyle,
    };
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
  const provided = (key) => input[key] !== undefined && input[key] !== null && input[key] !== "";
  const hasSelectionOptions = ["selectionMode", ...V2_OPTION_KEYS, ...V3_OPTION_KEYS].some(provided);
  if (!hasSelectionOptions) return options;

  if (typeof input.selectionMode !== "string" || !SELECTION_MODES.includes(input.selectionMode)) {
    throw new Error("Unsupported selection mode");
  }
  options.selectionMode = input.selectionMode;
  if (input.selectionMode !== "v2-shadow" && V2_OPTION_KEYS.some(provided)) {
    throw new Error("V2 selection options require v2-shadow mode");
  }
  if (input.selectionMode !== "v3" && V3_OPTION_KEYS.some(provided)) {
    throw new Error("V3 selection options require v3 mode");
  }
  if (input.selectionMode === "v1") return options;
  if (input.selectionMode === "v3") {
    const llmMode = provided("llmMode") ? input.llmMode : DEFAULT_V3_OPTIONS.llmMode;
    if (typeof llmMode !== "string" || !LLM_MODES.includes(llmMode)) throw new Error("Unsupported LLM mode");
    const captionStyle = provided("captionStyle") ? input.captionStyle : DEFAULT_V3_OPTIONS.captionStyle;
    if (typeof captionStyle !== "string" || !CAPTION_STYLES.includes(captionStyle)) throw new Error("Unsupported caption style");
    return {
      ...options,
      llmMode,
      coldOpen: formBoolean(input.coldOpen, DEFAULT_V3_OPTIONS.coldOpen, "cold open"),
      hookOverlay: formBoolean(input.hookOverlay, DEFAULT_V3_OPTIONS.hookOverlay, "hook overlay"),
      captionStyle,
    };
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

// --- Manifest-derived text -------------------------------------------------
// Everything below comes from the engine's manifest, which in turn carries LLM
// output. Strings are length-capped (in code points) and stripped of control
// and bidi-override characters before they are persisted or served.

const INVISIBLE_CHARACTERS = /[\p{Cc}\u00ad\u061c\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]/gu;
const HORIZONTAL_SPACE = /[^\S\n]+/g;

function wellFormed(value) {
  return typeof value.toWellFormed === "function" ? value.toWellFormed() : value;
}

function truncateCodePoints(value, maximum) {
  const characters = Array.from(value);
  if (characters.length <= maximum) return value;
  const shortened = characters.slice(0, maximum - 1).join("");
  const boundary = Math.max(shortened.lastIndexOf(" "), shortened.lastIndexOf("\n"));
  const cut = boundary > shortened.length * 0.6 ? shortened.slice(0, boundary) : shortened;
  return `${cut.trimEnd()}…`;
}

/** One line of display text, or null when nothing printable is left. */
export function sanitizeLine(value, maximum) {
  if (typeof value !== "string") return null;
  const cleaned = wellFormed(value).replace(/\s+/gu, " ").replace(INVISIBLE_CHARACTERS, "").trim();
  return cleaned ? truncateCodePoints(cleaned, maximum) : null;
}

/** Multi-line display text: newlines survive (at most one blank line in a row). */
export function sanitizeMultiline(value, maximum) {
  if (typeof value !== "string") return null;
  const cleaned = wellFormed(value)
    .replace(/\r\n?|[\u2028\u2029\v\f]/g, "\n")
    .replace(/\t/g, " ")
    .replace(INVISIBLE_CHARACTERS, (character) => (character === "\n" ? "\n" : ""))
    .split("\n")
    .map((line) => line.replace(HORIZONTAL_SPACE, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned ? truncateCodePoints(cleaned, maximum) : null;
}

export const CLIP_TEXT_LIMITS = Object.freeze({
  title: 100,
  hookText: 90,
  description: 600,
  storedDescription: 1200,
  hashtag: 40,
  hashtags: 10,
  reason: 300,
  reasons: 8,
  text: 8000,
});
export const SCORE_DIMENSIONS = Object.freeze(["hook", "standalone", "payoff", "emotion", "shareability"]);
export const SELECTION_SOURCES = Object.freeze(["v1", "llm", "heuristic"]);
const ARCHETYPE_CODE = /^[a-z][a-z0-9_]{0,39}$/;
const HASHTAG_BODY = /^[\p{L}\p{N}_]+$/u;
const MAX_COLD_OPEN_SECONDS = 30;

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sanitizeHashtags(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const tags = [];
  for (const item of value) {
    if (tags.length >= CLIP_TEXT_LIMITS.hashtags) break;
    const line = sanitizeLine(item, 200);
    if (!line) continue;
    const body = line.replace(/^#+/, "").replace(/\s+/g, "");
    if (!body || Array.from(body).length > CLIP_TEXT_LIMITS.hashtag || !HASHTAG_BODY.test(body)) continue;
    const key = body.toLocaleLowerCase("id-ID");
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(`#${body}`);
  }
  return tags;
}

function sanitizeReasons(value) {
  if (!Array.isArray(value)) return [];
  const reasons = [];
  for (const item of value) {
    if (reasons.length >= CLIP_TEXT_LIMITS.reasons) break;
    const reason = sanitizeLine(item, CLIP_TEXT_LIMITS.reason);
    if (reason) reasons.push(reason);
  }
  return reasons;
}

// Konteks Tren: the trends a clip is grounded in (the engine checked that the clip's own
// transcript mentions them). Only { id, title, kind } is kept; ids are the store's UUIDs.
// Mirrors TREND_KINDS in trend-context.mjs (kept equal by a test; this module stays light).
export const CLIP_TREND_KINDS = Object.freeze(["topic", "person", "joke", "meme", "sound", "hashtag", "format", "event"]);
export const MAX_CLIP_TRENDS = 5;
const CLIP_TREND_TITLE_LIMIT = 80;
const TREND_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sanitizeTrendRefs(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const refs = [];
  for (const entry of value) {
    if (refs.length >= MAX_CLIP_TRENDS) break;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (typeof entry.id !== "string" || !TREND_ID.test(entry.id)) continue;
    const id = entry.id.toLowerCase();
    if (seen.has(id) || !CLIP_TREND_KINDS.includes(entry.kind)) continue;
    const title = sanitizeLine(entry.title, CLIP_TREND_TITLE_LIMIT);
    if (!title) continue;
    seen.add(id);
    refs.push({ id, title, kind: entry.kind });
  }
  return refs;
}

function sanitizeScores(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const scores = {};
  for (const name of SCORE_DIMENSIONS) {
    const score = finiteNumber(value[name]);
    if (score !== null && score >= 0 && score <= 10) scores[name] = round(score, 2);
  }
  return Object.keys(scores).length ? scores : null;
}

function sanitizeColdOpen(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const start = finiteNumber(value.start);
  const end = finiteNumber(value.end);
  if (start === null || end === null || start < 0 || end <= start || end - start > MAX_COLD_OPEN_SECONDS) return null;
  return { start: round(start, 3), end: round(end, 3) };
}

function sanitizeArchetype(value) {
  if (typeof value !== "string") return null;
  const code = value.trim().toLowerCase().replace(/-/g, "_");
  return ARCHETYPE_CODE.test(code) ? code : null;
}

/**
 * The Selection V3 fields of one clip, validated field by field. `names` maps
 * each field to its key in `raw`, so the same rules read a manifest clip
 * (snake_case) and a persisted job clip (camelCase). Invalid values are
 * dropped, never coerced from another type.
 */
function sanitizeV3ClipFields(raw, names, descriptionLimit) {
  const fields = {};
  const title = sanitizeLine(raw[names.title], CLIP_TEXT_LIMITS.title);
  if (title) fields.title = title;
  const hookText = sanitizeLine(raw[names.hookText], CLIP_TEXT_LIMITS.hookText);
  if (hookText) fields.hookText = hookText;
  const description = sanitizeMultiline(raw[names.description], descriptionLimit);
  if (description) fields.description = description;
  const hashtags = sanitizeHashtags(raw[names.hashtags]);
  if (hashtags.length) fields.hashtags = hashtags;
  const archetype = sanitizeArchetype(raw[names.archetype]);
  if (archetype) fields.archetype = archetype;
  if (SELECTION_SOURCES.includes(raw[names.selectionSource])) fields.selectionSource = raw[names.selectionSource];
  const reasons = sanitizeReasons(raw[names.reasons]);
  if (reasons.length) fields.reasons = reasons;
  const scores = sanitizeScores(raw[names.scores]);
  if (scores) fields.scores = scores;
  const coldOpen = sanitizeColdOpen(raw[names.coldOpen]);
  if (coldOpen) fields.coldOpen = coldOpen;
  const sourceStart = finiteNumber(raw[names.sourceStart]);
  const sourceEnd = finiteNumber(raw[names.sourceEnd]);
  if (sourceStart !== null && sourceEnd !== null && sourceStart >= 0 && sourceEnd > sourceStart) {
    fields.sourceStart = round(sourceStart, 3);
    fields.sourceEnd = round(sourceEnd, 3);
  }
  const trends = sanitizeTrendRefs(raw[names.trends]);
  if (trends.length) fields.trends = trends;
  return fields;
}

const MANIFEST_V3_NAMES = Object.freeze({
  title: "title", hookText: "hook_text", description: "description", hashtags: "hashtags",
  archetype: "archetype", selectionSource: "selection_source", reasons: "reasons", scores: "scores",
  coldOpen: "cold_open", sourceStart: "source_start", sourceEnd: "source_end", trends: "trends",
});
const JOB_V3_NAMES = Object.freeze({
  title: "title", hookText: "hookText", description: "description", hashtags: "hashtags",
  archetype: "archetype", selectionSource: "selectionSource", reasons: "reasons", scores: "scores",
  coldOpen: "coldOpen", sourceStart: "sourceStart", sourceEnd: "sourceEnd", trends: "trends",
});
const JOB_V3_ONLY_KEYS = ["hookText", "archetype", "selectionSource", "reasons", "scores", "coldOpen", "sourceStart", "sourceEnd", "trends"];

/** A manifest clip's Selection V3 packaging, sanitized, as camelCase job-clip fields. */
export function sanitizeManifestClipFields(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return sanitizeV3ClipFields(raw, MANIFEST_V3_NAMES, CLIP_TEXT_LIMITS.description);
}

// --- Clip posters ---------------------------------------------------------

// The engine writes each poster beside its clip: clip-01.mp4 -> clip-01.jpg.
const THUMBNAIL_FILE = /^clip-\d{1,4}\.jpg$/;
const MAX_MANIFEST_PATH = 4096;
export const MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024;

/** The poster file name from a manifest clip's `thumbnail` path, or null when it is not a clip poster. */
export function manifestThumbnailName(value) {
  if (typeof value !== "string" || value.length > MAX_MANIFEST_PATH || value.includes("\0")) return null;
  const name = path.basename(value);
  return THUMBNAIL_FILE.test(name) ? name : null;
}

export function clipThumbnailUrl(jobId, name) {
  return `/api/jobs/${jobId}/files/output/${name}`;
}

function isOwnThumbnailUrl(value, jobId) {
  const match = typeof value === "string" ? CLIP_THUMBNAIL_URL.exec(value) : null;
  return Boolean(match) && (jobId === undefined || match[1] === jobId);
}

/**
 * Re-validates a persisted clip before it is served. Clips without any V3
 * field (every job created before Selection V3) are returned untouched,
 * except that a poster URL is only kept when it names this job's clip-XX.jpg.
 */
export function sanitizeStoredClip(clip, jobId) {
  if (!clip || typeof clip !== "object" || Array.isArray(clip)) return clip;
  if ("thumbnailUrl" in clip && !isOwnThumbnailUrl(clip.thumbnailUrl, jobId)) {
    const { thumbnailUrl: _unsafe, ...rest } = clip;
    clip = rest;
  }
  if (!JOB_V3_ONLY_KEYS.some((key) => clip[key] !== undefined)) return clip;
  const rest = { ...clip };
  for (const key of [...JOB_V3_ONLY_KEYS]) delete rest[key];
  const fields = sanitizeV3ClipFields(clip, JOB_V3_NAMES, CLIP_TEXT_LIMITS.storedDescription);
  const next = { ...rest };
  for (const key of JOB_V3_ONLY_KEYS) if (fields[key] !== undefined) next[key] = fields[key];
  if (hasEnginePackaging(fields)) {
    next.title = fields.title;
    if (fields.description) next.description = fields.description;
    else delete next.description;
    if (fields.hashtags) next.hashtags = fields.hashtags;
    else delete next.hashtags;
  } else if (PACKAGED_SOURCES.has(clip.selectionSource)) {
    // Claimed engine packaging that no longer validates is not served as-is:
    // without a title the transcript-derived metadata is regenerated.
    delete next.title;
    delete next.description;
    delete next.hashtags;
    delete next.metadataVersion;
  }
  return next;
}

// --- Selection V3 summary --------------------------------------------------

const SELECTION_V3_STATUSES = ["completed", "fallback", "failed"];
const SELECTION_V3_SOURCES = ["llm", "heuristic"];
const SELECTION_V3_TRANSCRIPT_SOURCES = ["youtube-captions", "whisper"];
const SELECTION_V3_ARTIFACT = "analysis/selection.v3.json";
const SELECTION_V3_PROVIDER = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const SELECTION_V3_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$/;
const SELECTION_V3_PROMPT_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Short stable codes such as "llm_unavailable", "llm_error:rate_limited" or
// "punctuation_collapse:120-420". No spaces, "=" or quotes, so free text such
// as an error message (or a secret inside one) can never pass.
const SELECTION_V3_WARNING = /^[a-z][a-z0-9_]{0,63}(?::[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,95})?$/;
const MAX_SELECTION_V3_WARNINGS = 50;

function safeCode(value, pattern) {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

/**
 * Strict allowlist for the manifest's top-level `selection_v3`. The structural
 * fields must be valid or the whole summary is dropped; descriptive fields
 * (provider, model, prompt version) become null when invalid, and warnings
 * that are not short codes are left out one by one.
 */
export function sanitizeSelectionV3Summary(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (raw.mode !== "v3" || !SELECTION_V3_STATUSES.includes(raw.status)) return null;
  let source = null;
  if (SELECTION_V3_SOURCES.includes(raw.source)) source = raw.source;
  else if (raw.status !== "failed" || (raw.source !== undefined && raw.source !== null)) return null;
  if (raw.status === "fallback" && source !== "heuristic") return null;
  if (raw.artifact !== undefined && raw.artifact !== null && raw.artifact !== SELECTION_V3_ARTIFACT) return null;
  if (raw.warnings !== undefined && raw.warnings !== null && !Array.isArray(raw.warnings)) return null;
  const warnings = [];
  for (const warning of raw.warnings || []) {
    if (warnings.length >= MAX_SELECTION_V3_WARNINGS) break;
    if (typeof warning === "string" && warning.length <= 160 && SELECTION_V3_WARNING.test(warning) && !warnings.includes(warning)) {
      warnings.push(warning);
    }
  }
  return {
    mode: "v3",
    status: raw.status,
    source,
    provider: safeCode(raw.provider, SELECTION_V3_PROVIDER),
    model: safeCode(raw.model, SELECTION_V3_MODEL),
    prompt_version: safeCode(raw.prompt_version, SELECTION_V3_PROMPT_VERSION),
    warnings,
    artifact: raw.artifact === SELECTION_V3_ARTIFACT ? SELECTION_V3_ARTIFACT : null,
    transcript_source: SELECTION_V3_TRANSCRIPT_SOURCES.includes(raw.transcript_source) ? raw.transcript_source : null,
  };
}

export function serializePublicJob(job) {
  const {
    sourcePath: _sourcePath,
    selectionV2: rawSelectionV2,
    selection_v2: _legacyRawSelectionV2,
    selectionV3: rawSelectionV3,
    selection_v3: _legacyRawSelectionV3,
    ...safe
  } = job;
  const options = safe.options && typeof safe.options === "object" && !Array.isArray(safe.options)
    ? { ...safe.options, selectionMode: safe.options.selectionMode || "v1" }
    : { selectionMode: "v1" };
  const selectionV2 = sanitizeSelectionV2Summary(rawSelectionV2);
  const selectionV3 = sanitizeSelectionV3Summary(rawSelectionV3);
  if (Array.isArray(safe.clips)) safe.clips = safe.clips.map((clip) => sanitizeStoredClip(clip, safe.id));
  return enrichJobSocialMetadata({
    ...safe,
    options,
    ...(selectionV2 ? { selectionV2 } : {}),
    ...(selectionV3 ? { selectionV3 } : {}),
  });
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
  if (!match || !Number.isSafeInteger(size) || size <= 0) throw new Error("Invalid byte range");
  const integer = (raw) => {
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed)) throw new Error("Invalid byte range");
    return parsed;
  };
  let start;
  let end;
  if (match[1] === "") {
    const suffix = integer(match[2]);
    if (suffix <= 0) throw new Error("Invalid byte range");
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = integer(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(integer(match[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
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
