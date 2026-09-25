// Konteks Tren: what is trending (topics, people, jokes, memes, sounds, hashtags) as reported
// by the owner's own agent (Hermes) through /api/ingest/trends, or typed on the Konteks Tren
// page. Potongin never scrapes anything itself.
//
// One versioned JSON document, <settingsDir>/trend-context.json, holds every item: the active
// ones and up to seven days of expired history, at most 1000 in total. settingsDir is the
// directory of llm-settings.json (POTONGIN_SETTINGS_DIR, never inside JOBS_ROOT). Files are
// 0600 and written atomically (temporary file + fsync + rename) while holding a lock: an
// in-process queue plus a lock directory beside the file, so no two writers interleave a
// read-modify-write. A file that no longer parses is reported on read and set aside (renamed,
// never deleted) by the next write.
//
// Item text comes from the internet and is untrusted data, never an instruction: it is
// normalised (NFC; no control, bidi or zero-width characters; one line except the summary),
// length-capped, and never interpreted. V3 jobs get a snapshot of the enabled active items
// (analysis/trend-context.json) without examples, source labels or timestamps.
//
// Server-only (node:fs): client components must not import this module.

import crypto from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";

import { resolveSettingsPaths } from "./llm-settings.mjs";

export const TREND_CONTEXT_VERSION = 1;
export const TREND_CONTEXT_FILE = "trend-context.json";
export const TREND_SNAPSHOT_RELATIVE_PATH = path.join("analysis", "trend-context.json");
export const TREND_KINDS = Object.freeze(["topic", "person", "joke", "meme", "sound", "hashtag", "format", "event"]);
export const TREND_PLATFORMS = Object.freeze(["tiktok", "instagram", "youtube", "x", "facebook", "news", "other"]);
export const TREND_SENSITIVITIES = Object.freeze(["normal", "sensitive"]);
export const MANUAL_SOURCE = "manual";
export const TREND_LIMITS = Object.freeze({
  maxItems: 1000,
  maxBatchItems: 100,
  maxIngestBytes: 256 * 1024,
  maxDashboardBodyBytes: 32 * 1024,
  historyDays: 7,
  defaultTtlDays: 10,
  maxTtlDays: 60,
  snapshotItems: 300,
  title: 80,
  summary: 500,
  summaryLines: 5,
  keywords: 12,
  keywordMin: 2,
  keywordMax: 40,
  hashtags: 10,
  hashtagBody: 50,
  examples: 5,
  exampleUrl: 500,
  exampleNote: 120,
  externalId: 120,
  sourceLabel: 40,
});
export const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9._:/#@-]{1,120}$/;

const DAY_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 60 * 1000;
const MAX_STORE_BYTES = 16 * 1024 * 1024;
const DEFAULT_SCORE = 50;
const DEFAULT_REGION = "ID";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASHTAG = /^#[\p{L}\p{N}_]{1,50}$/u;
const REGION = /^[A-Za-z]{2}$/;
const STORED_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const INPUT_INSTANT = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2}))?$/;
// Controls (Cc), format characters (Cf: bidi overrides and isolates, zero-width characters,
// BOM, soft hyphen, tag characters) and every other default-ignorable code point (variation
// selectors, Hangul fillers, the combining grapheme joiner): text nobody sees on /trends must
// not reach the LLM either. Line breaks are turned into spaces or \n before this runs. The
// engine (src/ai_clipper/trend_context.py) strips at least the same set.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const LINE_BREAK = /\r\n|[\r\n\v\f\u0085\u2028\u2029]/g;

const INPUT_FIELDS = new Set([
  "externalId", "kind", "title", "summary", "keywords", "hashtags", "platforms", "region", "examples",
  "score", "sensitivity", "firstSeenAt", "expiresAt",
]);
// Server-owned fields an agent may echo back from a GET; they are ignored, never trusted.
const IGNORED_INPUT_FIELDS = new Set(["id", "source", "createdAt", "updatedAt", "enabled"]);
const PATCH_FIELDS = ["title", "summary", "keywords", "hashtags", "sensitivity", "expiresAt", "enabled"];
const ITEM_KEYS = [
  "id", "externalId", "kind", "title", "summary", "keywords", "hashtags", "platforms", "region", "examples",
  "score", "sensitivity", "firstSeenAt", "expiresAt", "source", "enabled", "createdAt", "updatedAt",
];
const DOCUMENT_KEYS = ["version", "enabled", "updatedAt", "lastIngestAt", "items"];

// --- Errors ---------------------------------------------------------------------------------

const STATUS = Object.freeze({
  invalid_json: 400,
  invalid_body: 400,
  invalid_item: 422,
  invalid_label: 422,
  not_found: 404,
  duplicate: 409,
  label_taken: 409,
  token_limit: 409,
  store_full: 409,
  body_too_large: 413,
  too_many_items: 413,
  unsupported_media_type: 415,
  storage_unavailable: 503,
});

/** An expected failure with a fixed code, an Indonesian message and no secret or path in it. */
export class TrendContextError extends Error {
  constructor(code, message, { issues = [], detail = null } = {}) {
    super(message);
    this.name = "TrendContextError";
    this.code = code;
    this.status = STATUS[code] || 500;
    this.issues = issues;
    this.detail = detail;
  }
}

const STORAGE_MESSAGES = Object.freeze({
  config: "Folder pengaturan di server belum benar (POTONGIN_SETTINGS_DIR harus path absolut di luar JOBS_ROOT).",
  unreadable: "Penyimpanan pengaturan tidak bisa dibaca atau ditulis. Periksa izin folder pengaturan di server.",
  corrupt: "File pengaturan rusak. Perubahan berikutnya memulai file baru; file lama disimpan sebagai cadangan.",
  locked: "Penyimpanan pengaturan sedang dipakai proses lain. Coba lagi sebentar.",
});

