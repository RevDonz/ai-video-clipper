// LLM settings managed from the dashboard (/settings) instead of .env.
//
// One versioned JSON document, <settingsDir>/llm-settings.json, holds the
// provider chain in failover order. settingsDir is POTONGIN_SETTINGS_DIR or a
// "settings" directory beside JOBS_ROOT (in Docker: /data/settings), never
// inside the jobs tree, so no file route can serve it. API keys are sealed with
// AES-256-GCM under a key derived (HKDF-SHA256) from POTONGIN_SETTINGS_SECRET or
// APP_SESSION_SECRET and bound to their provider name. A key that can no longer
// be opened (the secret changed) is reported as unreadable, never guessed.
//
// The Python engine still reads only environment variables: buildLlmEnv turns
// the document into POTONGIN_LLM_* variables for the engine child process and
// removes every inherited LLM variable, so the UI settings are the single
// source of truth once they exist. Without a settings file the environment is
// passed through unchanged (the .env configuration keeps working).
//
// Nothing in this module logs, returns or throws a key value.

import crypto from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";

import {
  LLM_PRESETS,
  MAX_FALLBACK_MODELS,
  NUMBER_RULES,
  PROVIDER_FIELDS,
  PROVIDER_NAMES,
  REASONING_EFFORTS,
  apiKeyProblem,
  appTitleProblem,
  baseUrlProblem,
  fallbackModelProblem,
  httpRefererProblem,
  isProviderName,
  modelProblem,
  numberProblem,
  reasoningEffortProblem,
  scopedEnvName,
} from "./llm-presets.mjs";
import { readLlmStatus } from "./llm-status.mjs";

export const SETTINGS_VERSION = 1;
export const SETTINGS_FILE_NAME = "llm-settings.json";
export const MAX_SETTINGS_BYTES = 256 * 1024;
export const MIN_SECRET_LENGTH = 32;

const HKDF_INFO = "potongin-llm-settings-v1";
const HKDF_SALT = "potongin-settings";
const KEY_VARIABLES = new Set(Object.values(LLM_PRESETS).flatMap((preset) => preset.keyEnv));
const DASHBOARD_SECRETS = new Set(["APP_PASSWORD", "APP_SESSION_SECRET", "POTONGIN_SETTINGS_SECRET"]);
const PRIMARY_ONLY = new Set(["API_KEY", "BASE_URL", "MODEL", "FALLBACK_MODELS"]);
const OFF_VALUES = new Set(["off", "0", "false", "no", "disabled", "disable", "none"]);
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);
const NONE_VALUES = new Set(["none", "off", "-"]);
const PROVIDER_TOKEN = /^[a-z0-9-]{1,40}$/;
const INTEGER = /^[+-]?\d+$/;
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const TOP_LEVEL_INPUT = new Set(["version", "enabled", "freeOnly", "providers", "baseUpdatedAt"]);
const TOP_LEVEL_STORED = ["version", "enabled", "freeOnly", "providers", "updatedAt"];
const PROVIDER_KEYS = new Set(["provider", "enabled", "apiKey", ...Object.keys(PROVIDER_FIELDS)]);
const DISABLED_SETTINGS = Object.freeze({ version: SETTINGS_VERSION, enabled: false, freeOnly: false, providers: Object.freeze([]), updatedAt: "1970-01-01T00:00:00.000Z" });

const FIELD_LABELS = Object.freeze({
  baseUrl: "Base URL",
  model: "Model",
  fallbackModels: "Model cadangan",
  reasoningEffort: "Reasoning effort",
  contextTokens: "Konteks token",
  maxOutputTokens: "Token output maksimum",
  timeout: "Timeout",
  rpm: "Batas permintaan/menit",
  maxRetries: "Percobaan ulang",
  temperature: "Temperature",
  jsonMode: "Mode JSON",
  httpReferer: "HTTP-Referer",
  appTitle: "Judul aplikasi",
});

export const SECRET_MISSING_MESSAGE = "Kunci enkripsi pengaturan belum tersedia: set APP_SESSION_SECRET (atau POTONGIN_SETTINGS_SECRET) berisi minimal 32 karakter acak di server, bukan contoh dari .env.example.";
export const KEY_UNREADABLE_MESSAGE = "Key tersimpan tidak bisa dibuka — isi ulang";

export class LlmSettingsError extends Error {
  constructor(code, message, { issues = [] } = {}) {
    super(message);
    this.name = "LlmSettingsError";
    this.code = code;
    this.issues = issues;
  }
}

/** HTTP status for an LlmSettingsError code (routes). */
export function settingsErrorStatus(error) {
  return {
    invalid: 422, conflict: 409, exists: 409, secret_missing: 503, corrupt: 500, unreadable: 500, config: 500,
  }[error?.code] || 500;
}

