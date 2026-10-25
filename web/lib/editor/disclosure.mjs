// The "Lanjutan" fold of a panel group (rombak 06 §2.1 T2, §2.2 rules 3 and 4): the summary in
// its title and whether it is open. Pure and DOM-free; the storage is passed in.
//
// advancedSummary(group, doc, seed) returns data, never text: `{ items: [{ key, values }] }`, at
// most MAX_SUMMARY_ITEMS, in a fixed order per group, for the fine values that differ from the
// AI version (`seed`). Where the AI version has no such item (no music, no logo, no watermark),
// a new item's defaults stand in, so a value nobody touched never shows. The component names
// each item with `editor.<tab>.summary.<key>` and joins them (07-i18n.md §7.3); no items means
// `editor.advanced.default` ("Bawaan").
import { DEFAULT_WATERMARK, defaultSplit, hookItem, logoItem, musicItem, watermarkOf, zoomOf } from "./doc-model.mjs";

export const ADVANCED_GROUPS = Object.freeze(["caption", "hook", "camera", "split", "music", "logo", "watermark"]);
export const MAX_SUMMARY_ITEMS = 3;
/** localStorage key of the open folds, `{ <group>: true|false }` (06 §2.2 rule 4). */
export const DISCLOSURE_KEY = "potongin-editor-disclosure";

const SAMPLE_RATE = 48000;
// A new music track's payload (commands.mjs SetMusic) and a new logo's size and opacity
// (DEFAULT_LOGO; a logo too tall for the frame starts smaller, and then shows its size).
const MUSIC_DEFAULTS = Object.freeze({ src_in_smp: 0, loop: true, fade_in_f: 15, fade_out_f: 30 });
const DUCK_DEFAULTS = Object.freeze({ attack_ms: 30, release_ms: 400, hold_ms: 250 });
const LOGO_DEFAULTS = Object.freeze({ w_e5: 16000, opacity_pm: 850 });

const percent = (perMille, scale = 10) => Math.round(perMille / scale);
const tenths = (value) => Math.round(value * 10) / 10;

function seconds(frames, fps) {
  const [num, den] = Array.isArray(fps) && fps[0] > 0 && fps[1] > 0 ? fps : [30, 1];
  return tenths((frames * den) / num);
}

function overrides(doc) {
  return doc?.captions?.overrides ?? {};
}

// Each group: [key, read(doc) → comparable value, values(value, doc) → item values].
const GROUPS = Object.freeze({
  caption: [
    ["entrance", (doc) => overrides(doc).entrance ?? "none", (entrance) => ({ entrance })],
    ["wordsMax", (doc) => overrides(doc).words_max ?? null, (count) => ({ count })],
    ["size", (doc) => overrides(doc).size_pm ?? null, (pm) => ({ percent: percent(pm) })],
    ["position", (doc) => overrides(doc).y_e5 ?? null, (e5) => ({ percent: percent(e5, 1000) })],
    ["case", (doc) => overrides(doc).case ?? null, (value) => ({ case: value })],
    ["emphasis", (doc) => overrides(doc).emphasis ?? null, (color) => ({ color })],
  ],
  hook: [
    ["design", (doc) => hookItem(doc)?.payload?.design?.id ?? null, (design) => ({ design })],
    ["duration", (doc) => hookItem(doc)?.dur_f ?? null, (frames, doc) => ({ seconds: seconds(frames, doc.output?.fps) })],
    ["position", (doc) => hookItem(doc)?.transform?.y_e5 ?? null, (e5) => ({ percent: percent(e5, 1000) })],
  ],
  camera: [
    ["keyframes", (doc) => doc.layout?.keyframes?.length ?? 0, (count) => ({ count })],
    ["zoom", (doc) => zoomOf(doc), (pm) => ({ percent: percent(pm) })],
  ],
  split: [
    ["zoom", (doc) => {
      const split = doc.layout?.split ?? defaultSplit();
      return `${split.top?.zoom_pm ?? 1000}/${split.bottom?.zoom_pm ?? 1000}`;
    }, (value) => {
      const [top, bottom] = value.split("/").map(Number);
      return { top: percent(top), bottom: percent(bottom) };
    }],
  ],
  music: [
    ["loop", (doc) => musicPayload(doc)?.loop ?? MUSIC_DEFAULTS.loop, (on) => ({ on })],
    ["fade", (doc) => {
      const payload = musicPayload(doc);
      return `${payload?.fade_in_f ?? MUSIC_DEFAULTS.fade_in_f}/${payload?.fade_out_f ?? MUSIC_DEFAULTS.fade_out_f}`;
    }, (value, doc) => {
      const [fadeIn, fadeOut] = value.split("/").map(Number);
      return { inSeconds: seconds(fadeIn, doc.output?.fps), outSeconds: seconds(fadeOut, doc.output?.fps) };
    }],
    ["offset", (doc) => musicPayload(doc)?.src_in_smp ?? MUSIC_DEFAULTS.src_in_smp, (smp) => ({ seconds: tenths(smp / SAMPLE_RATE) })],
    // The strength preset sets the depth (a basic control); attack, release and hold are the fold's.
    ["duck", (doc) => JSON.stringify(duckDetails(doc)), (value, doc, seed) => ({
      count: Object.keys(DUCK_DEFAULTS).filter((key) => duckDetails(doc)[key] !== duckDetails(seed)[key]).length,
    })],
  ],
  logo: [
    ["size", (doc) => logoItem(doc)?.transform?.w_e5 ?? LOGO_DEFAULTS.w_e5, (e5) => ({ percent: percent(e5, 1000) })],
    ["opacity", (doc) => logoItem(doc)?.transform?.opacity_pm ?? LOGO_DEFAULTS.opacity_pm, (pm) => ({ percent: percent(pm) })],
  ],
  watermark: [
    ["position", (doc) => watermarkOf(doc)?.pos ?? DEFAULT_WATERMARK.pos, (pos) => ({ pos })],
    ["size", (doc) => watermarkOf(doc)?.size_pm ?? DEFAULT_WATERMARK.size_pm, (pm) => ({ percent: percent(pm) })],
    ["opacity", (doc) => watermarkOf(doc)?.opacity_pm ?? DEFAULT_WATERMARK.opacity_pm, (pm) => ({ percent: percent(pm) })],
  ],
});