function storageError(detail) {
  return new TrendContextError("storage_unavailable", STORAGE_MESSAGES[detail], { detail });
}

// Per-item rejections travel as values; this is only the internal carrier.
class Rejection {
  constructor(code, field) {
    this.code = code;
    this.field = field;
  }
}

function reject(code, field) {
  throw new Rejection(code, field);
}

// --- Text -----------------------------------------------------------------------------------

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function wellFormed(value) {
  return typeof value.toWellFormed === "function" ? value.toWellFormed() : value;
}

function codePoints(value, stopAfter = Infinity) {
  let count = 0;
  for (const _ of value) {
    count += 1;
    if (count > stopAfter) break;
  }
  return count;
}

/** One line of item text (NFC, invisible characters and line breaks removed), or null for a non-string. */
export function normalizeTrendLine(value) {
  if (typeof value !== "string") return null;
  return wellFormed(value)
    .replace(LINE_BREAK, " ")
    .replace(/\t/g, " ")
    .replace(INVISIBLE, "")
    .replace(/\s+/gu, " ")
    .trim()
    .normalize("NFC");
}

/** A summary: lines normalised like normalizeTrendLine, blank lines dropped, at most five lines. */
export function normalizeTrendSummary(value) {
  if (typeof value !== "string") return null;
  const lines = wellFormed(value)
    .replace(LINE_BREAK, "\n")
    .split("\n")
    .map((line) => line.replace(/\t/g, " ").replace(INVISIBLE, "").replace(/\s+/gu, " ").trim())
    .filter(Boolean);
  const maximum = TREND_LIMITS.summaryLines;
  const kept = lines.length > maximum ? [...lines.slice(0, maximum - 1), lines.slice(maximum - 1).join(" ")] : lines;
  return kept.join("\n").normalize("NFC");
}

/** Case-, accent- and spacing-insensitive form of a title or label. */
export function foldTrendText(value) {
  return (normalizeTrendLine(value) ?? "")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim()
    .normalize("NFC");
}

/** Two items without externalId are the same item when this key is equal. */
export function trendMatchKey(kind, title) {
  return `${kind}\u0000${foldTrendText(title)}`;
}

// --- Field parsers (throw Rejection) --------------------------------------------------------

function parseEnum(raw, field, values) {
  if (typeof raw !== "string") reject("invalid_type", field);
  const value = raw.trim().toLowerCase();
  if (!values.includes(value)) reject("invalid_value", field);
  return value;
}

function parseLine(raw, field, minimum, maximum) {
  if (typeof raw !== "string") reject("invalid_type", field);
  const value = normalizeTrendLine(raw);
  const length = codePoints(value, maximum);
  if (length < minimum || length > maximum) reject("invalid_length", field);
  return value;
}

function parseSummary(raw) {
  if (typeof raw !== "string") reject("invalid_type", "summary");
  const value = normalizeTrendSummary(raw);
  if (codePoints(value, TREND_LIMITS.summary) > TREND_LIMITS.summary) reject("invalid_length", "summary");
  return value;
}

function parseList(raw, field, minimum, maximum) {
  if (!Array.isArray(raw)) reject("invalid_type", field);
  if (raw.length < minimum || raw.length > maximum) reject("invalid_length", field);
  return raw;
}

function parseKeywords(raw) {
  const seen = new Set();
  const keywords = [];
  parseList(raw, "keywords", 1, TREND_LIMITS.keywords).forEach((entry, index) => {
    const keyword = parseLine(entry, `keywords[${index}]`, TREND_LIMITS.keywordMin, TREND_LIMITS.keywordMax);
    const key = foldTrendText(keyword);
    if (seen.has(key)) return;
    seen.add(key);
    keywords.push(keyword);
  });
  return keywords;
}

function parseHashtags(raw) {
  const seen = new Set();
  const hashtags = [];
  parseList(raw, "hashtags", 0, TREND_LIMITS.hashtags).forEach((entry, index) => {
    const field = `hashtags[${index}]`;
    if (typeof entry !== "string") reject("invalid_type", field);
    const tag = normalizeTrendLine(entry);
    if (!HASHTAG.test(tag)) reject("invalid_value", field);
    const key = tag.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    hashtags.push(tag);
  });
  return hashtags;
}

function parsePlatforms(raw) {
  const platforms = [];
  parseList(raw, "platforms", 0, TREND_PLATFORMS.length).forEach((entry, index) => {
    const platform = parseEnum(entry, `platforms[${index}]`, TREND_PLATFORMS);
    if (!platforms.includes(platform)) platforms.push(platform);
  });
  return platforms;
}

function parseRegion(raw) {
  if (typeof raw !== "string") reject("invalid_type", "region");
  if (!REGION.test(raw)) reject("invalid_value", "region");
  return raw.toUpperCase();
}

function parseExampleUrl(raw, field) {
  if (typeof raw !== "string") reject("invalid_type", field);
  const text = raw.trim();
  if (codePoints(text, TREND_LIMITS.exampleUrl) > TREND_LIMITS.exampleUrl) reject("invalid_length", field);
  let url;
  try {
    url = new URL(text);
  } catch {
    reject("invalid_value", field);
  }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) reject("invalid_value", field);
  if (url.href.length > TREND_LIMITS.exampleUrl) reject("invalid_length", field);
  return url.href;
}

// Examples are de-duplicated by their normalised URL (the first one wins).
function parseExamples(raw) {
  const examples = [];
  parseList(raw, "examples", 0, TREND_LIMITS.examples).forEach((entry, index) => {
    const field = `examples[${index}]`;
    if (!isPlainObject(entry)) reject("invalid_type", field);
    for (const key of Object.keys(entry)) {
      if (key !== "url" && key !== "note") reject("unknown_field", `${field}.${key}`);
    }
    if (entry.url === undefined || entry.url === null) reject("missing_field", `${field}.url`);
    const url = parseExampleUrl(entry.url, `${field}.url`);
    const note = entry.note === undefined || entry.note === null ? "" : parseLine(entry.note, `${field}.note`, 0, TREND_LIMITS.exampleNote);
    if (!examples.some((example) => example.url === url)) examples.push({ url, note });
  });
  return examples;
}

