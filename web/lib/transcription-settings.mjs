// Pengaturan "Transkripsi": the opt-in switch that sends the audio of a video without usable YouTube
// subtitles to Groq's hosted Whisper (src/ai_clipper/transcribe_groq.py); local Whisper stays
// the fallback. Off by default, because the audio goes to a third party.
//
//   GET /api/settings/transcription   transcriptionView (never a key)
//   PUT /api/settings/transcription   {enabled, apiKey?: {action: "keep" | "replace" | "clear", value?}}
//
// File: <settings>/transcription.json beside llm-settings.json, 0600 in a 0700 directory, written
// atomically. Its own key is sealed with the LLM settings' secret and scheme (encryptApiKey),
// bound to its own label. The key a job uses: a Groq key saved in Pengaturan AI for api.groq.com
// (or, without a settings file, one from the environment), else the key saved here. The worker
// hands it to the engine as POTONGIN_TRANSCRIBE_GROQ_API_KEY, never in argv or a log line.
import crypto from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";

import { requireAuth } from "./auth.mjs";
import { HttpBodyError, guardRequest, noStore, readJsonBody } from "./llm-settings-http.mjs";
import { LLM_PRESETS, apiKeyProblem } from "./llm-presets.mjs";
import {
  decryptApiKey,
  effectiveSettings,
  encryptApiKey,
  providerKey,
  resolveSettingsPaths,
  settingsSecret,
} from "./llm-settings.mjs";
import { sameOriginMutation } from "./request-security.mjs";

export const TRANSCRIPTION_FILE = "transcription.json";
export const TRANSCRIPTION_SCHEMA = "potongin.transcription/1";
export const GROQ_SWITCH_ENV = "POTONGIN_TRANSCRIBE_GROQ";
export const GROQ_KEY_ENV = "POTONGIN_TRANSCRIBE_GROQ_API_KEY";
export const MAX_TRANSCRIPTION_BODY_BYTES = 8 * 1024;

const KEY_LABEL = "transcription:groq";
const GROQ_ORIGIN = new URL(LLM_PRESETS.groq.baseUrl).origin;
const MAX_STORE_BYTES = 64 * 1024;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const INPUT_FIELDS = new Set(["enabled", "apiKey"]);

const MESSAGES = Object.freeze({
  invalid: "Pengaturan transkripsi belum valid.",
  secret_missing: "Kunci enkripsi pengaturan belum tersedia di server.",
  settings_unavailable: "Folder pengaturan di server belum bisa dipakai.",
});
const STATUS = Object.freeze({ invalid: 422, secret_missing: 503, settings_unavailable: 503 });

export class TranscriptionSettingsError extends Error {
  constructor(code, message = MESSAGES[code]) {
    super(message);
    this.name = "TranscriptionSettingsError";
    this.code = code;
  }
}

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function isSealedBox(box) {
  return isPlainObject(box) && Object.keys(box).sort().join(",") === "ciphertext,iv,tag"
    && [box.ciphertext, box.iv, box.tag].every((value) => typeof value === "string" && BASE64.test(value));
}

// --- Store --------------------------------------------------------------------------------

function storeFile(env) {
  try {
    const { dir } = resolveSettingsPaths(env);
    return { dir, file: path.join(dir, TRANSCRIPTION_FILE) };
  } catch {
    throw new TranscriptionSettingsError("settings_unavailable");
  }
}

function validDocument(document) {
  if (!isPlainObject(document) || document.schema !== TRANSCRIPTION_SCHEMA || typeof document.groq !== "boolean") return null;
  if (typeof document.updatedAt !== "string" || !ISO_TIME.test(document.updatedAt)) return null;
  const known = new Set(["schema", "groq", "apiKey", "updatedAt"]);
  if (Object.keys(document).some((name) => !known.has(name))) return null;
  if (document.apiKey !== undefined && !isSealedBox(document.apiKey)) return null;
  return { groq: document.groq, apiKey: document.apiKey ?? null, updatedAt: document.updatedAt };
}

