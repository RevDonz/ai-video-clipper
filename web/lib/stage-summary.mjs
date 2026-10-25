// What each finished stage of a job found, as the job progress lists it on the dashboard and the
// project page. Client-safe. The engine reports the values on its progress lines
// (src/ai_clipper/pipeline.py "Stage summaries"); the worker keeps them in job.stageSummary.
// Only values the engine reported are shown: a stage without one has no row.

import { formatTimestamp } from "./selection-v3-view.mjs";
import { displayNames, numberFormat } from "./i18n/format.mjs";
import { SOURCE_LOCALE } from "./i18n/locales.mjs";

const TRANSCRIPT_SOURCES = Object.freeze({
  "srt-upload": "dari subtitle .srt",
  "youtube-captions": "dari subtitle YouTube",
  whisper: "dari audio",
  groq: "dari audio lewat Groq",
});
const MOMENT_SOURCES = Object.freeze(["llm", "heuristic"]);
const LANGUAGE_CODE = /^[a-z]{2,3}$/;
const MAX_DURATION_SECONDS = 7 * 24 * 3600;
const MAX_WORDS = 10_000_000;
const MAX_MOMENTS = 1000;

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const count = (value, maximum) => (Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null);

function video(raw) {
  const duration = raw?.duration;
  return typeof duration === "number" && Number.isFinite(duration) && duration > 0 && duration <= MAX_DURATION_SECONDS
    ? { duration }
    : null;
}

function transcript(raw) {
  const words = count(raw?.words, MAX_WORDS);
  const source = Object.hasOwn(TRANSCRIPT_SOURCES, raw?.source) ? raw.source : null;
  if (words === null && source === null) return null;
  const language = typeof raw.language === "string" && LANGUAGE_CODE.test(raw.language) ? raw.language : null;
  return {
    ...(words === null ? {} : { words }),
    ...(source === null ? {} : { source }),
    ...(language === null ? {} : { language }),
  };
}

function moments(raw) {
  const kept = count(raw?.count, MAX_MOMENTS);
  if (kept === null) return null;
  // Rentang waktu: how many of the clips came from ranges the person typed.
  const typed = count(raw.ranges, kept);
  return {
    count: kept,
    ...(MOMENT_SOURCES.includes(raw.source) ? { source: raw.source } : {}),
    ...(typed ? { ranges: typed } : {}),
  };
}

const KINDS = Object.freeze({ video, transcript, moments });

/** The known kinds and fields of an engine or job summary, or null when nothing in it is valid. */
export function sanitizeStageSummary(raw) {
  if (!isPlainObject(raw)) return null;
  const summary = {};
  for (const [kind, clean] of Object.entries(KINDS)) {
    if (!Object.hasOwn(raw, kind) || !isPlainObject(raw[kind])) continue;
    const values = clean(raw[kind]);
    if (values) summary[kind] = values;
  }
  return Object.keys(summary).length ? summary : null;
}

const NUMBER = numberFormat(SOURCE_LOCALE);

function languageName(code) {
  try {
    const name = displayNames(SOURCE_LOCALE, { type: "language" }).of(code);
    return name && name.toLowerCase() !== code ? name : null;
  } catch {
    return null;
  }
}

function transcriptText(values, job) {
  const parts = [];
  if (values.words !== undefined) parts.push(`${NUMBER.format(values.words)} kata`);
  if (values.source) parts.push(TRANSCRIPT_SOURCES[values.source]);
  // The language matters only when the owner asked the engine to detect it.
  const name = job?.options?.videoLanguage === "auto" && values.language ? languageName(values.language) : null;
  if (name) parts.push(`bahasa ${name}`);
  return parts.join(" · ");
}

/** The rows under the progress bar: [{ key, label, text }], in pipeline order. */
export function stageSummaryRows(job) {
  const summary = sanitizeStageSummary(job?.stageSummary);
  const rows = [];
  if (summary?.video) rows.push({ key: "video", label: "Video", text: formatTimestamp(summary.video.duration) });
  if (summary?.transcript) rows.push({ key: "transcript", label: "Transkrip", text: transcriptText(summary.transcript, job) });
  if (summary?.moments) {
    const { count: kept, source, ranges = 0 } = summary.moments;
    const parts = ranges ? [`${NUMBER.format(ranges)} dari rentang waktu`] : [];
    if (kept > ranges || !ranges) parts.push(`${NUMBER.format(kept - ranges)} dipilih${source === "llm" ? " AI" : ""}`);
    rows.push({ key: "moments", label: "Momen", text: parts.join(" · ") });
  }
  const clips = job?.status === "completed" && Array.isArray(job.clips) ? job.clips.length : 0;
  if (clips) rows.push({ key: "clips", label: "Klip", text: `${NUMBER.format(clips)} siap` });
  return rows;
}
