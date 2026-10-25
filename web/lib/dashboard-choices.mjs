// The job options on the dashboard (app/dashboard/page.jsx): what is offered, the defaults, the
// three folds that hold the less used options with the summary each shows while closed, and the
// last choices kept per browser (which folds are open included).
// Client-safe and DOM-free: the storage is passed in, and every access is guarded, so blocked
// storage only means today's defaults. The video link, the file, the time ranges and the focus
// are never stored.

import { CLIP_LIMITS } from "./clip-limits.mjs";
import { renderModeName } from "./layout-names.mjs";

export const CHOICES_KEY = "potongin-dashboard-choices";

// Named as the editor names them (layout-names.mjs).
export const LAYOUT_CHOICES = Object.freeze([
  { id: "fit-blur", name: renderModeName("fit-blur"), description: "Video landscape tetap utuh, sisa layar diisi versi blur." },
  { id: "face-track", name: renderModeName("face-track"), description: "Layar penuh, potongan mengikuti wajah pembicara." },
  { id: "center-crop", name: renderModeName("center-crop"), description: "Untuk video yang subjeknya selalu di tengah." },
]);
// Otomatis (rombak 04 §A8.1): a layout per shot, first in the list, never the default (opt-in).
export const AUTO_LAYOUT_CHOICE = Object.freeze({ id: "auto", name: renderModeName("auto") });

/** The Layout choices Buat klip offers: Otomatis first only while POTONGIN_AUTO_REFRAME is on. */
export function layoutChoices({ autoReframe = false } = {}) {
  return autoReframe === true ? [AUTO_LAYOUT_CHOICE, ...LAYOUT_CHOICES] : LAYOUT_CHOICES;
}

// Every caption pack, named as the editor names it (components/editor/panels/caption-model.mjs);
// the ids are lib/jobs.mjs CAPTION_STYLES. The legacy engine (the rollback switch) draws only
// Karaoke and Klasik, at the bottom in one size (CONTRACTS §5.48).
export const CAPTION_STYLE_CHOICES = Object.freeze([
  { id: "classic", name: "Klasik", description: "Putih bergaris hitam, tanpa sorotan." },
  { id: "karaoke", name: "Karaoke", description: "Kata yang sedang diucapkan menyala." },
  { id: "bold", name: "Bold", description: "Huruf besar tebal, kata aktif berwarna." },
  { id: "box", name: "Box", description: "Teks di kotak gelap." },
  { id: "sorot", name: "Sorot", description: "Kotak warna di kata yang diucapkan." },
  { id: "sinar", name: "Sinar", description: "Karaoke dengan cahaya lembut." },
]);
const LEGACY_STYLES = Object.freeze(["karaoke", "classic"]);

// "Posisi" and "Ukuran": the seed's y_e5 (the caption block's bottom edge) and size_pm, the
// editor's Atas/Tengah/Bawah and Kecil/Sedang/Besar presets.
export const CAPTION_POSITION_CHOICES = Object.freeze([
  { id: "top", name: "Atas", y_e5: 38000 },
  { id: "middle", name: "Tengah", y_e5: 60000 },
  { id: "bottom", name: "Bawah", y_e5: 83000 },
]);
export const CAPTION_SIZE_CHOICES = Object.freeze([
  { id: "small", name: "Kecil", size_pm: 850 },
  { id: "medium", name: "Sedang", size_pm: 1000 },
  { id: "large", name: "Besar", size_pm: 1200 },
]);

/**
 * The caption looks the automatic render of `engine` draws: every pack, spot and size with the
 * editor's engine (the release default, also before the jobs list answers); with "legacy" only
 * Karaoke and Klasik and no spot or size (null: the dashboard leaves those controls out).
 */
export function lookChoices(engine) {
  if (engine === "legacy") {
    return { styles: LEGACY_STYLES.map((id) => byId(CAPTION_STYLE_CHOICES, id)), positions: null, sizes: null };
  }
  return { styles: CAPTION_STYLE_CHOICES, positions: CAPTION_POSITION_CHOICES, sizes: CAPTION_SIZE_CHOICES };
}

// "Rasio" and "Resolusi" (CONTRACTS §5.54): together the job option `outputSize` (lib/jobs.mjs
// OUTPUT_SIZE_IDS, lib/output-frame.mjs OUTPUT_SIZES).
export const RATIO_CHOICES = Object.freeze([
  { id: "9:16", name: "9:16", tall: true },
  { id: "1:1", name: "1:1", tall: false },
]);
export const RESOLUTION_CHOICES = Object.freeze([
  { id: "720p", name: "720p", width: 720 },
  { id: "1080p", name: "1080p", width: 1080 },
]);