function parseScore(raw) {
  if (typeof raw !== "number" || !Number.isFinite(raw)) reject("invalid_type", "score");
  if (raw < 0 || raw > 100) reject("invalid_value", "score");
  return Math.round(raw * 100) / 100;
}

function parseExternalId(raw) {
  if (typeof raw !== "string") reject("invalid_type", "externalId");
  if (raw.length < 1 || raw.length > TREND_LIMITS.externalId) reject("invalid_length", "externalId");
  if (!EXTERNAL_ID_PATTERN.test(raw)) reject("invalid_value", "externalId");
  return raw;
}

/** Milliseconds for an ISO 8601 date or UTC/offset date-time, or null. */
function parseInstant(value) {
  if (typeof value !== "string" || value.length > 40) return null;
  const match = INPUT_INSTANT.exec(value);
  if (!match) return null;
  const [, year, month, day, hour = "00", minute = "00", second = "00", fraction = "", zone = "Z"] = match;
  const probe = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (probe.getUTCFullYear() !== Number(year) || probe.getUTCMonth() !== Number(month) - 1 || probe.getUTCDate() !== Number(day)) return null;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  if (zone !== "Z" && (Number(zone.slice(1, 3)) > 14 || Number(zone.slice(4, 6)) > 59)) return null;
  const time = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}.${fraction.padEnd(3, "0").slice(0, 3)}${zone}`);
  return Number.isFinite(time) ? time : null;
}

function parseInstantField(raw, field) {
  if (typeof raw !== "string") reject("invalid_type", field);
  const time = parseInstant(raw);
  if (time === null) reject("invalid_value", field);
  return time;
}

function isStoredInstant(value) {
  return typeof value === "string" && STORED_INSTANT.test(value) && new Date(value).toISOString() === value;
}

function toInstant(date) {
  const time = new Date(date).getTime();
  if (!Number.isFinite(time)) throw new Error("Invalid clock value");
  return time;
}

// --- Items ----------------------------------------------------------------------------------

function present(raw, key) {
  return raw[key] !== undefined && raw[key] !== null;
}

function required(raw, key) {
  if (!present(raw, key)) reject("missing_field", key);
  return raw[key];
}

function parseInputItem(raw, nowMs) {
  if (!isPlainObject(raw)) reject("invalid_item", null);
  for (const key of Object.keys(raw)) {
    if (!INPUT_FIELDS.has(key) && !IGNORED_INPUT_FIELDS.has(key)) reject("unknown_field", key);
  }
  const kind = parseEnum(required(raw, "kind"), "kind", TREND_KINDS);
  const title = parseLine(required(raw, "title"), "title", 1, TREND_LIMITS.title);
  const summary = present(raw, "summary") ? parseSummary(raw.summary) : "";
  const keywords = parseKeywords(required(raw, "keywords"));
  const hashtags = present(raw, "hashtags") ? parseHashtags(raw.hashtags) : [];
  const platforms = present(raw, "platforms") ? parsePlatforms(raw.platforms) : [];
  const region = present(raw, "region") ? parseRegion(raw.region) : DEFAULT_REGION;
  const examples = present(raw, "examples") ? parseExamples(raw.examples) : [];
  const score = present(raw, "score") ? parseScore(raw.score) : DEFAULT_SCORE;
  const sensitivity = present(raw, "sensitivity") ? parseEnum(raw.sensitivity, "sensitivity", TREND_SENSITIVITIES) : "normal";
  const externalId = present(raw, "externalId") ? parseExternalId(raw.externalId) : null;
  let firstSeen = nowMs;
  if (present(raw, "firstSeenAt")) {
    firstSeen = parseInstantField(raw.firstSeenAt, "firstSeenAt");
    if (firstSeen > nowMs + CLOCK_SKEW_MS) reject("invalid_value", "firstSeenAt");
    firstSeen = Math.min(firstSeen, nowMs);
  }
  const latest = nowMs + TREND_LIMITS.maxTtlDays * DAY_MS;
  const expires = Math.min(
    present(raw, "expiresAt") ? parseInstantField(raw.expiresAt, "expiresAt") : firstSeen + TREND_LIMITS.defaultTtlDays * DAY_MS,
    latest,
  );
  if (expires <= nowMs) reject("expired", "expiresAt");
  return {
    externalId, kind, title, summary, keywords, hashtags, platforms, region, examples, score, sensitivity,
    firstSeenAt: new Date(firstSeen).toISOString(), expiresAt: new Date(expires).toISOString(),
  };
}

/**
 * One item as an agent or the dashboard sends it: { ok: true, value } with every field
 * normalised and defaulted, or { ok: false, code, field } naming the first problem. The
 * value itself never appears in a rejection.
 */
export function parseTrendInput(raw, { now = new Date() } = {}) {
  try {
    return { ok: true, value: parseInputItem(raw, toInstant(now)) };
  } catch (error) {
    if (error instanceof Rejection) return { ok: false, code: error.code, field: error.field };
    throw error;
  }
}

function sourceLabel(raw) {
  const label = normalizeTrendLine(raw);
  if (!label || label !== raw || codePoints(label, TREND_LIMITS.sourceLabel) > TREND_LIMITS.sourceLabel) return null;
  return label;
}

function canonicalItem(item) {
  return {
    id: item.id,
    externalId: item.externalId,
    kind: item.kind,
    title: item.title,
    summary: item.summary,
    keywords: [...item.keywords],
    hashtags: [...item.hashtags],
    platforms: [...item.platforms],
    region: item.region,
    examples: item.examples.map((example) => ({ url: example.url, note: example.note })),
    score: item.score,
    sensitivity: item.sensitivity,
    firstSeenAt: item.firstSeenAt,
    expiresAt: item.expiresAt,
    source: item.source,
    enabled: item.enabled,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function parseStoredItem(raw) {
  if (!isPlainObject(raw)) reject("invalid_item", null);
  const names = Object.keys(raw);
  if (names.length !== ITEM_KEYS.length || !ITEM_KEYS.every((key) => names.includes(key))) reject("invalid_item", null);
  if (typeof raw.id !== "string" || !UUID.test(raw.id)) reject("invalid_value", "id");
  if (raw.externalId !== null) parseExternalId(raw.externalId);
  const item = {
    id: raw.id,
    externalId: raw.externalId,
    kind: parseEnum(raw.kind, "kind", TREND_KINDS),
    title: parseLine(raw.title, "title", 1, TREND_LIMITS.title),
    summary: parseSummary(raw.summary),
    keywords: parseKeywords(raw.keywords),
    hashtags: parseHashtags(raw.hashtags),
    platforms: parsePlatforms(raw.platforms),
    region: parseRegion(raw.region),
    examples: parseExamples(raw.examples),
    score: parseScore(raw.score),
    sensitivity: parseEnum(raw.sensitivity, "sensitivity", TREND_SENSITIVITIES),
    firstSeenAt: raw.firstSeenAt,
    expiresAt: raw.expiresAt,
    source: raw.source,
    enabled: raw.enabled,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
  for (const key of ["firstSeenAt", "expiresAt", "createdAt", "updatedAt"]) {
    if (!isStoredInstant(item[key])) reject("invalid_value", key);
  }
  if (item.source !== MANUAL_SOURCE && sourceLabel(item.source) === null) reject("invalid_value", "source");
  if (typeof item.enabled !== "boolean") reject("invalid_type", "enabled");
  return canonicalItem(item);
}

function emptyDocument() {
  return { version: TREND_CONTEXT_VERSION, enabled: true, updatedAt: null, lastIngestAt: null, items: [] };
}

function parseStoredDocument(document) {
  if (!isPlainObject(document)) throw storageError("corrupt");
  const names = Object.keys(document);
  if (names.length !== DOCUMENT_KEYS.length || !DOCUMENT_KEYS.every((key) => names.includes(key))) throw storageError("corrupt");
  if (document.version !== TREND_CONTEXT_VERSION || typeof document.enabled !== "boolean") throw storageError("corrupt");
  if (!isStoredInstant(document.updatedAt)) throw storageError("corrupt");
  if (document.lastIngestAt !== null && !isStoredInstant(document.lastIngestAt)) throw storageError("corrupt");
  if (!Array.isArray(document.items) || document.items.length > TREND_LIMITS.maxItems) throw storageError("corrupt");
  const ids = new Set();
  const items = document.items.map((raw) => {
    let item;
    try {
      item = parseStoredItem(raw);
    } catch (error) {
      if (error instanceof Rejection) throw storageError("corrupt");
      throw error;
    }
    if (ids.has(item.id)) throw storageError("corrupt");
    ids.add(item.id);
    return item;
  });
  return { version: TREND_CONTEXT_VERSION, enabled: document.enabled, updatedAt: document.updatedAt, lastIngestAt: document.lastIngestAt, items };
}

function serializeDocument(document) {
  return {
    version: TREND_CONTEXT_VERSION,
    enabled: document.enabled,
    updatedAt: document.updatedAt,
    lastIngestAt: document.lastIngestAt,
    items: document.items.map(canonicalItem),
  };
}

function isExpired(item, nowMs) {
  return Date.parse(item.expiresAt) <= nowMs;
}

// Items expired more than historyDays ago are gone for good.
function pruneHistory(document, nowMs) {
  const horizon = nowMs - TREND_LIMITS.historyDays * DAY_MS;
  document.items = document.items.filter((item) => Date.parse(item.expiresAt) >= horizon);
}

// At most maxItems: expired items go first (earliest expiry first), then the lowest score,
// the oldest sighting and the oldest record. Returns the ids removed.
function enforceCapacity(document, nowMs) {
  const excess = document.items.length - TREND_LIMITS.maxItems;
  if (excess <= 0) return new Set();
  const ranked = document.items.map((item, position) => ({ item, position, expired: isExpired(item, nowMs) }));
  ranked.sort((left, right) => (
    Number(right.expired) - Number(left.expired)
    || (left.expired && right.expired ? Date.parse(left.item.expiresAt) - Date.parse(right.item.expiresAt) : 0)
    || left.item.score - right.item.score
    || Date.parse(left.item.firstSeenAt) - Date.parse(right.item.firstSeenAt)
    || Date.parse(left.item.createdAt) - Date.parse(right.item.createdAt)
    || left.position - right.position
  ));
  const removed = new Set(ranked.slice(0, excess).map(({ item }) => item.id));
  document.items = document.items.filter((item) => !removed.has(item.id));
  return removed;
}

// Lookups for upserts: by externalId, and by kind + folded title.
class ItemIndex {
  constructor(items) {
    this.byExternal = new Map();
    this.byKey = new Map();
    for (const item of items) this.add(item);
  }

  add(item) {
    if (item.externalId !== null) this.byExternal.set(item.externalId, item);
    const key = trendMatchKey(item.kind, item.title);
    const list = this.byKey.get(key);
    if (list) list.push(item);
    else this.byKey.set(key, [item]);
  }

  remove(item) {
    if (item.externalId !== null && this.byExternal.get(item.externalId) === item) this.byExternal.delete(item.externalId);
    const key = trendMatchKey(item.kind, item.title);
    const list = (this.byKey.get(key) || []).filter((entry) => entry !== item);
    if (list.length) this.byKey.set(key, list);
    else this.byKey.delete(key);
  }

  // An externalId finds its own item, or adopts an item with the same key that has none yet;
  // without externalId, the first item with the same key.
  find(value) {
    const candidates = this.byKey.get(trendMatchKey(value.kind, value.title)) || [];
    if (value.externalId !== null) {
      return this.byExternal.get(value.externalId) || candidates.find((item) => item.externalId === null) || null;
    }
    return candidates[0] || null;
  }
}

function newItem(value, { source, enabled = true, stamp }) {
  return canonicalItem({ id: crypto.randomUUID(), ...value, source, enabled, createdAt: stamp, updatedAt: stamp });
}

// An agent refresh replaces the agent's content but keeps what the owner decided: the item
// stays disabled if it was, a "sensitive" mark is never lifted by an agent, the source and
// the first sighting stay.
function applyAgentUpdate(item, value, stamp) {
  item.kind = value.kind;
  item.title = value.title;
  item.summary = value.summary;
  item.keywords = [...value.keywords];
  item.hashtags = [...value.hashtags];
  item.platforms = [...value.platforms];
  item.region = value.region;
  item.examples = value.examples.map((example) => ({ ...example }));
  item.score = value.score;
  item.sensitivity = item.sensitivity === "sensitive" || value.sensitivity === "sensitive" ? "sensitive" : "normal";
  item.firstSeenAt = Date.parse(value.firstSeenAt) < Date.parse(item.firstSeenAt) ? value.firstSeenAt : item.firstSeenAt;
  item.expiresAt = value.expiresAt;
  if (value.externalId !== null) item.externalId = value.externalId;
  item.updatedAt = stamp;
}

// --- Files ----------------------------------------------------------------------------------

/** The settings directory (shared with llm-settings.json). Throws storage_unavailable on a bad configuration. */
export function settingsDirectory(env = process.env) {
  try {
    return resolveSettingsPaths(env).dir;
  } catch {
    throw storageError("config");
  }
}

async function readBounded(handle, maximum) {
  const chunks = [];
  const buffer = Buffer.alloc(64 * 1024);
  let total = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maximum) return null;
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks, total);
}

/** { exists, document } for <dir>/<fileName>. Never follows a symlink. Throws storage_unavailable. */
export async function readSettingsJson(dir, fileName, maxBytes) {
  let handle;
  try {
    handle = await open(/* turbopackIgnore: true */ path.join(dir, fileName), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, document: null };
    throw storageError("unreadable");
  }
  let bytes;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw storageError("unreadable");
    bytes = await readBounded(handle, maxBytes);
  } catch (error) {
    if (error instanceof TrendContextError) throw error;
    throw storageError("unreadable");
  } finally {
    await handle.close().catch(() => {});
  }
  if (bytes === null) throw storageError("corrupt");
  try {
    return { exists: true, document: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    throw storageError("corrupt");
  }
}

async function ensureSettingsDirectory(dir) {
  try {
    await mkdir(/* turbopackIgnore: true */ dir, { recursive: true, mode: 0o700 });
    const info = await lstat(/* turbopackIgnore: true */ dir);
    if (!info.isDirectory()) throw storageError("unreadable");
    if ((info.mode & 0o077) !== 0) await chmod(/* turbopackIgnore: true */ dir, 0o700);
  } catch (error) {
    if (error instanceof TrendContextError) throw error;
    throw storageError("unreadable");
  }
}

/** Writes `text` to <dir>/<fileName> as a 0600 file: temporary file, fsync, rename, directory fsync. */
export async function writeFileAtomic(dir, fileName, text) {
  const target = path.join(dir, fileName);
  const temporary = path.join(dir, `.${fileName}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const handle = await open(/* turbopackIgnore: true */ temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try {
      await handle.chmod(0o600);
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(/* turbopackIgnore: true */ temporary, target);
  } catch (error) {
    await rm(/* turbopackIgnore: true */ temporary, { force: true }).catch(() => {});
    throw error;
  }
  try {
    const directory = await open(/* turbopackIgnore: true */ dir, constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } catch {
    // Directory fsync is best effort (unsupported on some filesystems).
  }
}

/** Writes a settings document (JSON) into the 0700 settings directory. Throws storage_unavailable. */
export async function writeSettingsJson(dir, fileName, document) {
  await ensureSettingsDirectory(dir);
  const text = `${JSON.stringify(document)}\n`;
  if (Buffer.byteLength(text) > MAX_STORE_BYTES) throw storageError("unreadable");
  try {
    await writeFileAtomic(dir, fileName, text);
  } catch {
    throw storageError("unreadable");
  }
}

/** Renames an unreadable document out of the way (…corrupt-<time>-<random>, 0600) instead of deleting it. */
export async function setAsideCorrupt(dir, fileName) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const aside = path.join(dir, `${fileName}.corrupt-${stamp}-${crypto.randomBytes(4).toString("hex")}`);
  try {
    await rename(/* turbopackIgnore: true */ path.join(dir, fileName), aside);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw storageError("unreadable");
  }
  await chmod(/* turbopackIgnore: true */ aside, 0o600).catch(() => {});
}

