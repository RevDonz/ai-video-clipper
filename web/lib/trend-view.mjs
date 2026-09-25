// Presentation helpers for the Konteks Tren page (/trends). Client-safe and
// pure: no Node built-ins, no fetch, no DOM. Spec: docs/plans/2026-09-25-konteks-tren.md
// (§1 item model, §3.2 UI routes, §5 UI).
//
// Everything an item carries came from outside (an agent that scrolled social
// media), so it is treated as untrusted text: normalized here, rendered only
// as React text, and links are limited to plain http(s) URLs.

export const TREND_KINDS = Object.freeze(["topic", "person", "joke", "meme", "sound", "hashtag", "format", "event"]);
export const TREND_KIND_LABELS = Object.freeze({
  topic: "Topik",
  person: "Orang",
  joke: "Jokes",
  meme: "Meme",
  sound: "Sound",
  hashtag: "Hashtag",
  format: "Format konten",
  event: "Peristiwa",
});
const OTHER_KIND = "other";
const OTHER_KIND_LABEL = "Lainnya";

export const TREND_PLATFORMS = Object.freeze(["tiktok", "instagram", "youtube", "x", "facebook", "news", "other"]);
export const TREND_PLATFORM_LABELS = Object.freeze({
  tiktok: "TikTok",
  instagram: "Instagram",
  youtube: "YouTube",
  x: "X",
  facebook: "Facebook",
  news: "Berita",
  other: "Lainnya",
});

export const TREND_SENSITIVITY_LABELS = Object.freeze({ normal: "Normal", sensitive: "Sensitif" });

export const TREND_LIMITS = Object.freeze({
  title: 80,
  summary: 500,
  summaryLines: 5,
  keywords: 12,
  keywordMin: 2,
  keywordMax: 40,
  hashtags: 10,
  hashtagBody: 50,
  scoreMin: 0,
  scoreMax: 100,
  maxExpiryDays: 60,
  defaultExpiryDays: 10,
  tokenLabel: 40,
  maxActiveTokens: 10,
  exampleUrl: 500,
  exampleNote: 120,
  source: 40,
});

export const TREND_STATUS_FILTERS = Object.freeze([
  { id: "all", label: "Semua" },
  { id: "active", label: "Aktif" },
  { id: "disabled", label: "Nonaktif" },
  { id: "expired", label: "Kedaluwarsa" },
]);

export const TREND_STATUS_LABELS = Object.freeze({ active: "Aktif", disabled: "Nonaktif", expired: "Kedaluwarsa" });

export const SESSION_TEXT = "Sesi login berakhir. Muat ulang halaman untuk masuk lagi.";
export const GUIDE_URL = "https://github.com/RevDonz/ai-video-clipper/blob/main/docs/integrations/hermes-trends/README.md";
export const INGEST_PATH = "/api/ingest/trends";
export const TOKEN_ENV = "POTONGIN_INGEST_TOKEN";
const TOKEN_PATTERN = /^ptk_[A-Za-z0-9_-]{43}$/;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// --- Text ---------------------------------------------------------------------

// Format characters (bidi, zero-width, BOM, soft hyphen, tags) and every other invisible
// default-ignorable code point (variation selectors, fillers), as the server strips them.
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const WHITESPACE_CONTROLS = /[\t\n\v\f\r\u0085\u2028\u2029]/g;
const OTHER_CONTROLS = /\p{Cc}/gu;

function codePoints(value) {
  return Array.from(value).length;
}

function truncate(value, maximum) {
  const points = Array.from(value);
  return points.length > maximum ? points.slice(0, maximum).join("") : value;
}