function envText(env, name) {
  const value = env?.[name];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// --- Paths and secret -------------------------------------------------------------------

export function resolveSettingsPaths(env = process.env) {
  const jobsRoot = path.resolve(/* turbopackIgnore: true */ envText(env, "JOBS_ROOT") || "/data/jobs");
  const explicit = envText(env, "POTONGIN_SETTINGS_DIR");
  if (explicit !== null && !path.isAbsolute(explicit)) {
    throw new LlmSettingsError("config", "POTONGIN_SETTINGS_DIR harus berupa path absolut.");
  }
  const dir = explicit !== null ? path.resolve(/* turbopackIgnore: true */ explicit) : path.join(path.dirname(jobsRoot), "settings");
  const relative = path.relative(jobsRoot, dir);
  const outside = relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  if (!outside) {
    throw new LlmSettingsError("config", "Folder pengaturan tidak boleh berada di dalam JOBS_ROOT (isi folder itu bisa diunduh).");
  }
  return { dir, file: path.join(dir, SETTINGS_FILE_NAME) };
}

// The example value shipped in .env.example is public: sealing keys with it
// would protect nothing, so it counts as "no secret".
const PLACEHOLDER_SECRETS = new Set(["generate-a-random-secret-with-at-least-32-characters"]);

function usableSecret(value) {
  return typeof value === "string" && value.length >= MIN_SECRET_LENGTH && !PLACEHOLDER_SECRETS.has(value) ? value : null;
}

/** The secret that seals API keys, or null when none (or a too-short or placeholder one) is configured. */
export function settingsSecret(env = process.env) {
  const explicit = env?.POTONGIN_SETTINGS_SECRET;
  if (typeof explicit === "string" && explicit !== "") return usableSecret(explicit);
  return usableSecret(env?.APP_SESSION_SECRET);
}

// --- Key sealing --------------------------------------------------------------------------

function deriveKey(secret) {
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.from(HKDF_SALT), Buffer.from(HKDF_INFO), 32));
}

function associatedData(provider) {
  return Buffer.from(`${HKDF_INFO}\u0000${provider}`, "utf8");
}

function isSealedKey(box) {
  if (!isPlainObject(box) || Object.keys(box).sort().join(",") !== "ciphertext,iv,tag") return false;
  if (![box.ciphertext, box.iv, box.tag].every((value) => typeof value === "string" && BASE64.test(value))) return false;
  return box.ciphertext.length <= 8192 && Buffer.from(box.iv, "base64").length === 12 && Buffer.from(box.tag, "base64").length === 16;
}

function hasSecret(secret) {
  return typeof secret === "string" && secret.length >= MIN_SECRET_LENGTH;
}

export function encryptApiKey(value, provider, secret) {
  if (!hasSecret(secret)) throw new LlmSettingsError("secret_missing", SECRET_MISSING_MESSAGE);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(secret), iv, { authTagLength: 16 });
  cipher.setAAD(associatedData(provider));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

/** The key sealed in `box` for `provider`, or null when it cannot be opened. */
export function decryptApiKey(box, provider, secret) {
  if (!isSealedKey(box) || !hasSecret(secret)) return null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(secret), Buffer.from(box.iv, "base64"), { authTagLength: 16 });
    decipher.setAAD(associatedData(provider));
    decipher.setAuthTag(Buffer.from(box.tag, "base64"));
    const value = Buffer.concat([decipher.update(Buffer.from(box.ciphertext, "base64")), decipher.final()]).toString("utf8");
    return apiKeyProblem(value) ? null : value;
  } catch {
    return null;
  }
}

// A provider entry's key: a sealed box (stored) or { value } (transient, from
// the environment; never written to disk).
function entryKey(entry, secret) {
  const box = entry?.apiKey;
  if (!box) return { present: false, value: null };
  if (isPlainObject(box) && typeof box.value === "string") return { present: true, value: box.value };
  return { present: true, value: decryptApiKey(box, entry.provider, secret) };
}

// --- Validation ---------------------------------------------------------------------------

function fieldProblem(field, value) {
  switch (field) {
    case "baseUrl": return typeof value === "string" ? baseUrlProblem(value) : "harus berupa teks";
    case "model": return modelProblem(value);
    case "fallbackModels": {
      if (!Array.isArray(value) || value.length > MAX_FALLBACK_MODELS) return `harus berupa daftar (maks. ${MAX_FALLBACK_MODELS} model)`;
      for (const item of value) {
        const problem = typeof item === "string" ? fallbackModelProblem(item) : "harus berupa teks";
        if (problem) return problem;
      }
      return null;
    }
    case "reasoningEffort": return typeof value === "string" ? reasoningEffortProblem(value) : "harus berupa teks";
    case "jsonMode": return typeof value === "boolean" ? null : "harus true atau false";
    case "httpReferer": return httpRefererProblem(value);
    case "appTitle": return appTitleProblem(value);
    default: return numberProblem(field, value);
  }
}

