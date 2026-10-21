// Rentang waktu (plan 2026-10-20 P2): time ranges the person types, each kept as a clip. The
// same grammar and messages as the engine (src/ai_clipper/time_ranges.py; a test compares them),
// so the dashboard refuses a range before any upload or download and the job API refuses it
// again. Client-safe: no Node built-ins.
//
// A range is "<start>-<end>". A time is whole seconds ("90"), minutes and seconds ("10.30" or
// "10:30") or hours, minutes and seconds ("1:02:10" or "1.02.10"); parts after the first have
// exactly two digits, 00 to 59. Full-width digits and punctuation read as ASCII (NFKC); a hyphen,
// en dash, em dash or minus sign separates the times. Ranges are separated by commas, semicolons
// or line breaks and keep the typed order.

import { CLIP_LIMITS } from "./clip-limits.mjs";

export const TIME_RANGE_LIMITS = Object.freeze({
  min: CLIP_LIMITS.seconds.min, max: CLIP_LIMITS.seconds.max, ranges: CLIP_LIMITS.count.max, text: 500,
});
// Codes of a failed job whose typed range the engine refused once the video was read; the
// engine's own line says which range and why.
export const RANGE_FAILURE_CODES = Object.freeze(["range_beyond_video", "range_no_speech"]);

const MAX_SHOWN = 24;
const EXAMPLE = "Contoh: 10.30-12.05 atau 1:02:10-1:03:00.";
const SEPARATORS = /[,;\r\n]+/;
const RANGE = /^\s*([0-9:.]+)\s*[-‐‑‒–—−]\s*([0-9:.]+)\s*$/;
const DIGITS = /^[0-9]+$/;

/** A range the job cannot use; the message is Indonesian and says what to fix. */
export class TimeRangeError extends Error {
  constructor(message, { unknown = false } = {}) {
    super(message);
    this.name = "TimeRangeError";
    this.code = "time_range_invalid";
    this.unknown = unknown;
  }
}

const codePoints = (text) => Array.from(text);

function shown(text) {
  const points = codePoints(text.trim());
  return points.length <= MAX_SHOWN ? points.join("") : `${points.slice(0, MAX_SHOWN).join("")}…`;
}

const unknown = (text) => new TimeRangeError(`“${shown(text)}” tidak dikenali. ${EXAMPLE}`, { unknown: true });

/** m:ss or h:mm:ss of the whole seconds in `seconds`. */
export function formatClock(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

/** "10:30–12:05". */
export function rangeLabel(range) {
  return `${formatClock(range.start)}–${formatClock(range.end)}`;
}

/** Whole seconds of one typed time. */
export function parseTime(text) {
  if (typeof text !== "string") throw new TypeError("time must be text");
  const parts = text.normalize("NFKC").trim().split(/[:.]/);
  if (!parts.every((part) => DIGITS.test(part))) throw unknown(text);
  if (parts.length === 1) {
    if (parts[0].length > 5) throw unknown(text);
    return Number(parts[0]);
  }
  const [lead, ...rest] = parts;
  if (parts.length > 3 || rest.some((part) => part.length !== 2) || lead.length > 5 - parts.length) throw unknown(text);
  if (rest.some((part) => Number(part) >= 60)) throw new TimeRangeError(`“${shown(text)}” tidak valid: menit dan detik hanya 00 sampai 59.`);
  return parts.reduce((seconds, part) => seconds * 60 + Number(part), 0);
}

/** `{ start, end }` once it is a range a clip can be: start before end, 5 to 180 seconds. */
function checkedRange(start, end) {
  const range = { start, end };
  if (start < 0 || end <= start) throw new TimeRangeError(`Rentang ${rangeLabel(range)}: waktu selesai harus setelah waktu mulai.`);
  if (end - start < TIME_RANGE_LIMITS.min) throw new TimeRangeError(`Rentang ${rangeLabel(range)} terlalu pendek: minimal ${TIME_RANGE_LIMITS.min} detik.`);
  if (end - start > TIME_RANGE_LIMITS.max) {
    throw new TimeRangeError(`Rentang ${rangeLabel(range)} terlalu panjang: maksimal ${TIME_RANGE_LIMITS.max} detik (${TIME_RANGE_LIMITS.max / 60} menit).`);
  }
  return range;
}

/** One typed range, such as "10.30-12.05", as `{ start, end }` in whole seconds. */
export function parseTimeRange(text) {
  if (typeof text !== "string") throw new TypeError("time range must be text");
  const match = RANGE.exec(text.normalize("NFKC"));
  if (!match) throw unknown(text);
  let start;
  let end;
  try {
    start = parseTime(match[1]);
    end = parseTime(match[2]);
  } catch (error) {
    if (error instanceof TimeRangeError && error.unknown) throw unknown(text);
    throw error;
  }
  return checkedRange(start, end);
}

/** The ranges once they fit together: at most 10, at most `limit` (the clip count), no overlap. */
export function checkRanges(ranges, limit = null) {
  if (ranges.length > TIME_RANGE_LIMITS.ranges) throw new TimeRangeError(`Maksimal ${TIME_RANGE_LIMITS.ranges} rentang waktu.`);
  ranges.forEach((first, index) => {
    for (const second of ranges.slice(index + 1)) {
      if (first.start < second.end && second.start < first.end) {
        throw new TimeRangeError(`Rentang ${rangeLabel(first)} dan ${rangeLabel(second)} tumpang tindih.`);
      }
    }
  });
  if (Number.isSafeInteger(limit) && ranges.length > limit) {
    throw new TimeRangeError(`Ada ${ranges.length} rentang waktu, tetapi jumlah klip ${limit}. Naikkan jumlah klip atau kurangi rentang.`);
  }
  return ranges;
}

const pieces = (text) => text.split(SEPARATORS).filter((piece) => piece.trim());

/** Every range in `text` (empty pieces skipped), checked against each other and `limit`. */
export function parseTimeRanges(text, limit = null) {
  if (typeof text !== "string") throw new TimeRangeError("Rentang waktu harus berupa teks.");
  if (codePoints(text).length > TIME_RANGE_LIMITS.text) throw new TimeRangeError("Isian rentang waktu terlalu panjang.");
  return checkRanges(pieces(text).map(parseTimeRange), limit);
}

/** The dashboard's message for the field, or "" when it is empty or fine. */
export function timeRangesProblem(text, limit = null) {
  try {
    parseTimeRanges(String(text ?? ""), limit);
    return "";
  } catch (error) {
    if (error instanceof TimeRangeError) return error.message;
    throw error;
  }
}

/** How many ranges the field holds as typed (for the folded options' summary line). */
export function typedRangeCount(text) {
  return typeof text === "string" ? pieces(text).length : 0;
}

/** Whether `value` is a stored options.ranges: the shape and rules parseTimeRanges writes. */
export function validStoredRanges(value, limit) {
  if (!Array.isArray(value) || value.length < 1) return false;
  const ranges = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const keys = Object.keys(entry);
    if (keys.length !== 2 || !keys.includes("start") || !keys.includes("end")) return false;
    if (!Number.isSafeInteger(entry.start) || !Number.isSafeInteger(entry.end)) return false;
    ranges.push({ start: entry.start, end: entry.end });
  }
  try {
    ranges.forEach(({ start, end }) => checkedRange(start, end));
    checkRanges(ranges, limit);
    return true;
  } catch (error) {
    if (error instanceof TimeRangeError) return false;
    throw error;
  }
}