/** The job option `outputSize` ("720x1280", "1080x1080", …) of the Rasio and Resolusi choices. */
export function outputSizeOf(choices) {
  const ratio = byId(RATIO_CHOICES, choices?.ratio) ?? RATIO_CHOICES[0];
  const { width } = byId(RESOLUTION_CHOICES, choices?.resolution) ?? RESOLUTION_CHOICES[0];
  return `${width}x${ratio.tall ? (width * 16) / 9 : width}`;
}

// Ranges in seconds, inside the job API's CLIP_LIMITS.seconds (5 to 180). Otomatis is the range the
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
  captionPosition: "bottom",
  captionSize: "medium",
  ratio: "9:16",
  resolution: "720p",
  coldOpen: true,
  hookOverlay: true,
  videoLanguage: "id",
  openSections: Object.freeze([]),
});

// The folds under the essentials (jumlah, durasi, rasio, layout), in display order.
export const OPTION_SECTIONS = Object.freeze([
  Object.freeze({ id: "look", title: "Subtitle dan hook" }),
  Object.freeze({ id: "moments", title: "Arahkan pilihan momen" }),
  Object.freeze({ id: "format", title: "Bahasa dan resolusi" }),
]);
const SECTION_IDS = OPTION_SECTIONS.map((section) => section.id);

// The checked fields that sit inside a fold; the others are always on screen.
const FIELD_SECTIONS = Object.freeze({ timeRanges: "moments", focus: "moments" });

/** The fold holding a checked field ("timeRanges", "focus"), or null when the field is always shown. */
export function sectionOfField(name) {
  return Object.hasOwn(FIELD_SECTIONS, name) ? FIELD_SECTIONS[name] : null;
}

function openSectionsOf(value) {
  // The single fold this page had before kept everything; a browser that left it open sees all three.
  if (!Array.isArray(value.openSections)) return value.optionsOpen === true ? [...SECTION_IDS] : [];
  return SECTION_IDS.filter((id) => value.openSections.includes(id));
}

/** `choices` with fold `id` open or closed (display order kept); unknown folds change nothing. */
export function withSection(choices, id, open) {
  if (!SECTION_IDS.includes(id)) return choices;
  const current = Array.isArray(choices.openSections) ? choices.openSections : [];
  if (current.includes(id) === Boolean(open)) return choices;
  return { ...choices, openSections: SECTION_IDS.filter((entry) => (entry === id ? open : current.includes(entry))) };
}

/**
 * The line a closed fold shows: "Karaoke · Bawah, Sedang · Kalimat terkuat dulu · Teks hook",
 * "2 kata kunci · 1 rentang waktu" (or "Otomatis"), "Bahasa Indonesia · 720p".
 */
export function sectionSummary(id, choices, { engine, focusTerms = 0, ranges = 0, note = false } = {}) {
  if (id === "look") {
    const look = lookChoices(engine);
    const parts = [byId(look.styles, choices.captionStyle)?.name ?? byId(look.styles, DEFAULT_CHOICES.captionStyle).name];
    if (look.positions && look.sizes) {
      const spot = byId(look.positions, choices.captionPosition) ?? byId(look.positions, DEFAULT_CHOICES.captionPosition);
      const size = byId(look.sizes, choices.captionSize) ?? byId(look.sizes, DEFAULT_CHOICES.captionSize);
      parts.push(`${spot.name}, ${size.name}`);
    }
    parts.push(choices.coldOpen === false ? "Tanpa kalimat pembuka" : "Kalimat terkuat dulu");
    parts.push(choices.hookOverlay === false ? "Tanpa teks hook" : "Teks hook");
    return parts.join(" · ");
  }
  if (id === "moments") {
    const parts = [];
    if (focusTerms > 0) parts.push(`${focusTerms} kata kunci`);
    if (ranges > 0) parts.push(`${ranges} rentang waktu`);
    if (note) parts.push("ada catatan");
    return parts.length ? parts.join(" · ") : "Otomatis";
  }
  if (id === "format") {
    const language = byId(VIDEO_LANGUAGE_CHOICES, choices.videoLanguage) ?? byId(VIDEO_LANGUAGE_CHOICES, DEFAULT_CHOICES.videoLanguage);
    const resolution = byId(RESOLUTION_CHOICES, choices.resolution) ?? byId(RESOLUTION_CHOICES, DEFAULT_CHOICES.resolution);
    return `${language.summary} · ${resolution.name}`;
  }
  return "";
}

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
  const min = numberText(minimum, CLIP_LIMITS.seconds.min, CLIP_LIMITS.seconds.max);
  const max = numberText(maximum, CLIP_LIMITS.seconds.min, CLIP_LIMITS.seconds.max);
  return min !== null && max !== null && Number(min) <= Number(max) ? { min, max } : null;
}