function musicPayload(doc) {
  return musicItem(doc)?.payload ?? null;
}

function duckDetails(doc) {
  const duck = musicPayload(doc)?.duck ?? {};
  return Object.fromEntries(Object.keys(DUCK_DEFAULTS).map((key) => [key, duck[key] ?? DUCK_DEFAULTS[key]]));
}

// The groups whose fold is about one item: no item in the document, nothing to sum up.
const NEEDS = Object.freeze({
  hook: (doc) => Boolean(hookItem(doc)),
  music: (doc) => Boolean(musicItem(doc)),
  logo: (doc) => Boolean(logoItem(doc)),
  watermark: (doc) => Boolean(watermarkOf(doc)),
});

// The AI version as each group compares against: for music, the logo and the watermark, the
// seed's own item when it has one, else the defaults a new item gets.
function reference(group, seed) {
  if (!seed || typeof seed !== "object") return null;
  if (NEEDS[group] && !NEEDS[group](seed)) return { ...seed, tracks: [], watermark: undefined };
  return seed;
}

function safeRead(read, doc) {
  try {
    return read(doc);
  } catch {
    return undefined;
  }
}

/** `{ items: [{ key, values }] }` of the fine values in `group` that differ from the AI version. */
export function advancedSummary(group, doc, seed) {
  const rows = Object.hasOwn(GROUPS, group) ? GROUPS[group] : null;
  if (!rows || !doc || typeof doc !== "object") return { items: [] };
  if (NEEDS[group] && !safeRead(NEEDS[group], doc)) return { items: [] };
  const base = reference(group, seed);
  const items = [];
  for (const [key, read, values] of rows) {
    if (items.length >= MAX_SUMMARY_ITEMS) break;
    const now = safeRead(read, doc);
    const before = base ? safeRead(read, base) : undefined;
    if (now === undefined || now === null || now === before) continue;
    items.push({ key, values: values(now, doc, base ?? {}) });
  }
  return { items };
}

function readAll(storage) {
  const raw = storage?.getItem(DISCLOSURE_KEY) ?? null;
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Whether the fold of `group` is open: only a stored true opens it; any failure means closed. */
export function readDisclosure(storage, group) {
  try {
    return readAll(storage)[group] === true;
  } catch {
    return false;
  }
}

/** Stores the fold's state; false when the group is unknown or the storage refuses. Never throws. */
export function writeDisclosure(storage, group, open) {
  if (!ADVANCED_GROUPS.includes(group) || !storage) return false;
  try {
    const all = readAll(storage);
    all[group] = open === true;
    storage.setItem(DISCLOSURE_KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}
