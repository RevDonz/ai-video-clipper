// Bearer tokens for the owner's agent (Hermes) on /api/ingest/trends.
//
// A token is "ptk_" + 43 base64url characters (32 random bytes). It is shown once, in the
// response that creates it; <settingsDir>/ingest-tokens.json (0600, beside trend-context.json)
// keeps only its SHA-256, a display prefix (the first ten characters), a label, scopes and
// times. Verification hashes the presented token and compares it with every stored hash with
// timingSafeEqual. At most ten tokens are active; revoked ones stay listed (at most fifty) so
// the owner can see what was cut off. lastUsedAt is written at most once a minute.
//
// Nothing here logs, returns or throws a token value or a hash.

import crypto from "node:crypto";

import {
  MANUAL_SOURCE,
  TREND_LIMITS,
  TrendContextError,
  foldTrendText,
  normalizeTrendLine,
  readSettingsJson,
  setAsideCorrupt,
  settingsDirectory,
  withSettingsLock,
  writeSettingsJson,
} from "./trend-context.mjs";

export const INGEST_TOKENS_FILE = "ingest-tokens.json";
export const INGEST_TOKEN_PATTERN = /^ptk_[A-Za-z0-9_-]{43}$/;
export const INGEST_SCOPES = Object.freeze(["trends:read", "trends:write"]);
export const MAX_ACTIVE_TOKENS = 10;
export const MAX_REVOKED_TOKENS = 50;
export const MAX_TOKEN_LABEL_LENGTH = TREND_LIMITS.sourceLabel;

const TOKENS_VERSION = 1;
const PREFIX_LENGTH = 10;
const LAST_USED_INTERVAL_MS = 60_000;
const MAX_TOKENS_BYTES = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PREFIX = /^ptk_[A-Za-z0-9_-]{6}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const STORED_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TOKEN_KEYS = ["id", "label", "prefix", "sha256", "scopes", "createdAt", "lastUsedAt", "revokedAt"];
const BEARER = /^bearer +(\S+)$/i;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isInstant(value) {
  return typeof value === "string" && STORED_INSTANT.test(value) && new Date(value).toISOString() === value;
}