// --- Lock -----------------------------------------------------------------------------------

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;
const lockQueues = new Map();

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// A lock directory older than LOCK_STALE_MS belongs to a writer that died: it is renamed away
// (only one reclaimer can win the rename) and removed.
async function reclaimStaleLock(lockPath) {
  let info;
  try {
    info = await lstat(/* turbopackIgnore: true */ lockPath);
  } catch (error) {
    return error?.code === "ENOENT";
  }
  if (Date.now() - info.mtimeMs <= LOCK_STALE_MS) return false;
  const aside = `${lockPath}.stale-${crypto.randomUUID()}`;
  try {
    await rename(/* turbopackIgnore: true */ lockPath, aside);
  } catch {
    return true;
  }
  await rm(/* turbopackIgnore: true */ aside, { recursive: true, force: true }).catch(() => {});
  return true;
}

async function acquireLockDirectory(lockPath) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let delay = 5;
  while (true) {
    try {
      await mkdir(/* turbopackIgnore: true */ lockPath, { mode: 0o700 });
      return async () => {
        await rm(/* turbopackIgnore: true */ lockPath, { recursive: true, force: true }).catch(() => {});
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw storageError("unreadable");
    }
    if (await reclaimStaleLock(lockPath)) continue;
    if (Date.now() >= deadline) throw storageError("locked");
    await sleep(delay);
    delay = Math.min(delay * 2, 50);
  }
}