function keyInput(raw, field, issues) {
  if (raw === undefined || raw === null) return { action: "keep" };
  if (!isPlainObject(raw) || Object.keys(raw).some((name) => name !== "action" && name !== "value")) {
    issues.push({ field, message: "API key harus dikirim sebagai { action, value }." });
    return null;
  }
  if (raw.action === "keep" || raw.action === "clear") {
    if (raw.value !== undefined) {
      issues.push({ field, message: "API key hanya boleh berisi nilai untuk aksi 'replace'." });
      return null;
    }
    return { action: raw.action };
  }
  if (raw.action === "replace") {
    const value = typeof raw.value === "string" ? raw.value.trim() : null;
    const problem = value === null ? "API key baru belum diisi" : apiKeyProblem(value);
    if (problem) {
      issues.push({ field, message: `${problem}.` });
      return null;
    }
    return { action: "replace", value };
  }
  issues.push({ field, message: "Aksi API key harus keep, replace, atau clear." });
  return null;
}

// Validates one provider entry. `stored` entries come from disk: strings must
// already be canonical and apiKey must be a sealed box.
function providerEntry(entry, prefix, issues, seen, { stored }) {
  if (!isPlainObject(entry)) {
    issues.push({ field: prefix, message: "Setiap penyedia harus berupa objek." });
    return null;
  }
  for (const name of Object.keys(entry)) {
    if (!PROVIDER_KEYS.has(name)) issues.push({ field: `${prefix}.${name}`, message: "Kolom tidak dikenal." });
  }
  if (!isProviderName(entry.provider)) {
    issues.push({ field: `${prefix}.provider`, message: `Penyedia harus salah satu: ${PROVIDER_NAMES.join(", ")}.` });
    return null;
  }
  if (seen.has(entry.provider)) {
    issues.push({ field: `${prefix}.provider`, message: "Penyedia ini sudah ada di daftar." });
    return null;
  }
  seen.add(entry.provider);
  if (typeof entry.enabled !== "boolean") issues.push({ field: `${prefix}.enabled`, message: "Status aktif penyedia harus true atau false." });
  const out = { provider: entry.provider, enabled: entry.enabled === true };
  for (const field of Object.keys(PROVIDER_FIELDS)) {
    let value = entry[field];
    if (!stored) {
      if (typeof value === "string") value = value.trim();
      if (field === "fallbackModels" && Array.isArray(value)) value = value.map((item) => (typeof item === "string" ? item.trim() : item));
      if (value === undefined || value === null || value === "") continue;
    } else if (value === undefined) {
      continue;
    }
    const problem = fieldProblem(field, value);
    if (problem) issues.push({ field: `${prefix}.${field}`, message: `${FIELD_LABELS[field]} ${problem}.` });
    else out[field] = field === "fallbackModels" ? [...new Set(value)] : value;
  }
  if (out.enabled && LLM_PRESETS[entry.provider].baseUrl === null) {
    const has = (field) => issues.some((issue) => issue.field === `${prefix}.${field}`);
    if (!out.baseUrl && !has("baseUrl")) issues.push({ field: `${prefix}.baseUrl`, message: "Base URL wajib diisi untuk server custom." });
    if (!out.model && !has("model")) issues.push({ field: `${prefix}.model`, message: "Model wajib diisi untuk server custom." });
  }
  let key = null;
  if (stored) {
    if (entry.apiKey !== undefined) {
      if (isSealedKey(entry.apiKey)) out.apiKey = { ciphertext: entry.apiKey.ciphertext, iv: entry.apiKey.iv, tag: entry.apiKey.tag };
      else issues.push({ field: `${prefix}.apiKey`, message: "API key tersimpan tidak dikenali." });
    }
  } else {
    key = keyInput(entry.apiKey, `${prefix}.apiKey`, issues);
  }
  return { out, key };
}

function providerList(raw, issues, options) {
  if (!Array.isArray(raw) || raw.length > PROVIDER_NAMES.length) {
    issues.push({ field: "providers", message: `Daftar penyedia harus berupa array (maks. ${PROVIDER_NAMES.length}).` });
    return [];
  }
  const seen = new Set();
  return raw.map((entry, index) => providerEntry(entry, `providers[${index}]`, issues, seen, options)).filter(Boolean);
}