/** One line of display text: NFC, no controls or invisible characters, spaces collapsed. */
export function cleanLine(value) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFC")
    .replace(INVISIBLE, "")
    .replace(WHITESPACE_CONTROLS, " ")
    .replace(OTHER_CONTROLS, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Multi-line text (the summary): lines cleaned like cleanLine, at most one blank line in a row. */
export function cleanMultiline(value) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(cleanLine)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function fold(value) {
  return cleanLine(value).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function isoOrNull(value) {
  if (typeof value !== "string" || !value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

// --- Links ----------------------------------------------------------------------

/** An example link, only when it is an absolute http(s) URL without credentials; otherwise null. */
export function safeExampleUrl(value) {
  if (typeof value !== "string" || !value || value.length > TREND_LIMITS.exampleUrl) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!url.hostname || url.username || url.password) return null;
  return url.href.length > TREND_LIMITS.exampleUrl ? null : url.href;
}

// --- Items ------------------------------------------------------------------------

const HASHTAG = /^#[\p{L}\p{N}_]{1,50}$/u;

function stringList(value, maximum, itemLimit) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    if (out.length >= maximum) break;
    const text = truncate(cleanLine(entry), itemLimit);
    if (text) out.push(text);
  }
  return out;
}

/**
 * A server item made safe for display, or null when it has no id (nothing
 * could be done with it). Unknown kinds fall into "other"; invalid fields are
 * dropped, never coerced from another type.
 */
export function normalizeTrendItem(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id || id.length > 200) return null;
  const score = typeof raw.score === "number" && Number.isFinite(raw.score)
    && raw.score >= TREND_LIMITS.scoreMin && raw.score <= TREND_LIMITS.scoreMax ? Math.round(raw.score) : null;
  const examples = [];
  for (const example of Array.isArray(raw.examples) ? raw.examples : []) {
    if (examples.length >= 5) break;
    if (!example || typeof example !== "object") continue;
    const url = safeExampleUrl(example.url);
    if (!url || examples.some((kept) => kept.url === url)) continue;
    examples.push({ url, note: truncate(cleanLine(example.note), TREND_LIMITS.exampleNote), host: new URL(url).host });
  }
  return {
    id,
    externalId: typeof raw.externalId === "string" && raw.externalId ? truncate(cleanLine(raw.externalId), 120) || null : null,
    kind: TREND_KINDS.includes(raw.kind) ? raw.kind : OTHER_KIND,
    title: truncate(cleanLine(raw.title), TREND_LIMITS.title) || "(tanpa judul)",
    summary: truncate(cleanMultiline(raw.summary), TREND_LIMITS.summary),
    keywords: stringList(raw.keywords, TREND_LIMITS.keywords, TREND_LIMITS.keywordMax),
    hashtags: stringList(raw.hashtags, TREND_LIMITS.hashtags, TREND_LIMITS.hashtagBody + 1).filter((tag) => HASHTAG.test(tag)),
    platforms: Array.isArray(raw.platforms) ? TREND_PLATFORMS.filter((platform) => raw.platforms.includes(platform)) : [],
    region: typeof raw.region === "string" && /^[A-Z]{2}$/.test(raw.region) ? raw.region : null,
    examples,
    score,
    sensitivity: raw.sensitivity === "sensitive" ? "sensitive" : "normal",
    firstSeenAt: isoOrNull(raw.firstSeenAt),
    expiresAt: isoOrNull(raw.expiresAt),
    source: truncate(cleanLine(raw.source), TREND_LIMITS.source),
    enabled: raw.enabled !== false,
    createdAt: isoOrNull(raw.createdAt),
    updatedAt: isoOrNull(raw.updatedAt),
  };
}

/** GET /api/context/trends → { items, enabled, lastIngestAt }, or null when the body is not that shape. */
export function normalizeTrendList(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.items)) return null;
  return {
    items: payload.items.map(normalizeTrendItem).filter(Boolean),
    enabled: payload.enabled !== false,
    lastIngestAt: isoOrNull(payload.lastIngestAt),
  };
}

export function trendKindLabel(kind) {
  return TREND_KIND_LABELS[kind] || OTHER_KIND_LABEL;
}

export function platformLabels(platforms) {
  return (Array.isArray(platforms) ? platforms : []).map((platform) => TREND_PLATFORM_LABELS[platform]).filter(Boolean);
}

export function sourceLabel(source) {
  if (source === "manual") return "Manual";
  const text = cleanLine(source);
  return text ? `Agen: ${text}` : "Tidak diketahui";
}

/** "expired" (expiry reached, whatever the switch says), "disabled" or "active". */
export function trendItemStatus(item, now = Date.now()) {
  const expires = item?.expiresAt ? Date.parse(item.expiresAt) : NaN;
  if (Number.isFinite(expires) && expires <= now) return "expired";
  return item?.enabled === false ? "disabled" : "active";
}

// --- Time -------------------------------------------------------------------------

function span(ms) {
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 60) return `${Math.max(1, minutes)} menit`;
  const hours = Math.round(ms / HOUR);
  if (hours < 24) return `${hours} jam`;
  return `${Math.max(1, Math.round(ms / DAY))} hari`;
}