/**
 * Runs `task` while holding the lock of <dir>/<fileName>: callers in this process queue up,
 * other processes wait on the lock directory (.<fileName>.lock).
 */
export function withSettingsLock(dir, fileName, task) {
  const lockPath = path.join(dir, `.${fileName}.lock`);
  const hold = async () => {
    await ensureSettingsDirectory(dir);
    const release = await acquireLockDirectory(lockPath);
    try {
      return await task();
    } finally {
      await release();
    }
  };
  const previous = lockQueues.get(lockPath) || Promise.resolve();
  const run = previous.then(hold, hold);
  const tail = run.then(() => {}, () => {});
  lockQueues.set(lockPath, tail);
  tail.then(() => { if (lockQueues.get(lockPath) === tail) lockQueues.delete(lockPath); });
  return run;
}

// --- Store ----------------------------------------------------------------------------------

/** { exists, document } — the validated document, or an empty switched-on one when there is no file. */
export async function readTrendContext({ env = process.env } = {}) {
  const dir = settingsDirectory(env);
  const read = await readSettingsJson(dir, TREND_CONTEXT_FILE, MAX_STORE_BYTES);
  if (!read.exists) return { exists: false, document: emptyDocument() };
  return { exists: true, document: parseStoredDocument(read.document) };
}