export const KEY_ORIGIN_MESSAGE = "Base URL pindah ke server lain: isi ulang API key (key lama tidak dikirim ke alamat baru).";

// scheme://host:port the provider's key is sent to (the preset URL when none is set), or null.
function keyOrigin(entry) {
  const raw = entry?.baseUrl ?? LLM_PRESETS[entry?.provider]?.baseUrl ?? null;
  if (typeof raw !== "string") return null;
  try { return new URL(raw).origin; } catch { return null; }
}

/**
 * The stored document for a PUT body. `base` is the current document (or the
 * environment import when no file exists) that `keep` takes keys from.
 */
export function normalizeSettingsInput(input, { base = null, secret = null, now = new Date() } = {}) {
  if (!isPlainObject(input)) {
    throw new LlmSettingsError("invalid", "Pengaturan AI harus berupa objek JSON.", { issues: [{ field: "", message: "Harus berupa objek JSON." }] });
  }
  const issues = [];
  for (const name of Object.keys(input)) {
    if (!TOP_LEVEL_INPUT.has(name)) issues.push({ field: name, message: "Kolom tidak dikenal." });
  }
  if (input.version !== undefined && input.version !== SETTINGS_VERSION) issues.push({ field: "version", message: "Versi pengaturan tidak didukung." });
  if (input.baseUpdatedAt !== undefined && input.baseUpdatedAt !== null && typeof input.baseUpdatedAt !== "string") {
    issues.push({ field: "baseUpdatedAt", message: "Penanda versi tidak valid." });
  }
  if (typeof input.enabled !== "boolean") issues.push({ field: "enabled", message: "Aktifkan AI harus true atau false." });
  if (typeof input.freeOnly !== "boolean") issues.push({ field: "freeOnly", message: "Hanya model gratis harus true atau false." });
  const entries = providerList(input.providers, issues, { stored: false });
  if (issues.length) throw new LlmSettingsError("invalid", "Pengaturan AI belum valid.", { issues });

  const previous = new Map((base?.providers || []).map((entry) => [entry.provider, entry]));
  const keyIssues = [];
  const providers = entries.map(({ out, key }, index) => {
    let sealed = null;
    if (key.action === "replace") {
      sealed = encryptApiKey(key.value, out.provider, secret);
    } else if (key.action === "keep") {
      const before = previous.get(out.provider);
      const kept = before?.apiKey;
      // A stored key is only ever sent to the server it was entered for:
      // pointing the provider at another origin needs the key typed again, so
      // editing a URL on this page can never be used to read a key back.
      if (kept && keyOrigin(before) !== keyOrigin(out)) {
        keyIssues.push({ field: `providers[${index}].apiKey`, message: KEY_ORIGIN_MESSAGE });
      } else if (isSealedKey(kept)) {
        sealed = { ...kept };
      } else if (isPlainObject(kept) && typeof kept.value === "string") {
        sealed = encryptApiKey(kept.value, out.provider, secret);
      }
    }
    return sealed ? { ...out, apiKey: sealed } : out;
  });
  if (keyIssues.length) throw new LlmSettingsError("invalid", "Pengaturan AI belum valid.", { issues: keyIssues });
  return {
    version: SETTINGS_VERSION,
    enabled: input.enabled,
    freeOnly: input.freeOnly,
    providers,
    updatedAt: new Date(now).toISOString(),
  };
}

/** A document read from disk, validated as strictly as a new one. Throws "corrupt". */
export function validateStoredSettings(document) {
  const corrupt = (issues = []) => new LlmSettingsError("corrupt", "File pengaturan AI rusak atau tidak dikenali. Simpan ulang dari halaman Pengaturan untuk menimpanya.", { issues });
  if (!isPlainObject(document)) throw corrupt();
  const names = Object.keys(document);
  if (names.length !== TOP_LEVEL_STORED.length || !TOP_LEVEL_STORED.every((name) => names.includes(name))) throw corrupt([{ field: "", message: "Struktur tidak dikenal." }]);
  if (document.version !== SETTINGS_VERSION) throw corrupt([{ field: "version", message: "Versi tidak didukung." }]);
  const issues = [];
  if (typeof document.enabled !== "boolean") issues.push({ field: "enabled", message: "Harus boolean." });
  if (typeof document.freeOnly !== "boolean") issues.push({ field: "freeOnly", message: "Harus boolean." });
  if (typeof document.updatedAt !== "string" || !ISO_TIME.test(document.updatedAt) || Number.isNaN(Date.parse(document.updatedAt))) {
    issues.push({ field: "updatedAt", message: "Harus waktu ISO." });
  }
  const entries = providerList(document.providers, issues, { stored: true });
  if (issues.length) throw corrupt(issues);
  return {
    version: SETTINGS_VERSION,
    enabled: document.enabled,
    freeOnly: document.freeOnly,
    providers: entries.map(({ out }) => out),
    updatedAt: document.updatedAt,
  };
}