/** "dalam 3 hari", "2 jam lalu", "baru saja"…, or null for an unreadable time. */
export function relativeTime(value, now = Date.now()) {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) return null;
  const delta = time - now;
  if (Math.abs(delta) < MINUTE) return delta > 0 ? "kurang dari 1 menit lagi" : "baru saja";
  return delta > 0 ? `dalam ${span(delta)}` : `${span(-delta)} lalu`;
}

/** A readable absolute date and time in Indonesian, or null. */
export function formatDateTime(value) {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) return null;
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short" }).format(new Date(time));
}

export function expiryView(item, now = Date.now()) {
  const expires = item?.expiresAt ? Date.parse(item.expiresAt) : NaN;
  if (!Number.isFinite(expires)) return { text: "Tanpa tanggal kedaluwarsa", tone: "ok", absolute: null };
  const relative = relativeTime(item.expiresAt, now);
  const absolute = formatDateTime(item.expiresAt);
  if (expires <= now) return { text: `Kedaluwarsa ${relative}`, tone: "expired", absolute };
  return { text: `Berakhir ${relative}`, tone: expires - now < DAY ? "soon" : "ok", absolute };
}

function pad(value) {
  return String(value).padStart(2, "0");
}

/** The local calendar day of an ISO time as an <input type="date"> value, or "". */
export function dateInputValue(value) {
  const time = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) return "";
  const date = new Date(time);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function expiryDateBounds(now = Date.now()) {
  return { min: dateInputValue(now), max: dateInputValue(now + TREND_LIMITS.maxExpiryDays * DAY) };
}

/**
 * The expiry for a chosen calendar day: the end of that local day, kept just
 * under the server's "at most 60 days from now". Returns { iso } or { error }.
 */
export function expiryFromDateInput(value, now = Date.now()) {
  const match = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (!match) return { error: "Tanggal kedaluwarsa tidak valid." };
  const [year, month, day] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  const end = new Date(year, month, day, 23, 59, 0, 0);
  if (end.getFullYear() !== year || end.getMonth() !== month || end.getDate() !== day) {
    return { error: "Tanggal kedaluwarsa tidak valid." };
  }
  const bounds = expiryDateBounds(now);
  if (value < bounds.min) return { error: "Tanggal kedaluwarsa harus hari ini atau setelahnya." };
  if (value > bounds.max) return { error: `Tanggal kedaluwarsa maksimal ${TREND_LIMITS.maxExpiryDays} hari dari sekarang.` };
  const latest = now + TREND_LIMITS.maxExpiryDays * DAY - MINUTE;
  const time = Math.max(Math.min(end.getTime(), latest), now + MINUTE);
  return { iso: new Date(time).toISOString() };
}

// --- Grouping, search, counts --------------------------------------------------------

const STATUS_RANK = { active: 0, disabled: 1, expired: 2 };

function compareItems(now) {
  return (left, right) => {
    const rank = STATUS_RANK[trendItemStatus(left, now)] - STATUS_RANK[trendItemStatus(right, now)];
    if (rank) return rank;
    const score = (right.score ?? -1) - (left.score ?? -1);
    if (score) return score;
    const updated = (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0);
    if (updated) return updated;
    return left.title.localeCompare(right.title, "id-ID");
  };
}

/** Non-empty groups in spec kind order ("Lainnya" last), each sorted active → score → newest. */
export function groupTrendItems(items, now = Date.now()) {
  const order = [...TREND_KINDS, OTHER_KIND];
  const byKind = new Map(order.map((kind) => [kind, []]));
  for (const item of items || []) byKind.get(byKind.has(item.kind) ? item.kind : OTHER_KIND).push(item);
  return order
    .filter((kind) => byKind.get(kind).length)
    .map((kind) => ({ kind, label: trendKindLabel(kind), items: byKind.get(kind).sort(compareItems(now)) }));
}

function searchText(item) {
  return fold([item.title, item.summary, ...item.keywords, ...item.hashtags].join(" "));
}

/** The items matching a search text, a kind ("all") and a status ("all"), in their original order. */
export function filterTrendItems(items, { query = "", kind = "all", status = "all" } = {}, now = Date.now()) {
  const needle = fold(query);
  return (items || []).filter((item) => (kind === "all" || item.kind === kind)
    && (status === "all" || trendItemStatus(item, now) === status)
    && (!needle || searchText(item).includes(needle)));
}