async function loadForWrite(dir) {
  try {
    const read = await readSettingsJson(dir, TREND_CONTEXT_FILE, MAX_STORE_BYTES);
    return read.exists ? parseStoredDocument(read.document) : emptyDocument();
  } catch (error) {
    if (!(error instanceof TrendContextError) || error.detail !== "corrupt") throw error;
    await setAsideCorrupt(dir, TREND_CONTEXT_FILE);
    return emptyDocument();
  }
}

// `task(document, nowMs, stamp)` mutates the document and returns { changed, result }.
async function mutateTrendContext(env, now, task) {
  const nowMs = toInstant(now);
  const stamp = new Date(nowMs).toISOString();
  const dir = settingsDirectory(env);
  return withSettingsLock(dir, TREND_CONTEXT_FILE, async () => {
    const document = await loadForWrite(dir);
    const { changed, result } = await task(document, nowMs, stamp);
    if (changed) {
      pruneHistory(document, nowMs);
      document.updatedAt = stamp;
      await writeSettingsJson(dir, TREND_CONTEXT_FILE, serializeDocument(document));
    }
    return result;
  });
}

/**
 * Upserts a batch from an agent whose token is labelled `source`. Invalid items are rejected
 * one by one; the others are stored. Returns { accepted, created, updated, rejected }.
 */
export async function ingestTrendItems(rawItems, { env = process.env, source, now = new Date() } = {}) {
  if (!Array.isArray(rawItems)) throw new TrendContextError("invalid_body", "Isi permintaan harus { \"items\": [ … ] }.");
  if (rawItems.length > TREND_LIMITS.maxBatchItems) {
    throw new TrendContextError("too_many_items", `Maksimal ${TREND_LIMITS.maxBatchItems} item per permintaan.`);
  }
  if (sourceLabel(source) === null || source === MANUAL_SOURCE) throw new Error("Invalid trend source label");
  return mutateTrendContext(env, now, (document, nowMs, stamp) => {
    pruneHistory(document, nowMs);
    const index = new ItemIndex(document.items);
    const rejected = [];
    const touched = [];
    rawItems.forEach((raw, position) => {
      const parsed = parseTrendInput(raw, { now: nowMs });
      if (!parsed.ok) {
        rejected.push({ index: position, code: parsed.code, field: parsed.field });
        return;
      }
      const existing = index.find(parsed.value);
      if (existing) {
        index.remove(existing);
        applyAgentUpdate(existing, parsed.value, stamp);
        index.add(existing);
        touched.push({ index: position, id: existing.id, created: false });
      } else {
        const created = newItem(parsed.value, { source, stamp });
        document.items.push(created);
        index.add(created);
        touched.push({ index: position, id: created.id, created: true });
      }
    });
    const removed = enforceCapacity(document, nowMs);
    let created = 0;
    let updated = 0;
    for (const entry of touched) {
      if (removed.has(entry.id)) rejected.push({ index: entry.index, code: "store_full", field: null });
      else if (entry.created) created += 1;
      else updated += 1;
    }
    rejected.sort((left, right) => left.index - right.index);
    document.lastIngestAt = stamp;
    return { changed: true, result: { accepted: created + updated, created, updated, rejected } };
  });
}

/** Active (unexpired) items as the agent needs them to dedupe: { id, externalId, kind, title, expiresAt, updatedAt }. */
export async function listActiveTrendSummaries({ env = process.env, now = new Date() } = {}) {
  const nowMs = toInstant(now);
  const { document } = await readTrendContext({ env });
  return document.items
    .filter((item) => !isExpired(item, nowMs))
    .map(({ id, externalId, kind, title, expiresAt, updatedAt }) => ({ id, externalId, kind, title, expiresAt, updatedAt }));
}

