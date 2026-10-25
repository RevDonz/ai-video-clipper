// Text operations in the language of the content (captions, titles, hashtags, search over
// them), never the UI language (rombak 07 §11). The content language is the job's video
// language; old jobs and "auto" that was never resolved count as Indonesian.
const CONTENT_LANGUAGES = new Set(["id", "en"]);
const DEFAULT_CONTENT = "id";

export function contentLang(job) {
  const language = job?.options?.videoLanguage;
  return CONTENT_LANGUAGES.has(language) ? language : DEFAULT_CONTENT;
}

const checked = (lang) => (CONTENT_LANGUAGES.has(lang) ? lang : DEFAULT_CONTENT);

export function contentLower(text, lang = DEFAULT_CONTENT) {
  return String(text).toLocaleLowerCase(checked(lang));
}

export function contentUpper(text, lang = DEFAULT_CONTENT) {
  return String(text).toLocaleUpperCase(checked(lang));
}

const collators = new Map();

/** Sorts titles and names the way the content's language does, ignoring case and accents. */
export function contentCompare(a, b, lang = DEFAULT_CONTENT) {
  const key = checked(lang);
  if (!collators.has(key)) collators.set(key, new Intl.Collator(key, { sensitivity: "base" }));
  return collators.get(key).compare(a, b);
}