// {state: "none"} | {state: "corrupt"} | {state: "ok", settings: {groq, apiKey, updatedAt}}
async function readStore(env) {
  const { file } = storeFile(env);
  let handle;
  try {
    handle = await open(/* turbopackIgnore: true */ file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "none" };
    if (error?.code === "ELOOP") return { state: "corrupt" };
    throw new TranscriptionSettingsError("settings_unavailable");
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_STORE_BYTES) return { state: "corrupt" };
    let document;
    try { document = JSON.parse((await handle.readFile()).toString("utf8")); } catch { return { state: "corrupt" }; }
    const settings = validDocument(document);
    return settings ? { state: "ok", settings } : { state: "corrupt" };
  } finally {
    await handle.close().catch(() => {});
  }
}

async function writeStore(env, document) {
  const { dir, file } = storeFile(env);
  const temporary = path.join(dir, `.${TRANSCRIPTION_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await mkdir(/* turbopackIgnore: true */ dir, { recursive: true, mode: 0o700 });
    const info = await lstat(/* turbopackIgnore: true */ dir);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("not a directory");
    if ((info.mode & 0o077) !== 0) await chmod(/* turbopackIgnore: true */ dir, 0o700);
    const handle = await open(/* turbopackIgnore: true */ temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(`${JSON.stringify(document)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(/* turbopackIgnore: true */ temporary, file);
  } catch {
    await rm(/* turbopackIgnore: true */ temporary, { force: true }).catch(() => {});
    throw new TranscriptionSettingsError("settings_unavailable");
  }
}

// One change at a time in this process (the web app is one process).
const LOCK = Symbol.for("potongin.transcriptionSettingsLock");

function locked(task) {
  const previous = globalThis[LOCK] ?? Promise.resolve();
  const run = previous.then(task, task);
  globalThis[LOCK] = run.catch(() => {});
  return run;
}

// --- Keys ---------------------------------------------------------------------------------

// The Groq entry of Pengaturan AI (or of the environment without a settings file), only when its
// key goes to api.groq.com: a key entered for another server is never sent elsewhere.
async function llmGroqKey(env) {
  let settings;
  try { ({ settings } = await effectiveSettings(env)); } catch { return { state: "none" }; }
  const entry = settings.providers.find((item) => item.provider === "groq");
  if (!entry?.apiKey) return { state: "none" };
  let origin = null;
  try { origin = new URL(entry.baseUrl ?? LLM_PRESETS.groq.baseUrl).origin; } catch { /* not a URL */ }
  if (origin !== GROQ_ORIGIN) return { state: "none" };
  const key = providerKey(entry, env);
  if (!key.present) return { state: "none" };
  return key.value === null ? { state: "unreadable" } : { state: "ready", value: key.value };
}

function ownKey(settings, env) {
  if (!settings?.apiKey) return { state: "none" };
  const value = decryptApiKey(settings.apiKey, KEY_LABEL, settingsSecret(env));
  return value === null ? { state: "unreadable" } : { state: "ready", value };
}

// {source: "llm" | "own" | "missing" | "unreadable", value, llm, own}
async function resolveKey(env, settings) {
  const llm = await llmGroqKey(env);
  const own = ownKey(settings, env);
  if (llm.state === "ready") return { source: "llm", value: llm.value, llm, own };
  if (own.state === "ready") return { source: "own", value: own.value, llm, own };
  const unreadable = own.state === "unreadable" || llm.state === "unreadable";
  return { source: unreadable ? "unreadable" : "missing", value: null, llm, own };
}

// --- Views and saving ---------------------------------------------------------------------

async function viewOf(env, stored) {
  const settings = stored.state === "ok" ? stored.settings : null;
  const key = await resolveKey(env, settings);
  return {
    enabled: settings?.groq === true,
    key: key.source,
    ownKey: key.own.state !== "none",
    llmKey: key.llm.state === "ready",
    secretConfigured: settingsSecret(env) !== null,
    updatedAt: settings?.updatedAt ?? null,
    problem: stored.state === "corrupt" ? "corrupt" : null,
  };
}

/** What the card may see: the switch and where the key comes from, never a key. */
export async function readTranscriptionView(env = process.env) {
  return viewOf(env, await readStore(env));
}

function parseInput(input) {
  if (!isPlainObject(input) || typeof input.enabled !== "boolean" || Object.keys(input).some((name) => !INPUT_FIELDS.has(name))) {
    throw new TranscriptionSettingsError("invalid");
  }
  const raw = input.apiKey ?? { action: "keep" };
  if (!isPlainObject(raw) || Object.keys(raw).some((name) => name !== "action" && name !== "value")) {
    throw new TranscriptionSettingsError("invalid");
  }
  if (raw.action === "keep" || raw.action === "clear") {
    if (raw.value !== undefined) throw new TranscriptionSettingsError("invalid");
    return { enabled: input.enabled, key: { action: raw.action } };
  }
  if (raw.action !== "replace" || typeof raw.value !== "string") throw new TranscriptionSettingsError("invalid");
  const value = raw.value.trim();
  const problem = apiKeyProblem(value);
  if (problem) throw new TranscriptionSettingsError("invalid", `${problem}.`);
  return { enabled: input.enabled, key: { action: "replace", value } };
}

/** Validates and saves a PUT body; the answer is the new view. A broken file is overwritten. */
export async function saveTranscriptionSettings(input, { env = process.env, now = new Date() } = {}) {
  const change = parseInput(input);
  return locked(async () => {
    const stored = await readStore(env);
    const before = stored.state === "ok" ? stored.settings : null;
    let apiKey = null;
    if (change.key.action === "replace") {
      const secret = settingsSecret(env);
      if (secret === null) throw new TranscriptionSettingsError("secret_missing");
      apiKey = encryptApiKey(change.key.value, KEY_LABEL, secret);
    } else if (change.key.action === "keep") {
      apiKey = before?.apiKey ?? null;
    }
    const document = { schema: TRANSCRIPTION_SCHEMA, groq: change.enabled, ...(apiKey ? { apiKey } : {}), updatedAt: new Date(now).toISOString() };
    await writeStore(env, document);
    return viewOf(env, { state: "ok", settings: validDocument(document) });
  });
}

// --- The engine's environment -------------------------------------------------------------

/**
 * `engineEnv` with the Groq switch and key the saved settings call for (read with `sourceEnv`,
 * which holds the settings folder and secret), and never inherited ones. Problems are logged by
 * reason only; the job then runs with local Whisper.
 */
export async function transcriptionEngineEnv(engineEnv, sourceEnv = engineEnv, { log = console.warn } = {}) {
  const next = { ...engineEnv };
  delete next[GROQ_SWITCH_ENV];
  delete next[GROQ_KEY_ENV];
  let stored;
  try {
    stored = await readStore(sourceEnv);
  } catch {
    log("Pengaturan transkripsi tidak bisa dibaca; Whisper lokal dipakai.");
    return next;
  }
  if (stored.state === "corrupt") log("File pengaturan transkripsi rusak; Whisper lokal dipakai.");
  if (stored.state !== "ok" || !stored.settings.groq) return next;
  next[GROQ_SWITCH_ENV] = "on";
  const key = await resolveKey(sourceEnv, stored.settings);
  if (key.value) next[GROQ_KEY_ENV] = key.value;
  else log(`Transkripsi Groq menyala, tetapi API key Groq ${key.source === "unreadable" ? "tidak bisa dibuka" : "belum ada"}; Whisper lokal dipakai.`);
  return next;
}

// --- Route --------------------------------------------------------------------------------

function refusal(error) {
  if (error instanceof HttpBodyError) return noStore({ error: error.message, code: "bad_request" }, error.status);
  if (error instanceof TranscriptionSettingsError) return noStore({ error: error.message, code: error.code }, STATUS[error.code] ?? 500);
  return noStore({ error: "Pengaturan transkripsi gagal disimpan.", code: "internal" }, 500);
}

export function createTranscriptionSettingsRoute({ authorize = requireAuth, env = process.env, sameOrigin = sameOriginMutation, now = () => new Date() } = {}) {
  return {
    async GET(request) {
      const denied = guardRequest(request, { authorize });
      if (denied) return denied;
      try {
        return noStore(await readTranscriptionView(env));
      } catch (error) {
        return refusal(error);
      }
    },
    async PUT(request) {
      const denied = guardRequest(request, { authorize, sameOrigin, mutation: true });
      if (denied) return denied;
      try {
        const input = await readJsonBody(request, { maxBytes: MAX_TRANSCRIPTION_BODY_BYTES });
        return noStore(await saveTranscriptionSettings(input, { env, now: now() }));
      } catch (error) {
        return refusal(error);
      }
    },
  };
}