/** Deletes the item with this externalId if the agent labelled `source` owns it. */
export async function deleteTrendByExternalId(externalId, { env = process.env, source, now = new Date() } = {}) {
  if (typeof externalId !== "string" || !EXTERNAL_ID_PATTERN.test(externalId)) {
    throw new TrendContextError("invalid_body", "Parameter externalId tidak valid.");
  }
  return mutateTrendContext(env, now, (document) => {
    const position = document.items.findIndex((item) => item.externalId === externalId && item.source === source);
    if (position < 0) return { changed: false, result: false };
    document.items.splice(position, 1);
    return { changed: true, result: true };
  });
}

function viewItem(item, nowMs) {
  return { ...canonicalItem(item), expired: isExpired(item, nowMs) };
}

/** Everything GET /api/context/trends returns: the switch, times, active items and recent history. */
export async function readTrendContextView({ env = process.env, now = new Date() } = {}) {
  const nowMs = toInstant(now);
  const { document } = await readTrendContext({ env });
  const horizon = nowMs - TREND_LIMITS.historyDays * DAY_MS;
  const items = document.items
    .map((item, position) => ({ item: viewItem(item, nowMs), position }))
    .filter(({ item }) => Date.parse(item.expiresAt) >= horizon)
    .sort((left, right) => (
      Number(left.item.expired) - Number(right.item.expired)
      || Date.parse(right.item.updatedAt) - Date.parse(left.item.updatedAt)
      || left.position - right.position
    ))
    .map(({ item }) => item);
  const expired = items.filter((item) => item.expired).length;
  return {
    enabled: document.enabled,
    updatedAt: document.updatedAt,
    lastIngestAt: document.lastIngestAt,
    items,
    counts: { active: items.length - expired, expired },
  };
}

function invalidItem(issues) {
  return new TrendContextError("invalid_item", "Item tren belum valid.", { issues });
}

function duplicateError() {
  return new TrendContextError("duplicate", "Sudah ada item dengan jenis dan judul yang sama.");
}

/** Adds an item typed on the dashboard (source "manual"). */
export async function createManualTrend(input, { env = process.env, now = new Date() } = {}) {
  if (!isPlainObject(input)) throw invalidItem([{ field: null, code: "invalid_item" }]);
  const { enabled, ...rest } = input;
  if (enabled !== undefined && typeof enabled !== "boolean") throw invalidItem([{ field: "enabled", code: "invalid_type" }]);
  const parsed = parseTrendInput(rest, { now });
  if (!parsed.ok) throw invalidItem([{ field: parsed.field, code: parsed.code }]);
  return mutateTrendContext(env, now, (document, nowMs, stamp) => {
    pruneHistory(document, nowMs);
    const key = trendMatchKey(parsed.value.kind, parsed.value.title);
    if (document.items.some((item) => trendMatchKey(item.kind, item.title) === key
      || (parsed.value.externalId !== null && item.externalId === parsed.value.externalId))) throw duplicateError();
    const created = newItem(parsed.value, { source: MANUAL_SOURCE, enabled: enabled ?? true, stamp });
    document.items.push(created);
    if (enforceCapacity(document, nowMs).has(created.id)) {
      throw new TrendContextError("store_full", "Penyimpanan tren penuh; skor item ini terlalu rendah untuk disimpan.");
    }
    return { changed: true, result: canonicalItem(created) };
  });
}

function parsePatch(patch, nowMs) {
  if (!isPlainObject(patch)) throw invalidItem([{ field: null, code: "invalid_item" }]);
  const issues = [];
  const changes = {};
  for (const key of Object.keys(patch)) {
    if (!PATCH_FIELDS.includes(key)) {
      issues.push({ field: key, code: "unknown_field" });
      continue;
    }
    try {
      const raw = patch[key];
      if (key === "title") changes.title = parseLine(raw, "title", 1, TREND_LIMITS.title);
      else if (key === "summary") changes.summary = raw === null ? "" : parseSummary(raw);
      else if (key === "keywords") changes.keywords = parseKeywords(raw);
      else if (key === "hashtags") changes.hashtags = parseHashtags(raw);
      else if (key === "sensitivity") changes.sensitivity = parseEnum(raw, "sensitivity", TREND_SENSITIVITIES);
      else if (key === "enabled") {
        if (typeof raw !== "boolean") reject("invalid_type", "enabled");
        changes.enabled = raw;
      } else {
        // The owner may expire an item right away; the 60-day ceiling still applies.
        const time = Math.min(parseInstantField(raw, "expiresAt"), nowMs + TREND_LIMITS.maxTtlDays * DAY_MS);
        changes.expiresAt = new Date(time).toISOString();
      }
    } catch (error) {
      if (!(error instanceof Rejection)) throw error;
      issues.push({ field: error.field, code: error.code });
    }
  }
  if (issues.length) throw invalidItem(issues);
  return changes;
}

function notFound() {
  return new TrendContextError("not_found", "Item tren tidak ditemukan.");
}

/** Applies a dashboard edit (title, summary, keywords, hashtags, sensitivity, expiresAt, enabled). */
export async function updateTrendItem(id, patch, { env = process.env, now = new Date() } = {}) {
  if (typeof id !== "string" || !UUID.test(id)) throw notFound();
  const changes = parsePatch(patch, toInstant(now));
  return mutateTrendContext(env, now, (document, _nowMs, stamp) => {
    const item = document.items.find((entry) => entry.id === id);
    if (!item) throw notFound();
    if (changes.title !== undefined) {
      const key = trendMatchKey(item.kind, changes.title);
      if (document.items.some((entry) => entry !== item && trendMatchKey(entry.kind, entry.title) === key)) throw duplicateError();
    }
    Object.assign(item, changes, { updatedAt: stamp });
    return { changed: true, result: canonicalItem(item) };
  });
}