export function trendCounts(items, now = Date.now()) {
  const counts = { all: 0, active: 0, disabled: 0, expired: 0, sensitive: 0, byKind: {} };
  for (const item of items || []) {
    counts.all += 1;
    counts[trendItemStatus(item, now)] += 1;
    if (item.sensitivity === "sensitive") counts.sensitive += 1;
    counts.byKind[item.kind] = (counts.byKind[item.kind] || 0) + 1;
  }
  return counts;
}

// --- Drafts (manual form and inline edit) ----------------------------------------------

export function emptyTrendDraft() {
  return {
    kind: "topic",
    title: "",
    summary: "",
    keywordsText: "",
    hashtagsText: "",
    platforms: [],
    score: "",
    sensitivity: "normal",
    expiresDate: "",
  };
}

export function draftFromTrendItem(item) {
  return {
    title: item.title,
    summary: item.summary,
    keywordsText: item.keywords.join(", "),
    hashtagsText: item.hashtags.join(" "),
    sensitivity: item.sensitivity,
    expiresDate: dateInputValue(item.expiresAt),
    enabled: item.enabled,
  };
}

function uniqueByFold(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = fold(value);
    if (!value || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Keywords as typed: separated by commas, semicolons or new lines; duplicates (case/accents) dropped. */
export function parseKeywords(text) {
  return uniqueByFold(String(text ?? "").split(/[,;\n]/).map(cleanLine));
}

/** Hashtags as typed: separated by spaces or commas; "#" added when missing. */
export function parseHashtags(text) {
  return uniqueByFold(String(text ?? "")
    .split(/[\s,;]+/)
    .map((entry) => cleanLine(entry).replace(/^#+/, ""))
    .filter(Boolean)
    .map((body) => `#${body}`));
}

function validateTitle(value) {
  const title = cleanLine(value);
  if (!title) return { value: title, error: "Judul wajib diisi." };
  if (codePoints(title) > TREND_LIMITS.title) return { value: title, error: `Judul maksimal ${TREND_LIMITS.title} karakter.` };
  return { value: title };
}

function validateSummary(value) {
  const summary = cleanMultiline(value);
  if (codePoints(summary) > TREND_LIMITS.summary) return { value: summary, error: `Ringkasan maksimal ${TREND_LIMITS.summary} karakter.` };
  if (summary && summary.split("\n").length > TREND_LIMITS.summaryLines) {
    return { value: summary, error: `Ringkasan maksimal ${TREND_LIMITS.summaryLines} baris.` };
  }
  return { value: summary };
}

function validateKeywords(text) {
  const keywords = parseKeywords(text);
  if (!keywords.length) return { value: keywords, error: "Isi minimal satu kata kunci: cara orang menyebut tren ini di video." };
  if (keywords.length > TREND_LIMITS.keywords) return { value: keywords, error: `Maksimal ${TREND_LIMITS.keywords} kata kunci.` };
  const bad = keywords.find((keyword) => codePoints(keyword) < TREND_LIMITS.keywordMin || codePoints(keyword) > TREND_LIMITS.keywordMax);
  if (bad !== undefined) {
    return { value: keywords, error: `Kata kunci “${truncate(bad, 20)}” harus ${TREND_LIMITS.keywordMin}–${TREND_LIMITS.keywordMax} karakter.` };
  }
  return { value: keywords };
}

function validateHashtags(text) {
  const hashtags = parseHashtags(text);
  if (hashtags.length > TREND_LIMITS.hashtags) return { value: hashtags, error: `Maksimal ${TREND_LIMITS.hashtags} hashtag.` };
  const bad = hashtags.find((tag) => !HASHTAG.test(tag));
  if (bad !== undefined) {
    return { value: hashtags, error: `Hashtag “${truncate(bad, 30)}” tidak valid: pakai huruf, angka, atau _ saja (maks ${TREND_LIMITS.hashtagBody}).` };
  }
  return { value: hashtags };
}

function validateScore(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return { value: null };
  const score = Number(raw);
  if (!/^\d{1,3}$/.test(raw) || score < TREND_LIMITS.scoreMin || score > TREND_LIMITS.scoreMax) {
    return { value: null, error: "Skor harus bilangan bulat 0–100." };
  }
  return { value: score };
}

function sameList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** The manual form → POST /api/context/trends body. Returns { payload, errors } (errors keyed by field). */
export function trendCreatePayload(draft, now = Date.now()) {
  const errors = {};
  const payload = {};
  if (TREND_KINDS.includes(draft.kind)) payload.kind = draft.kind;
  else errors.kind = "Pilih jenis tren yang valid.";

  const checks = {
    title: validateTitle(draft.title),
    summary: validateSummary(draft.summary),
    keywords: validateKeywords(draft.keywordsText),
    hashtags: validateHashtags(draft.hashtagsText),
    score: validateScore(draft.score),
  };
  for (const [field, check] of Object.entries(checks)) if (check.error) errors[field] = check.error;
  payload.title = checks.title.value;
  if (checks.summary.value) payload.summary = checks.summary.value;
  payload.keywords = checks.keywords.value;
  if (checks.hashtags.value.length) payload.hashtags = checks.hashtags.value;

  const platforms = Array.isArray(draft.platforms) ? draft.platforms : [];
  if (platforms.some((platform) => !TREND_PLATFORMS.includes(platform))) errors.platforms = "Pilih platform dari daftar.";
  else if (platforms.length) payload.platforms = TREND_PLATFORMS.filter((platform) => platforms.includes(platform));

  if (checks.score.value !== null) payload.score = checks.score.value;
  payload.sensitivity = draft.sensitivity === "sensitive" ? "sensitive" : "normal";

  if (draft.expiresDate) {
    const expiry = expiryFromDateInput(draft.expiresDate, now);
    if (expiry.error) errors.expiresAt = expiry.error;
    else payload.expiresAt = expiry.iso;
  }
  return { payload: Object.keys(errors).length ? null : payload, errors };
}

/**
 * Inline edit → PATCH /api/context/trends/[id] body with only the editable
 * fields that changed. Unchanged fields are neither validated nor sent, so an
 * item that already expired keeps its date until the owner picks a new one.
 */
export function trendPatchPayload(item, draft, now = Date.now()) {
  const errors = {};
  const payload = {};

  const title = validateTitle(draft.title);
  if (title.value !== item.title) {
    if (title.error) errors.title = title.error;
    else payload.title = title.value;
  }
  const summary = validateSummary(draft.summary);
  if (summary.value !== item.summary) {
    if (summary.error) errors.summary = summary.error;
    else payload.summary = summary.value;
  }
  const keywords = validateKeywords(draft.keywordsText);
  if (!sameList(keywords.value, item.keywords)) {
    if (keywords.error) errors.keywords = keywords.error;
    else payload.keywords = keywords.value;
  }
  const hashtags = validateHashtags(draft.hashtagsText);
  if (!sameList(hashtags.value, item.hashtags)) {
    if (hashtags.error) errors.hashtags = hashtags.error;
    else payload.hashtags = hashtags.value;
  }
  const sensitivity = draft.sensitivity === "sensitive" ? "sensitive" : "normal";
  if (sensitivity !== item.sensitivity) payload.sensitivity = sensitivity;
  if (draft.expiresDate !== dateInputValue(item.expiresAt)) {
    if (!draft.expiresDate) errors.expiresAt = "Tanggal kedaluwarsa wajib diisi.";
    else {
      const expiry = expiryFromDateInput(draft.expiresDate, now);
      if (expiry.error) errors.expiresAt = expiry.error;
      else payload.expiresAt = expiry.iso;
    }
  }
  if (typeof draft.enabled === "boolean" && draft.enabled !== item.enabled) payload.enabled = draft.enabled;

  const failed = Object.keys(errors).length > 0;
  return { payload: failed ? null : payload, errors, changed: failed || Object.keys(payload).length > 0 };
}

// --- Tokens ---------------------------------------------------------------------------

export function validateTokenLabel(value) {
  const label = cleanLine(value);
  if (!label) return { label, error: "Label token wajib diisi, mis. “Hermes VPS”." };
  if (codePoints(label) > TREND_LIMITS.tokenLabel) return { label, error: `Label maksimal ${TREND_LIMITS.tokenLabel} karakter.` };
  return { label, error: null };
}

// Only these fields are kept: never a hash, never a token value.
function normalizeTokenRecord(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id || id.length > 200) return null;
  const prefix = typeof raw.prefix === "string" && /^[A-Za-z0-9_-]{1,24}$/.test(raw.prefix) ? raw.prefix : "";
  return {
    id,
    label: truncate(cleanLine(raw.label), TREND_LIMITS.tokenLabel) || "(tanpa label)",
    prefix,
    createdAt: isoOrNull(raw.createdAt),
    lastUsedAt: isoOrNull(raw.lastUsedAt),
    revokedAt: isoOrNull(raw.revokedAt),
  };
}

/** GET /api/context/tokens → active tokens first, newest first; null when the body is not that shape. */
export function normalizeTokenList(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.tokens)) return null;
  return payload.tokens
    .map(normalizeTokenRecord)
    .filter(Boolean)
    .sort((left, right) => (Number(Boolean(left.revokedAt)) - Number(Boolean(right.revokedAt)))
      || ((Date.parse(right.createdAt) || 0) - (Date.parse(left.createdAt) || 0)));
}

export function activeTokenCount(tokens) {
  return (tokens || []).filter((token) => !token.revokedAt).length;
}

export function tokenView(token, now = Date.now()) {
  const revoked = Boolean(token.revokedAt);
  return {
    status: revoked ? "revoked" : "active",
    statusLabel: revoked ? `Dicabut ${formatDateTime(token.revokedAt) || ""}`.trim() : "Aktif",
    prefixText: token.prefix ? `${token.prefix}…` : "—",
    createdText: formatDateTime(token.createdAt) || "—",
    lastUsedText: token.lastUsedAt ? relativeTime(token.lastUsedAt, now) || "—" : "Belum pernah dipakai",
    lastUsedAbsolute: formatDateTime(token.lastUsedAt),
  };
}

/** POST /api/context/tokens (201) → { token, record }, or null when the token is not a ptk_ token. */
export function createdTokenFrom(payload) {
  if (!payload || typeof payload !== "object" || typeof payload.token !== "string" || !TOKEN_PATTERN.test(payload.token)) return null;
  const nested = [payload.item, payload.record, payload.tokenInfo].find((entry) => entry && typeof entry === "object");
  const { token, ...rest } = payload;
  return { token, record: normalizeTokenRecord(nested || rest) };
}

// --- Agent integration ---------------------------------------------------------------------

/** The ingest URL on this deployment, from the page origin; null for a non-http(s) origin. */
export function ingestEndpoint(origin) {
  if (typeof origin !== "string") return null;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.origin}${INGEST_PATH}`;
  } catch {
    return null;
  }
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

const CURL_SAMPLE = Object.freeze({
  items: [{
    externalId: "contoh:tren-uji-coba",
    kind: "topic",
    title: "Tren uji coba",
    summary: "Item contoh dari halaman Konteks Tren. Hapus setelah uji coba.",
    keywords: ["tren uji coba"],
    platforms: ["tiktok"],
    score: 50,
  }],
});

/**
 * A copy-paste curl example, as in the Hermes kit: the token is pasted into a
 * hidden prompt into the environment variable push_trends.py reads (never
 * written into a command, so never in shell history or in this text), the
 * active items are listed first, then one sample item is posted. The header
 * goes to curl on stdin (-H @-) from the printf builtin, so the token never
 * appears in a process's arguments, where ps would show it.
 */
export function curlExample({ origin } = {}) {
  const endpoint = shellQuote(ingestEndpoint(origin) || INGEST_PATH);
  const header = `printf 'Authorization: Bearer %s\\n' "$${TOKEN_ENV}" |`;
  return [
    `read -rs ${TOKEN_ENV} && export ${TOKEN_ENV}`,
    `${header} curl -sS -H @- ${endpoint}`,
    `${header} curl -sS -X POST ${endpoint} \\`,
    "  -H @- \\",
    "  -H 'Content-Type: application/json' \\",
    `  --data ${shellQuote(JSON.stringify(CURL_SAMPLE))}`,
  ].join("\n");
}

// --- Errors -----------------------------------------------------------------------------

const STATUS_MESSAGES = {
  0: "Server tidak bisa dihubungi. Periksa koneksi lalu coba lagi.",
  403: "Permintaan ditolak oleh server. Muat ulang halaman lalu coba lagi.",
  404: "Data tidak ditemukan — mungkin sudah dihapus. Muat ulang daftar.",
  413: "Isian terlalu besar untuk disimpan.",
  429: "Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.",
  503: "Penyimpanan konteks tren sedang tidak tersedia. Coba lagi nanti.",
};

/** A short Indonesian message for a failed request ({ status, payload }); server text is cleaned and bounded. */
export function apiErrorMessage({ status, payload } = {}, fallback = "Permintaan gagal.") {
  if (status === 401) return SESSION_TEXT;
  if (status === 0) return STATUS_MESSAGES[0];
  const serverText = payload && typeof payload === "object" ? truncate(cleanLine(payload.error), 300) : "";
  return serverText || STATUS_MESSAGES[status] || fallback;
}
