import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const RENDER_MODES = ["face-track", "fit-blur", "center-crop"];
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
