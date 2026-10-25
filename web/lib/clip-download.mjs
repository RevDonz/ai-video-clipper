// Download names and links of a project's clips (A5): one clip saves as "NN-judul-klip.mp4" (its
// number in two digits and an ASCII slug of its title), the same name it gets inside the ZIP.
// Client-safe: no Node built-ins.

import { projectName } from "./project-view.mjs";
import { formatNumber } from "./i18n/format.mjs";
import { SOURCE_LOCALE } from "./i18n/locales.mjs";

// The files route accepts a `name` of ≤ 64 characters (final-files.mjs); a title adds ≤ 48.
const NAME_LIMIT = 64;
const SLUG_LIMIT = 48;
const ZIP_SLUG_LIMIT = 40;

/** `text` as lower-case ASCII words joined by "-", at most `limit` characters, cut at a word end. */
export function slugify(text, limit = SLUG_LIMIT) {
  if (typeof text !== "string") return "";
  const words = text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/['’`]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let slug = "";
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > limit) {
      if (!slug) slug = word.slice(0, limit);
      break;
    }
    slug = next;
  }
  return slug;
}

/** "03-judul-klip": the clip's number (two digits at least) and its title; null without a number. */
export function clipSaveName(clip) {
  const index = clip?.index;
  if (!Number.isSafeInteger(index) || index < 1 || index > 9999) return null;
  const number = String(index).padStart(2, "0");
  const slug = slugify(clip?.title, Math.min(SLUG_LIMIT, NAME_LIMIT - number.length - 1));
  return `${number}-${slug || "klip"}`;
}

/** `href` with `download=1&name=<name>`, which the files route turns into the saved file's name. */
export function namedDownloadHref(href, name) {
  if (typeof href !== "string" || !href) return null;
  if (!name) return href;
  const at = href.indexOf("?");
  const params = new URLSearchParams(at < 0 ? "" : href.slice(at + 1));
  params.set("download", "1");
  params.set("name", name);
  return `${at < 0 ? href : href.slice(0, at)}?${params}`;
}

/** "Unduh MP4" and "Subtitle SRT" of a clip, saved under its name: `{name, mp4, mp4File, srt, srtFile}`. */
export function clipDownloads(clip) {
  const name = clipSaveName(clip);
  const mp4 = namedDownloadHref(clip?.downloadUrl, name);
  const srt = namedDownloadHref(clip?.subtitleUrl, name);
  return {
    name,
    mp4,
    mp4File: name && mp4 ? `${name}.mp4` : null,
    srt,
    srtFile: name && srt ? `${name}.srt` : null,
  };
}

/** The ZIP route of a job: every clip, or the clip numbers in `indexes`; `check` asks for its size only. */
export function zipHref(jobId, indexes = null, { check = false } = {}) {
  const params = new URLSearchParams();
  if (Array.isArray(indexes)) params.set("clips", indexes.join(","));
  if (check) params.set("check", "1");
  const query = params.toString();
  return `/api/jobs/${encodeURIComponent(jobId)}/zip${query ? `?${query}` : ""}`;
}

/** "podcast-episode-12-klip.zip": the project's name without a video extension, as a slug. */
export function zipSaveName(job) {
  const name = projectName(job).replace(/\.(?:mp4|mov|mkv|webm|m4v|avi)$/i, "");
  const slug = slugify(name, ZIP_SLUG_LIMIT)
    || (typeof job?.id === "string" ? slugify(`proyek ${job.id.slice(0, 8)}`, ZIP_SLUG_LIMIT) : "proyek");
  return `${slug}-klip.zip`;
}

const KB = 1024;
const MB = 1024 ** 2;
const GB = 1024 ** 3;

/** "2,4 GB", "18 MB", "98 KB"; null for anything that is not a size. */
export function formatSize(bytes, locale = SOURCE_LOCALE) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes >= GB) return `${formatNumber(bytes / GB, locale, { maximumFractionDigits: 1 })} GB`;
  if (bytes >= MB) return `${formatNumber(Math.round(bytes / MB), locale)} MB`;
  return `${formatNumber(Math.round(bytes / KB), locale)} KB`;
}
