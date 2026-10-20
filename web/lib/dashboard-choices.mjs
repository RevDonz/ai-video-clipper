// The job options on the dashboard (app/dashboard/page.jsx): what is offered, the defaults, the
// one-line summary shown while the options are folded, and the last choices kept per browser.
// Client-safe and DOM-free: the storage is passed in, and every access is guarded, so blocked
// storage only means today's defaults. The video link, the file, the time ranges and the focus
// are never stored.

export const CHOICES_KEY = "potongin-dashboard-choices";

export const LAYOUT_CHOICES = Object.freeze([
  { id: "fit-blur", name: "Utuh + latar blur", description: "Video landscape tetap utuh, sisa layar diisi versi blur." },
  { id: "face-track", name: "Ikuti pembicara", description: "Layar penuh, crop mengikuti wajah terbesar." },
  { id: "center-crop", name: "Crop tengah", description: "Untuk video yang subjeknya selalu di tengah." },
]);

export const CAPTION_STYLE_CHOICES = Object.freeze([
  { id: "karaoke", name: "Karaoke", description: "Kata yang sedang diucapkan menyala." },
  { id: "classic", name: "Klasik", description: "Beberapa kata per baris, tanpa sorotan." },
]);

// Ranges in seconds, inside the job API's 5 to 180 (lib/jobs.mjs). Otomatis is the range the
// form always had; "custom" opens the two number fields.
export const DURATION_PRESETS = Object.freeze([
  { id: "auto", name: "Otomatis", min: 20, max: 60 },
  { id: "short", name: "Pendek", min: 15, max: 30 },
  { id: "medium", name: "Sedang", min: 30, max: 60 },
  { id: "long", name: "Panjang", min: 60, max: 90 },
  { id: "custom", name: "Atur sendiri" },
]);

// The ids are VIDEO_LANGUAGES in lib/jobs.mjs (kept equal by a test; that module is server-only).
export const VIDEO_LANGUAGE_CHOICES = Object.freeze([
  { id: "id", name: "Indonesia", summary: "Bahasa Indonesia" },
  { id: "en", name: "Inggris", summary: "Bahasa Inggris" },
  { id: "auto", name: "Deteksi otomatis", summary: "Deteksi bahasa" },
]);

export const DEFAULT_CHOICES = Object.freeze({
  limit: "3",
  duration: "auto",
  minDuration: "20",
  maxDuration: "60",
  renderMode: "fit-blur",
  captionStyle: "karaoke",
  coldOpen: true,
  hookOverlay: true,
  videoLanguage: "id",
  optionsOpen: false,
});

const byId = (list, id) => list.find((entry) => entry.id === id) || null;
const presetOf = (id) => byId(DURATION_PRESETS, id);

/** The field text of a number in [minimum, maximum], or null. */
function numberText(value, minimum, maximum, integer = false) {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const number = Number(text);
  return (!integer || Number.isInteger(number)) && number >= minimum && number <= maximum ? text : null;
}

/** The custom range as field texts, or null when it is not one the job API accepts. */
function customRange(minimum, maximum) {
  const min = numberText(minimum, 5, 180);
  const max = numberText(maximum, 5, 180);
  return min !== null && max !== null && Number(min) <= Number(max) ? { min, max } : null;
}

/** `choices` with the duration preset `id`; a preset brings its range, "custom" keeps the one in use. */
export function withDuration(choices, id) {
  const preset = presetOf(id);
  if (!preset) return choices;
  if (id === "custom") return { ...choices, duration: id };
  return { ...choices, duration: id, minDuration: String(preset.min), maxDuration: String(preset.max) };
}

/** A complete set of choices from anything (stored JSON included); each unusable field is the default. */
export function normalizeChoices(raw) {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const pick = (list, id, fallback) => (byId(list, id) ? id : fallback);
  const flag = (name) => (typeof value[name] === "boolean" ? value[name] : DEFAULT_CHOICES[name]);
  const choices = {
    ...DEFAULT_CHOICES,
    limit: numberText(value.limit, 1, 10, true) ?? DEFAULT_CHOICES.limit,
    renderMode: pick(LAYOUT_CHOICES, value.renderMode, DEFAULT_CHOICES.renderMode),
    captionStyle: pick(CAPTION_STYLE_CHOICES, value.captionStyle, DEFAULT_CHOICES.captionStyle),
    coldOpen: flag("coldOpen"),
    hookOverlay: flag("hookOverlay"),
    videoLanguage: pick(VIDEO_LANGUAGE_CHOICES, value.videoLanguage, DEFAULT_CHOICES.videoLanguage),
    optionsOpen: flag("optionsOpen"),
  };
  if (value.duration === "custom") {
    const range = customRange(value.minDuration, value.maxDuration);
    if (range) return { ...choices, duration: "custom", minDuration: range.min, maxDuration: range.max };
  }
  return withDuration(choices, presetOf(value.duration) && value.duration !== "custom" ? value.duration : DEFAULT_CHOICES.duration);
}

/** "3 klip · Otomatis 20–60 detik · Utuh + latar blur · Karaoke · Bahasa Indonesia"; values being typed are left out. */
export function choicesSummary(choices, { focusTerms = 0, ranges = 0 } = {}) {
  const parts = [];
  const limit = numberText(choices.limit, 1, 10, true);
  if (limit !== null) parts.push(`${limit} klip`);
  const preset = presetOf(choices.duration);
  if (preset && choices.duration !== "custom") parts.push(`${preset.name} ${preset.min}–${preset.max} detik`);
  else {
    const range = customRange(choices.minDuration, choices.maxDuration);
    if (range) parts.push(`${range.min}–${range.max} detik`);
  }
  for (const [list, id] of [[LAYOUT_CHOICES, choices.renderMode], [CAPTION_STYLE_CHOICES, choices.captionStyle]]) {
    const entry = byId(list, id);
    if (entry) parts.push(entry.name);
  }
  const language = byId(VIDEO_LANGUAGE_CHOICES, choices.videoLanguage);
  if (language) parts.push(language.summary);
  if (choices.coldOpen === false) parts.push("tanpa kalimat pembuka");
  if (choices.hookOverlay === false) parts.push("tanpa teks hook");
  if (ranges > 0) parts.push(`${ranges} rentang waktu`);
  if (focusTerms > 0) parts.push(`fokus ${focusTerms} kata kunci`);
  return parts.join(" · ");
}

/** The stored choices, or the defaults when nothing usable is stored or reading throws. */
export function readStoredChoices(storage) {
  try {
    const raw = storage?.getItem(CHOICES_KEY) ?? null;
    return normalizeChoices(raw === null ? null : JSON.parse(raw));
  } catch {
    return normalizeChoices(null);
  }
}

/** Stores the choices (only the fields in DEFAULT_CHOICES); false when the storage refuses. Never throws. */
export function writeStoredChoices(storage, choices) {
  if (!storage) return false;
  const normalized = normalizeChoices(choices);
  const record = Object.fromEntries(Object.keys(DEFAULT_CHOICES).map((name) => [name, normalized[name]]));
  try {
    storage.setItem(CHOICES_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/** window.localStorage, or null where reading it throws (blocked site data, some private windows). */
export function browserStorage() {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