/** Deletes one item by id; false when there is none. */
export async function deleteTrendItem(id, { env = process.env, now = new Date() } = {}) {
  if (typeof id !== "string" || !UUID.test(id)) return false;
  return mutateTrendContext(env, now, (document) => {
    const position = document.items.findIndex((item) => item.id === id);
    if (position < 0) return { changed: false, result: false };
    document.items.splice(position, 1);
    return { changed: true, result: true };
  });
}

/** The global switch "Pakai konteks tren di pemilihan klip". */
export async function setTrendContextEnabled(enabled, { env = process.env, now = new Date() } = {}) {
  if (typeof enabled !== "boolean") throw new TrendContextError("invalid_body", "Isi permintaan harus { \"enabled\": true | false }.");
  return mutateTrendContext(env, now, (document, _nowMs, stamp) => {
    document.enabled = enabled;
    return { changed: true, result: { enabled, updatedAt: stamp } };
  });
}

// --- Per-job snapshot -----------------------------------------------------------------------

function snapshotItem(item) {
  return {
    id: item.id,
    ...(item.externalId !== null ? { externalId: item.externalId } : {}),
    kind: item.kind,
    title: item.title,
    summary: item.summary,
    keywords: [...item.keywords],
    hashtags: [...item.hashtags],
    platforms: [...item.platforms],
    region: item.region,
    score: item.score,
    sensitivity: item.sensitivity,
    firstSeenAt: item.firstSeenAt,
    expiresAt: item.expiresAt,
    enabled: item.enabled,
  };
}

/**
 * The analysis/trend-context.json a V3 job reads: enabled active items, highest score first
 * (then most recently updated), at most 300, without examples, source or record times. Null
 * when the switch is off or nothing qualifies, so such a job runs exactly as without trends.
 */
export function buildTrendSnapshot(document, { now = new Date() } = {}) {
  if (!document || document.enabled !== true || !Array.isArray(document.items)) return null;
  const nowMs = toInstant(now);
  const eligible = document.items
    .map((item, position) => ({ item, position }))
    .filter(({ item }) => item.enabled === true && !isExpired(item, nowMs));
  if (!eligible.length) return null;
  eligible.sort((left, right) => (
    right.item.score - left.item.score
    || Date.parse(right.item.updatedAt) - Date.parse(left.item.updatedAt)
    || left.position - right.position
  ));
  return {
    version: TREND_CONTEXT_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    items: eligible.slice(0, TREND_LIMITS.snapshotItems).map(({ item }) => snapshotItem(item)),
  };
}

/**
 * Writes <attemptRoot>/analysis/trend-context.json (0600) and returns its path, or returns
 * null and writes nothing when there is no snapshot. Throws storage_unavailable when the
 * store cannot be read; the worker then runs the job without trends.
 */
export async function writeTrendSnapshot(attemptRoot, { env = process.env, now = new Date() } = {}) {
  const { document } = await readTrendContext({ env });
  const snapshot = buildTrendSnapshot(document, { now });
  if (!snapshot) return null;
  const target = path.join(attemptRoot, TREND_SNAPSHOT_RELATIVE_PATH);
  await mkdir(/* turbopackIgnore: true */ path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFileAtomic(path.dirname(target), path.basename(target), `${JSON.stringify(snapshot, null, 2)}\n`);
  return target;
}

// --- HTTP helpers (Konteks Tren routes) -----------------------------------------------------

/** JSON response that is never cached. */
export function jsonNoStore(body, status = 200, headers = {}) {
  return Response.json(body, { status, headers: { ...headers, "Cache-Control": "no-store" } });
}

/** Body-less response that is never cached (204 by default). */
export function emptyNoStore(status = 204) {
  return new Response(null, { status, headers: { "Cache-Control": "no-store" } });
}

/** { error, code } (plus field/code issues) for a failure; never a path, value or stack. */
export function trendErrorResponse(error, headers = {}) {
  if (error instanceof TrendContextError) {
    const body = { error: error.message, code: error.code };
    if (error.issues?.length) body.issues = error.issues.map(({ field, code }) => ({ field, code }));
    return jsonNoStore(body, error.status, headers);
  }
  return jsonNoStore({ error: "Permintaan konteks tren tidak bisa diproses.", code: "internal" }, 500, headers);
}

/**
 * Session check (401) and, for mutations, the same-origin check (403) of the dashboard routes.
 * `authorize` returns null for a valid session (auth.mjs requireAuth).
 */
export function guardDashboardRequest(request, { authorize, sameOrigin, mutation = false }) {
  if (authorize(request)) return jsonNoStore({ error: "Sesi login tidak valid atau sudah berakhir.", code: "unauthorized" }, 401);
  if (mutation && !sameOrigin(request)) return jsonNoStore({ error: "Origin permintaan tidak diizinkan.", code: "csrf_rejected" }, 403);
  return null;
}

/**
 * The JSON body of `request`: Content-Type must be application/json, and at most `maxBytes`
 * are read (a larger declared Content-Length is refused before reading; a longer stream is
 * cancelled, never drained). Throws TrendContextError 415 / 413 / 400.
 */
export async function readJsonRequestBody(request, { maxBytes }) {
  const contentType = request.headers.get("content-type");
  if (contentType === null || !/^application\/json\s*(?:;|$)/i.test(contentType.trim())) {
    throw new TrendContextError("unsupported_media_type", "Isi permintaan harus application/json.");
  }
  const tooLarge = () => new TrendContextError("body_too_large", `Isi permintaan melebihi ${Math.floor(maxBytes / 1024)} KiB.`);
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) throw new TrendContextError("invalid_body", "Content-Length tidak valid.");
    if (Number(declared) > maxBytes) throw tooLarge();
  }
  const invalidJson = () => new TrendContextError("invalid_json", "Isi permintaan bukan JSON yang valid.");
  if (!request.body) throw invalidJson();
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new TrendContextError("invalid_body", "Isi permintaan tidak valid.");
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw invalidJson();
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total)));
  } catch {
    throw invalidJson();
  }
}