// --- Store --------------------------------------------------------------------------------

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

/** { exists, settings, file }. Throws LlmSettingsError "corrupt" / "unreadable" / "config". */
export async function readLlmSettings({ env = process.env } = {}) {
  const { file } = resolveSettingsPaths(env);
  let handle;
  try {
    handle = await open(/* turbopackIgnore: true */ file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, settings: null, file };
    if (error?.code === "ELOOP") throw new LlmSettingsError("corrupt", "File pengaturan AI tidak boleh berupa symlink.");
    throw new LlmSettingsError("unreadable", "File pengaturan AI tidak bisa dibaca (periksa izin folder pengaturan).");
  }
  let bytes;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new LlmSettingsError("corrupt", "File pengaturan AI bukan file biasa.");
    bytes = await readBounded(handle, MAX_SETTINGS_BYTES);
  } finally {
    await handle.close();
  }
  if (bytes === null) throw new LlmSettingsError("corrupt", "File pengaturan AI terlalu besar.");
  let document;
  try {
    document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new LlmSettingsError("corrupt", "File pengaturan AI rusak (bukan JSON yang valid). Simpan ulang dari halaman Pengaturan untuk menimpanya.");
  }
  return { exists: true, settings: validateStoredSettings(document), file };
}

async function writeStoredSettings(settings, env) {
  const document = validateStoredSettings(settings);
  const { dir, file } = resolveSettingsPaths(env);
  const text = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_SETTINGS_BYTES) throw new LlmSettingsError("invalid", "Pengaturan AI terlalu besar.");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory()) throw new LlmSettingsError("config", "Folder pengaturan AI bukan direktori.");
  if ((info.mode & 0o077) !== 0) await chmod(dir, 0o700);
  const temporary = path.join(dir, `.${SETTINGS_FILE_NAME}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try {
      await handle.chmod(0o600);
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  try {
    const directory = await open(dir, constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } catch {
    // Directory fsync is best effort (unsupported on some filesystems).
  }
  return document;
}

// Serializes read-modify-write cycles within this process; the rename keeps
// concurrent writers from other processes (CLI) from tearing the file.
let writeQueue = Promise.resolve();
function withWriteLock(task) {
  const result = writeQueue.then(task, task);
  writeQueue = result.catch(() => {});
  return result;
}

function importedOrNull(env) {
  try { return importFromEnv(env).settings; } catch { return null; }
}

/**
 * Validates and saves a settings PUT body. When the body carries
 * `baseUpdatedAt`, it must match the stored document's `updatedAt` (null when
 * there is none) or the save is refused with "conflict".
 */
export function saveLlmSettings(input, { env = process.env, now = new Date() } = {}) {
  return withWriteLock(async () => {
    let current = null;
    let corrupt = false;
    try {
      current = (await readLlmSettings({ env })).settings;
    } catch (error) {
      if (error?.code !== "corrupt") throw error;
      corrupt = true;
    }
    if (isPlainObject(input) && Object.hasOwn(input, "baseUpdatedAt") && !corrupt && input.baseUpdatedAt !== (current?.updatedAt ?? null)) {
      throw new LlmSettingsError("conflict", "Pengaturan AI sudah diubah di tempat lain. Muat ulang halaman, lalu ulangi perubahan Anda.");
    }
    const base = current ?? (corrupt ? null : importedOrNull(env));
    let stamp = new Date(now);
    if (current && stamp.getTime() <= Date.parse(current.updatedAt)) stamp = new Date(Date.parse(current.updatedAt) + 1);
    const settings = normalizeSettingsInput(input, { base, secret: settingsSecret(env), now: stamp });
    return writeStoredSettings(settings, env);
  });
}

/** Writes the settings file from the current environment (the one-time migration from .env). */
export function importEnvToFile({ env = process.env, sourceEnv = env, force = false, now = new Date() } = {}) {
  return withWriteLock(async () => {
    let exists;
    try {
      exists = (await readLlmSettings({ env })).exists;
    } catch (error) {
      if (error?.code !== "corrupt") throw error;
      exists = true;
    }
    if (exists && !force) throw new LlmSettingsError("exists", "Pengaturan AI sudah ada; impor dibatalkan supaya tidak menimpa.");
    const { settings, warnings } = importFromEnv(sourceEnv);
    const input = {
      enabled: settings.enabled,
      freeOnly: settings.freeOnly,
      providers: settings.providers.map(({ apiKey, ...rest }) => (apiKey ? { ...rest, apiKey: { action: "replace", value: apiKey.value } } : rest)),
    };
    const stored = await writeStoredSettings(normalizeSettingsInput(input, { secret: settingsSecret(env), now }), env);
    return { settings: stored, warnings };
  });
}

// --- Environment import -------------------------------------------------------------------

export function isLlmVariable(name) {
  return /^POTONGIN_LLM(?:_|$)/.test(name) || KEY_VARIABLES.has(name);
}

/** True when the environment carries any (non-empty) LLM variable or provider key. */
export function hasLlmEnv(env = process.env) {
  return Object.entries(env || {}).some(([name, value]) => isLlmVariable(name) && typeof value === "string" && value.trim() !== "");
}

function envError(message) {
  return new LlmSettingsError("invalid", message);
}

function parseEnvField(field, name, raw) {
  switch (field) {
    case "baseUrl": {
      const problem = baseUrlProblem(raw);
      if (problem) throw envError(`${name} ${problem}.`);
      return raw;
    }
    case "model":
      if (modelProblem(raw)) throw envError(`${name} tidak valid (ID model tanpa spasi atau koma).`);
      return raw;
    case "fallbackModels": {
      if (NONE_VALUES.has(raw.toLowerCase())) return [];
      const models = [...new Set(raw.split(",").map((part) => part.trim()).filter(Boolean))];
      if (models.length > MAX_FALLBACK_MODELS || models.some((model) => fallbackModelProblem(model))) {
        throw envError(`${name} berisi ID model yang tidak valid (ada spasi?).`);
      }
      return models;
    }
    case "reasoningEffort": {
      const value = raw.toLowerCase();
      if (!REASONING_EFFORTS.includes(value)) throw envError(`${name} harus salah satu: ${REASONING_EFFORTS.join(", ")}.`);
      return value;
    }
    case "jsonMode": {
      const value = raw.toLowerCase();
      if (TRUE_VALUES.has(value)) return true;
      if (FALSE_VALUES.has(value)) return false;
      throw envError(`${name} harus true/false (atau 1/0).`);
    }
    case "httpReferer":
    case "appTitle": {
      const problem = field === "httpReferer" ? httpRefererProblem(raw) : appTitleProblem(raw);
      if (problem) throw envError(`${name} ${problem}.`);
      return raw;
    }
    case "rpm": {
      if (OFF_VALUES.has(raw.toLowerCase())) return 0;
      if (!DECIMAL.test(raw)) throw envError(`${name} harus berupa angka.`);
      const value = Number(raw);
      if (value === 0) return 0;
      const problem = numberProblem(field, value);
      if (problem) throw envError(`${name} ${problem}.`);
      return value;
    }
    default: {
      const rule = NUMBER_RULES[field];
      if (!(rule.integer ? INTEGER : DECIMAL).test(raw)) throw envError(`${name} harus berupa ${rule.integer ? "bilangan bulat" : "angka"}.`);
      const value = Number(raw);
      const problem = numberProblem(field, value);
      if (problem) throw envError(`${name} ${problem}.`);
      return value;
    }
  }
}

// Mirrors llm.py _Settings: the scoped variable first, then the shared one
// (identity settings only for the first listed provider).
function envSetting(env, provider, suffix, primary) {
  const scoped = scopedEnvName(provider, suffix);
  const value = envText(env, scoped);
  if (value !== null) return [scoped, value];
  const shared = `POTONGIN_LLM_${suffix}`;
  if (PRIMARY_ONLY.has(suffix) && !primary) return [scoped, null];
  return [shared, envText(env, shared)];
}

function importProvider(env, provider, primary) {
  const preset = LLM_PRESETS[provider];
  const out = { provider, enabled: true };
  for (const [field, suffix] of Object.entries(PROVIDER_FIELDS)) {
    const [name, raw] = envSetting(env, provider, suffix, primary);
    if (raw !== null) out[field] = parseEnvField(field, name, raw);
  }
  let [keyName, key] = envSetting(env, provider, "API_KEY", primary);
  for (const variable of preset.keyEnv) {
    if (key !== null) break;
    key = envText(env, variable);
    keyName = variable;
  }
  if (key !== null) {
    if (apiKeyProblem(key)) throw envError(`API key untuk ${provider} (${keyName}) berisi spasi atau karakter yang tidak valid.`);
    out.apiKey = { value: key };
  }
  if (preset.baseUrl === null) {
    if (!out.baseUrl) throw envError(`Penyedia ${provider} wajib mengisi ${scopedEnvName(provider, "BASE_URL")}.`);
    if (!out.model) throw envError(`Penyedia ${provider} wajib mengisi ${scopedEnvName(provider, "MODEL")}.`);
  }
  return out;
}

/**
 * The settings the current POTONGIN_LLM_* / provider key variables describe,
 * resolved exactly like llm.py (load_llm_configs). Keys come back as
 * { value } for sealing; unknown providers are skipped with a warning.
 * Throws LlmSettingsError("invalid") naming the variable (never its value)
 * when the engine itself would reject the configuration.
 */
export function importFromEnv(env = process.env) {
  const settings = { enabled: true, freeOnly: false, providers: [] };
  const warnings = [];
  const switchValue = envText(env, "POTONGIN_LLM");
  if (switchValue !== null && OFF_VALUES.has(switchValue.toLowerCase())) settings.enabled = false;
  const freeOnly = envText(env, "POTONGIN_LLM_FREE_ONLY");
  if (freeOnly !== null) {
    const lowered = freeOnly.toLowerCase();
    if (TRUE_VALUES.has(lowered)) settings.freeOnly = true;
    else if (!FALSE_VALUES.has(lowered)) throw envError("POTONGIN_LLM_FREE_ONLY harus true/false (atau 1/0).");
  }
  let listName = "POTONGIN_LLM_PROVIDER";
  let raw = envText(env, listName);
  if (raw === null) {
    listName = "POTONGIN_LLM_PROVIDERS";
    raw = envText(env, listName);
  }
  if (raw === null) return { settings, warnings };
  const names = [...new Set(raw.split(",").map((part) => part.trim().toLowerCase().replace(/_/g, "-")).filter(Boolean))];
  if (!names.length || names.some((name) => !PROVIDER_TOKEN.test(name))) throw envError(`${listName} harus berisi nama penyedia dipisah koma.`);
  names.forEach((name, index) => {
    if (!isProviderName(name)) {
      warnings.push(`Penyedia '${name}' tidak dikenal dan dilewati.`);
      return;
    }
    settings.providers.push(importProvider(env, name, index === 0));
  });
  return { settings, warnings };
}

// --- Engine environment -------------------------------------------------------------------

/**
 * A new environment for the engine child process. With settings, every
 * inherited POTONGIN_LLM* and provider key variable is removed and the saved
 * chain is written as scoped POTONGIN_LLM_<PROVIDER>_* variables; a provider
 * whose stored key cannot be opened is left out of the chain. Without
 * settings (null), the base environment is copied unchanged.
 *
 * options.only runs exactly that provider (connection test), even when it or
 * the LLM as a whole is switched off.
 */
export function buildLlmEnv(settings, baseEnv = process.env, { only = null, secretEnv = baseEnv, includeUnreadable = false } = {}) {
  const next = { ...baseEnv };
  if (!settings) return next;
  for (const name of Object.keys(next)) {
    if (isLlmVariable(name)) delete next[name];
  }
  if (!settings.enabled && only === null) {
    next.POTONGIN_LLM = "off";
    return next;
  }
  const secret = settingsSecret(secretEnv);
  const chosen = settings.providers.filter((entry) => (only === null ? entry.enabled : entry.provider === only));
  const chain = [];
  for (const entry of chosen) {
    const key = entryKey(entry, secret);
    if (key.present && key.value === null && !includeUnreadable) continue;
    chain.push({ entry, key: key.value });
  }
  next.POTONGIN_LLM = "on";
  next.POTONGIN_LLM_FREE_ONLY = settings.freeOnly ? "1" : "0";
  if (!chain.length) return next;
  next.POTONGIN_LLM_PROVIDERS = chain.map(({ entry }) => entry.provider).join(",");
  for (const { entry, key } of chain) {
    const set = (suffix, value) => { next[scopedEnvName(entry.provider, suffix)] = String(value); };
    for (const [field, suffix] of Object.entries(PROVIDER_FIELDS)) {
      const value = entry[field];
      if (value === undefined || value === null) continue;
      if (field === "fallbackModels") set(suffix, value.length ? value.join(",") : "none");
      else if (field === "rpm") set(suffix, value === 0 ? "off" : value);
      else set(suffix, value);
    }
    if (key !== null) set("API_KEY", key);
  }
  return next;
}

/** The engine never needs the dashboard's login password or the secrets that seal keys. */
export function engineProcessEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !DASHBOARD_SECRETS.has(name)));
}

/**
 * The engine environment for a new job: the UI settings when a settings file
 * exists, else the environment unchanged. An unreadable or corrupt settings
 * file switches the LLM off (the job still runs with the heuristic selector)
 * rather than silently falling back to .env; `problem` names the reason.
 */
export async function loadLlmEnv(baseEnv = process.env, options = {}) {
  let settings;
  try {
    settings = (await readLlmSettings({ env: baseEnv })).settings;
  } catch (error) {
    const problem = error instanceof LlmSettingsError ? error.code : "unreadable";
    return { env: buildLlmEnv(DISABLED_SETTINGS, baseEnv), source: "ui", problem };
  }
  return { env: buildLlmEnv(settings, baseEnv, options), source: settings ? "ui" : "env", problem: null };
}

// --- Views --------------------------------------------------------------------------------

/** Settings as the page may see them: every value except keys, which become flags. */
export function publicSettingsView(settings, { secret = null, source = "ui" } = {}) {
  return {
    source,
    enabled: settings.enabled,
    freeOnly: settings.freeOnly,
    updatedAt: typeof settings.updatedAt === "string" ? settings.updatedAt : null,
    providers: settings.providers.map((entry) => {
      const { apiKey: _apiKey, ...fields } = entry;
      const key = entryKey(entry, secret);
      if (Array.isArray(fields.fallbackModels)) fields.fallbackModels = [...fields.fallbackModels];
      return { ...fields, apiKeySet: key.present, apiKeyUnreadable: key.present && key.value === null, source };
    }),
  };
}

const CORRUPT_STATUS = Object.freeze({
  state: "invalid", source: "ui", freeOnly: false, order: [], providers: [], problems: ["settings_unreadable"],
  label: "File pengaturan AI rusak atau tidak bisa dibaca — memakai heuristik",
});

/**
 * The dashboard badge for the configuration jobs will actually use: the UI
 * settings when a file exists, else the environment. Makes no network call.
 */
export async function readEffectiveLlmStatus(env = process.env, { read = null } = {}) {
  let result = read;
  if (!result) {
    try {
      result = await readLlmSettings({ env });
    } catch {
      return { ...CORRUPT_STATUS, providers: [], order: [], problems: [...CORRUPT_STATUS.problems] };
    }
  }
  if (!result.settings) return { ...readLlmStatus(env), source: "env" };
  const { settings } = result;
  const secret = settingsSecret(env);
  const unreadableKeys = new Set(settings.providers.filter((entry) => {
    const key = entryKey(entry, secret);
    return entry.enabled && key.present && key.value === null;
  }).map((entry) => entry.provider));
  const overlay = buildLlmEnv(settings, {}, { secretEnv: env, includeUnreadable: true });
  const status = readLlmStatus(overlay, { unreadableKeys });
  if (status.state === "disabled") return { ...status, source: "ui", label: "AI dimatikan di Pengaturan — memakai heuristik" };
  if (status.state === "unconfigured") return { ...status, source: "ui", label: "Belum ada penyedia AI yang aktif di Pengaturan — memakai heuristik" };
  return { ...status, source: "ui" };
}

function settingsErrorMessage(error) {
  return error instanceof LlmSettingsError ? error.message : "File pengaturan AI tidak bisa dibaca.";
}

/** Everything GET /api/settings/llm returns. Never includes a key value. */
export async function readLlmSettingsView(env = process.env) {
  const secret = settingsSecret(env);
  const view = {
    settings: null,
    envImportAvailable: false,
    envError: null,
    envWarnings: [],
    fileError: null,
    secretConfigured: secret !== null,
    status: null,
  };
  let read;
  try {
    read = await readLlmSettings({ env });
  } catch (error) {
    view.fileError = settingsErrorMessage(error);
    view.status = await readEffectiveLlmStatus(env);
    return view;
  }
  if (read.settings) {
    view.settings = publicSettingsView(read.settings, { secret, source: "ui" });
  } else {
    view.envImportAvailable = hasLlmEnv(env);
    try {
      const imported = importFromEnv(env);
      view.settings = publicSettingsView({ ...imported.settings, updatedAt: null }, { source: "env" });
      view.envWarnings = imported.warnings;
    } catch (error) {
      view.envError = settingsErrorMessage(error);
    }
  }
  view.status = await readEffectiveLlmStatus(env, { read });
  return view;
}

/**
 * The settings a provider action (connection test, model list) uses: the
 * saved document, or the environment import when no file exists. Keys stay
 * sealed (file) or transient (environment); resolve them with providerKey.
 */
export async function effectiveSettings(env = process.env) {
  const read = await readLlmSettings({ env });
  if (read.settings) return { settings: read.settings, source: "ui" };
  return { settings: { ...importFromEnv(env).settings, updatedAt: null }, source: "env" };
}

/** { present, value } for one provider entry; value is null when the key cannot be opened. */
export function providerKey(entry, env = process.env) {
  return entryKey(entry, settingsSecret(env));
}