function codePoints(value) {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

/** A clean label (1..40 characters, not "manual"), or null. */
function cleanLabel(value) {
  const label = normalizeTrendLine(value);
  if (!label || codePoints(label) > MAX_TOKEN_LABEL_LENGTH || foldTrendText(label) === MANUAL_SOURCE) return null;
  return label;
}

function validRecord(raw) {
  if (!isPlainObject(raw)) return false;
  const names = Object.keys(raw);
  if (names.length !== TOKEN_KEYS.length || !TOKEN_KEYS.every((key) => names.includes(key))) return false;
  return typeof raw.id === "string" && UUID.test(raw.id)
    && typeof raw.label === "string" && cleanLabel(raw.label) === raw.label
    && typeof raw.prefix === "string" && PREFIX.test(raw.prefix)
    && typeof raw.sha256 === "string" && SHA256_HEX.test(raw.sha256)
    && Array.isArray(raw.scopes) && raw.scopes.length > 0 && new Set(raw.scopes).size === raw.scopes.length
    && raw.scopes.every((scope) => INGEST_SCOPES.includes(scope))
    && isInstant(raw.createdAt)
    && (raw.lastUsedAt === null || isInstant(raw.lastUsedAt))
    && (raw.revokedAt === null || isInstant(raw.revokedAt));
}

function corrupt() {
  return new TrendContextError("storage_unavailable", "File token ingest rusak. Membuat token baru memulai file baru; file lama disimpan sebagai cadangan.", { detail: "corrupt" });
}

function parseTokens(document) {
  if (!isPlainObject(document) || Object.keys(document).sort().join(",") !== "tokens,version") throw corrupt();
  if (document.version !== TOKENS_VERSION || !Array.isArray(document.tokens)) throw corrupt();
  if (document.tokens.length > MAX_ACTIVE_TOKENS + MAX_REVOKED_TOKENS) throw corrupt();
  const ids = new Set();
  const hashes = new Set();
  for (const record of document.tokens) {
    if (!validRecord(record) || ids.has(record.id) || hashes.has(record.sha256)) throw corrupt();
    ids.add(record.id);
    hashes.add(record.sha256);
  }
  if (document.tokens.filter((record) => record.revokedAt === null).length > MAX_ACTIVE_TOKENS) throw corrupt();
  return document.tokens.map((record) => ({ ...record, scopes: [...record.scopes] }));
}

async function readTokens(dir) {
  const read = await readSettingsJson(dir, INGEST_TOKENS_FILE, MAX_TOKENS_BYTES);
  return read.exists ? parseTokens(read.document) : [];
}

// `task(tokens)` mutates the list and returns { changed, result }. A corrupt file is set aside.
async function mutateTokens(env, task) {
  const dir = settingsDirectory(env);
  return withSettingsLock(dir, INGEST_TOKENS_FILE, async () => {
    let tokens;
    try {
      tokens = await readTokens(dir);
    } catch (error) {
      if (!(error instanceof TrendContextError) || error.detail !== "corrupt") throw error;
      await setAsideCorrupt(dir, INGEST_TOKENS_FILE);
      tokens = [];
    }
    const { changed, result } = await task(tokens);
    if (changed) await writeSettingsJson(dir, INGEST_TOKENS_FILE, { version: TOKENS_VERSION, tokens });
    return result;
  });
}

/** A token as the dashboard may see it: never the token value or its hash. */
export function publicToken(record) {
  return {
    id: record.id,
    label: record.label,
    prefix: record.prefix,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    revokedAt: record.revokedAt,
  };
}

function stampOf(now) {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid clock value");
  return date.toISOString();
}

/** Creates a write token. Returns { token, record }; the token value is never available again. */
export async function createIngestToken(label, { env = process.env, now = new Date() } = {}) {
  const clean = typeof label === "string" ? cleanLabel(label) : null;
  if (clean === null) {
    throw new TrendContextError("invalid_label", `Label token wajib diisi (1–${MAX_TOKEN_LABEL_LENGTH} karakter) dan tidak boleh "manual".`);
  }
  const stamp = stampOf(now);
  return mutateTokens(env, (tokens) => {
    const active = tokens.filter((record) => record.revokedAt === null);
    if (active.some((record) => foldTrendText(record.label) === foldTrendText(clean))) {
      throw new TrendContextError("label_taken", "Label ini sudah dipakai token aktif lain.");
    }
    if (active.length >= MAX_ACTIVE_TOKENS) {
      throw new TrendContextError("token_limit", `Maksimal ${MAX_ACTIVE_TOKENS} token aktif. Cabut token lama dulu.`);
    }
    const token = `ptk_${crypto.randomBytes(32).toString("base64url")}`;
    const record = {
      id: crypto.randomUUID(),
      label: clean,
      prefix: token.slice(0, PREFIX_LENGTH),
      sha256: crypto.createHash("sha256").update(token).digest("hex"),
      scopes: ["trends:write"],
      createdAt: stamp,
      lastUsedAt: null,
      revokedAt: null,
    };
    tokens.push(record);
    return { changed: true, result: { token, record: publicToken(record) } };
  });
}

/** Every stored token (active and revoked), oldest first, without values or hashes. */
export async function listIngestTokens({ env = process.env } = {}) {
  return (await readTokens(settingsDirectory(env))).map(publicToken);
}

/** Revokes a token (idempotent). Returns its public record, or null when there is no such token. */
export async function revokeIngestToken(id, { env = process.env, now = new Date() } = {}) {
  if (typeof id !== "string" || !UUID.test(id)) return null;
  const stamp = stampOf(now);
  return mutateTokens(env, (tokens) => {
    const record = tokens.find((entry) => entry.id === id);
    if (!record) return { changed: false, result: null };
    if (record.revokedAt !== null) return { changed: false, result: publicToken(record) };
    record.revokedAt = stamp;
    const revoked = tokens.filter((entry) => entry.revokedAt !== null)
      .sort((left, right) => Date.parse(left.revokedAt) - Date.parse(right.revokedAt));
    const dropped = new Set(revoked.slice(0, Math.max(0, revoked.length - MAX_REVOKED_TOKENS)).map((entry) => entry.id));
    if (dropped.size) tokens.splice(0, tokens.length, ...tokens.filter((entry) => !dropped.has(entry.id)));
    return { changed: true, result: publicToken(record) };
  });
}

function grants(scopes, required) {
  return scopes.includes(required) || (required === "trends:read" && scopes.includes("trends:write"));
}

async function touchLastUsed(env, id, nowMs) {
  await mutateTokens(env, (tokens) => {
    const record = tokens.find((entry) => entry.id === id);
    if (!record || (record.lastUsedAt !== null && nowMs - Date.parse(record.lastUsedAt) < LAST_USED_INTERVAL_MS)) {
      return { changed: false, result: null };
    }
    record.lastUsedAt = new Date(nowMs).toISOString();
    return { changed: true, result: null };
  });
}

/**
 * Checks an Authorization header for `scope`. Returns { ok: true, token: { id, label, scopes } }
 * or { ok: false, status, code } with 401 missing_token | invalid_token | revoked_token,
 * 403 insufficient_scope or 503 storage_unavailable.
 */
export async function verifyIngestToken(header, { env = process.env, scope, now = new Date() } = {}) {
  if (typeof header !== "string" || header.trim() === "") return { ok: false, status: 401, code: "missing_token" };
  const match = BEARER.exec(header.trim());
  if (!match || !INGEST_TOKEN_PATTERN.test(match[1])) return { ok: false, status: 401, code: "invalid_token" };
  let tokens;
  try {
    tokens = await readTokens(settingsDirectory(env));
  } catch {
    return { ok: false, status: 503, code: "storage_unavailable" };
  }
  const digest = crypto.createHash("sha256").update(match[1]).digest();
  let found = null;
  for (const record of tokens) {
    const equal = crypto.timingSafeEqual(Buffer.from(record.sha256, "hex"), digest);
    if (equal && found === null) found = record;
  }
  if (found === null) return { ok: false, status: 401, code: "invalid_token" };
  if (found.revokedAt !== null) return { ok: false, status: 401, code: "revoked_token" };
  if (!grants(found.scopes, scope)) return { ok: false, status: 403, code: "insufficient_scope" };
  const nowMs = new Date(now).getTime();
  if (found.lastUsedAt === null || nowMs - Date.parse(found.lastUsedAt) >= LAST_USED_INTERVAL_MS) {
    // Best effort: a failed bookkeeping write never turns a valid request away.
    await touchLastUsed(env, found.id, nowMs).catch(() => {});
  }
  return { ok: true, token: { id: found.id, label: found.label, scopes: [...found.scopes] } };
}
