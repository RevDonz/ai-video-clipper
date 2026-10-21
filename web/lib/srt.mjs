// The .srt a person may attach next to an uploaded video, checked before the job is created.
// Client-safe. The rules are the engine's (src/ai_clipper/srt_captions.py), which reads the file
// as the job's transcript; both run the cases in tests/fixtures/srt. Messages are Indonesian and
// never repeat the file's text.

export const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024;
const MAX_TIME_MS = 86_400_000;
const MAX_CUE_CHARACTERS = 10_000;

const TIME = String.raw`(\d{1,3}):([0-5]\d):([0-5]\d)[,.](\d{1,3})`;
const TIMING = new RegExp(String.raw`^\s*${TIME}\s*-->\s*${TIME}(?:\s.*)?$`);
const INDEX = /^\s*\d+\s*$/;
const BLANK = /\n[ \t]*\n/;
const MARKUP = /<[^<>\n]{0,100}>|\{\\[^{}\n]{0,200}\}/g;

export class SubtitleUploadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SubtitleUploadError";
    this.code = code;
  }
}

const refuse = (code, message) => { throw new SubtitleUploadError(code, message); };

function milliseconds([hours, minutes, seconds, fraction]) {
  return (Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000 + Number(fraction.padEnd(3, "0"));
}

function cleanText(lines) {
  return lines.map((line) => line.replace(MARKUP, "").split(/\s+/).filter(Boolean).join(" ")).filter(Boolean).join("\n");
}

/** `{ cues }`: how many cues hold text; throws SubtitleUploadError when the file is not usable. */
export function validateSrt(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : null;
  if (!data) throw new TypeError("bytes must be a Uint8Array");
  if (data.byteLength > MAX_SUBTITLE_BYTES) refuse("size", "Subtitle .srt maksimal 2 MB.");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    refuse("encoding", "Subtitle .srt harus berkode UTF-8.");
  }
  if (text.includes("\0")) refuse("encoding", "Subtitle .srt harus berkode UTF-8.");
  text = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");

  const cues = [];
  text.trim().split(BLANK).forEach((block, position) => {
    const number = position + 1;
    const lines = block.replace(/^\n+|\n+$/g, "").split("\n");
    if (!lines.some((line) => line.trim())) return;
    const timingAt = lines.length > 1 && INDEX.test(lines[0]) ? 1 : 0;
    const timing = TIMING.exec(lines[timingAt]);
    if (!timing) {
      if (!cues.length) refuse("structure", `File .srt tidak terbaca: subtitle ke-${number} tanpa baris waktu.`);
      cues.at(-1).lines.push(...lines);
    } else {
      const start = milliseconds(timing.slice(1, 5));
      const end = milliseconds(timing.slice(5, 9));
      if (end <= start || end > MAX_TIME_MS) refuse("timing", `Waktu subtitle ke-${number} tidak valid.`);
      cues.push({ lines: lines.slice(timingAt + 1) });
    }
    const cue = cues.at(-1);
    cue.text = cleanText(cue.lines);
    if ([...cue.text].length > MAX_CUE_CHARACTERS) refuse("too_long", `Teks subtitle ke-${number} terlalu panjang.`);
  });
  const withText = cues.filter((cue) => cue.text).length;
  if (!withText) refuse("empty", "File .srt tidak berisi teks subtitle.");
  return { cues: withText };
}