/** `choices` with the duration preset `id`; a preset brings its range, "custom" keeps the one in use. */
export function withDuration(choices, id) {
  const preset = presetOf(id);
  if (!preset) return choices;
  if (id === "custom") return { ...choices, duration: id };
  return { ...choices, duration: id, minDuration: String(preset.min), maxDuration: String(preset.max) };
}

/**
 * A complete set of choices from anything (stored JSON included); each unusable field is the
 * default. `engine`: a caption look that engine does not draw is the default too.
 */
export function normalizeChoices(raw, { engine, autoReframe = false } = {}) {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const pick = (list, id, fallback) => (byId(list, id) ? id : fallback);
  const flag = (name) => (typeof value[name] === "boolean" ? value[name] : DEFAULT_CHOICES[name]);
  const look = lookChoices(engine);
  const choices = {
    ...DEFAULT_CHOICES,
    limit: numberText(value.limit, CLIP_LIMITS.count.min, CLIP_LIMITS.count.max, true) ?? DEFAULT_CHOICES.limit,
    renderMode: pick(layoutChoices({ autoReframe }), value.renderMode, DEFAULT_CHOICES.renderMode),
    captionStyle: pick(look.styles, value.captionStyle, DEFAULT_CHOICES.captionStyle),
    captionPosition: pick(look.positions ?? [], value.captionPosition, DEFAULT_CHOICES.captionPosition),
    captionSize: pick(look.sizes ?? [], value.captionSize, DEFAULT_CHOICES.captionSize),
    ratio: pick(RATIO_CHOICES, value.ratio, DEFAULT_CHOICES.ratio),
    resolution: pick(RESOLUTION_CHOICES, value.resolution, DEFAULT_CHOICES.resolution),
    coldOpen: flag("coldOpen"),
    hookOverlay: flag("hookOverlay"),
    videoLanguage: pick(VIDEO_LANGUAGE_CHOICES, value.videoLanguage, DEFAULT_CHOICES.videoLanguage),
    openSections: openSectionsOf(value),
  };
  if (value.duration === "custom") {
    const range = customRange(value.minDuration, value.maxDuration);
    if (range) return { ...choices, duration: "custom", minDuration: range.min, maxDuration: range.max };
  }
  return withDuration(choices, presetOf(value.duration) && value.duration !== "custom" ? value.duration : DEFAULT_CHOICES.duration);
}

/**
 * "3 klip · Otomatis 20–60 detik · Latar blur · Karaoke · Bahasa Indonesia": every choice the
 * next job uses, read with Buat klip (which comes before the options). Values being typed are
 * left out, and so are 9:16 and 720p (what every clip had before they could be chosen).
 */
export function choicesSummary(choices, { focusTerms = 0, ranges = 0 } = {}) {
  const parts = [];
  const limit = numberText(choices.limit, CLIP_LIMITS.count.min, CLIP_LIMITS.count.max, true);
  if (limit !== null) parts.push(`${limit} klip`);
  const preset = presetOf(choices.duration);
  if (preset && choices.duration !== "custom") parts.push(`${preset.name} ${preset.min}–${preset.max} detik`);
  else {
    const range = customRange(choices.minDuration, choices.maxDuration);
    if (range) parts.push(`${range.min}–${range.max} detik`);
  }
  for (const [list, id, fallback] of [[RATIO_CHOICES, choices.ratio, "9:16"], [RESOLUTION_CHOICES, choices.resolution, "720p"]]) {
    const entry = byId(list, id);
    if (entry && id !== fallback) parts.push(entry.name);
  }
  for (const [list, id] of [[layoutChoices({ autoReframe: true }), choices.renderMode], [CAPTION_STYLE_CHOICES, choices.captionStyle]]) {
    const entry = byId(list, id);
    if (entry) parts.push(entry.name);
  }
  // The pack's own spot and size (Bawah, Sedang) go unsaid.
  for (const [list, id, fallback] of [[CAPTION_POSITION_CHOICES, choices.captionPosition, "bottom"], [CAPTION_SIZE_CHOICES, choices.captionSize, "medium"]]) {
    const entry = byId(list, id);
    if (entry && id !== fallback) parts.push(`subtitle ${entry.name.toLowerCase()}`);
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
export function readStoredChoices(storage, options = {}) {
  try {
    const raw = storage?.getItem(CHOICES_KEY) ?? null;
    return normalizeChoices(raw === null ? null : JSON.parse(raw), options);
  } catch {
    return normalizeChoices(null, options);
  }
}

/** Stores the choices (only the fields in DEFAULT_CHOICES); false when the storage refuses. Never throws. */
export function writeStoredChoices(storage, choices, options = {}) {
  if (!storage) return false;
  const normalized = normalizeChoices(choices, options);
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
