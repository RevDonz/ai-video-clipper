// The note on a YouTube job whose video, by YouTube's own metadata, is not in Indonesian.
// Client-safe. The worker stores the code yt-dlp reports (scripts/run-job.mjs readVideoLanguage)
// as job.sourceLanguage; the note never blocks or changes the job.
import { displayNames } from "./i18n/format.mjs";
import { SOURCE_LOCALE } from "./i18n/locales.mjs";


const LANGUAGE_CODE = /^[a-z]{2,3}$/;
// "in" is the old code for Indonesian.
const INDONESIAN = new Set(["id", "in", "ind"]);

function languageName(code) {
  try {
    const name = displayNames(SOURCE_LOCALE, { type: "language" }).of(code);
    return name && name.toLowerCase() !== code ? name : null;
  } catch {
    return null;
  }
}

/** `{ tone, text }` for a known non-Indonesian video on an "auto" or Indonesian job, else null. */
export function videoLanguageNotice(job) {
  if (job?.source?.type !== "youtube") return null;
  const code = typeof job.sourceLanguage === "string" && LANGUAGE_CODE.test(job.sourceLanguage) ? job.sourceLanguage : null;
  if (!code || INDONESIAN.has(code)) return null;
  // Jobs from before "Bahasa video" were Indonesian.
  const setting = job.options?.videoLanguage ?? "id";
  if (setting !== "auto" && setting !== "id") return null;
  const name = languageName(code) || code.toUpperCase();
  return setting === "auto"
    ? { tone: "info", text: `Bahasa video terdeteksi: ${name}. Hasil caption mengikuti bahasa ini.` }
    : { tone: "warning", text: `Bahasa video terdeteksi: ${name}, tetapi Bahasa video diatur ke Indonesia. Caption bisa meleset; pilih Deteksi otomatis di Buat klip.` };
}
