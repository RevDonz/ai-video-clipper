// Pengaturan "Cookies YouTube": one cookies.txt, checked (youtube-cookies-file.mjs) and sealed in
// the settings directory, that the worker hands yt-dlp for a YouTube download.
//
//   GET    /api/settings/youtube-cookies   {cookies: {count, signedIn, uploadedAt} | null, problem, secretConfigured}
//   POST   /api/settings/youtube-cookies   the raw file (text/plain), at most 1 MB; same answer plus `skipped`
//   DELETE /api/settings/youtube-cookies
//
// Sealed like the LLM keys (llm-settings.mjs): AES-256-GCM under a key derived (HKDF-SHA256) from
// POTONGIN_SETTINGS_SECRET or APP_SESSION_SECRET, with its own HKDF info and associated data.
// File: <settings>/youtube-cookies.json, 0600 in a 0700 directory, written atomically. A cookie
// value never reaches a response, a log line or an error message. The worker opens the file
// for one job and writes a 0600 copy into a private 0700 temporary folder, which it deletes
// when the downloads end, failed or not; a copy left by a runner that died is removed by the
// next one. web/proxy.js does not run in front of this route: every method checks the session
// itself, mutations their origin.
import crypto from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { requireAuth } from "./auth.mjs";
import { resolveSettingsPaths, settingsSecret } from "./llm-settings.mjs";
import { sameOriginMutation } from "./request-security.mjs";
import { CookiesFileError, MAX_COOKIES_FILE_BYTES, parseCookiesFile } from "./youtube-cookies-file.mjs";

export const YOUTUBE_COOKIES_FILE = "youtube-cookies.json";
export const YOUTUBE_COOKIES_SCHEMA = "potongin.youtube-cookies/1";
export const COOKIES_COPY_PREFIX = "potongin-yt-cookies-";

const HKDF_SALT = "potongin-settings";
const HKDF_INFO = "potongin-youtube-cookies-v1";
const MAX_STORE_BYTES = 512 * 1024;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const COPY_NAME = new RegExp(`^${COOKIES_COPY_PREFIX}(\\d+)-[A-Za-z0-9]+$`);
const TEXT_TYPES = /^(?:text\/plain|application\/octet-stream)(?:\s*;|$)/i;

const MESSAGES = Object.freeze({
  cookies_empty: "File ini tidak berisi cookie.",
  cookies_too_large: "File terlalu besar. Maksimal 1 MB.",
  cookies_utf16: "File ini tersimpan sebagai UTF-16. Simpan ulang sebagai UTF-8.",
  cookies_not_text: "File ini bukan teks.",
  cookies_json: "File ini berformat JSON, bukan cookies.txt.",
  cookies_not_netscape: "Isinya bukan cookies.txt format Netscape.",
  cookies_no_youtube: "Tidak ada cookie YouTube di file ini.",
  cookies_expired: "Semua cookie YouTube di file ini sudah kedaluwarsa.",
  unsupported_media_type: "Kirim file cookies.txt sebagai teks.",
  secret_missing: "Kunci enkripsi pengaturan belum tersedia di server.",
  settings_unavailable: "Folder pengaturan di server belum bisa dipakai.",
  csrf_rejected: "Origin permintaan tidak diizinkan.",
  invalid_request: "Permintaan tidak valid.",
});

export class YoutubeCookiesError extends Error {
  constructor(code) {
    super(MESSAGES[code] ?? code);
    this.name = "YoutubeCookiesError";
    this.code = code;
  }
}

// --- Sealing ------------------------------------------------------------------------------

function deriveKey(secret) {
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.from(HKDF_SALT), Buffer.from(HKDF_INFO), 32));
}

function seal(text, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(secret), iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(HKDF_INFO, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

function unseal(box, secret) {
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(secret), Buffer.from(box.iv, "base64"), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(HKDF_INFO, "utf8"));
    decipher.setAuthTag(Buffer.from(box.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(box.ciphertext, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// --- Store --------------------------------------------------------------------------------

function storePaths(env) {
  try {
    const { dir } = resolveSettingsPaths(env);
    return { dir, file: path.join(dir, YOUTUBE_COOKIES_FILE) };
  } catch {
    throw new YoutubeCookiesError("settings_unavailable");
  }
}

function validDocument(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) return null;
  const { schema, count, signedIn, uploadedAt, sealed } = document;
  if (schema !== YOUTUBE_COOKIES_SCHEMA || !Number.isSafeInteger(count) || count < 1 || typeof signedIn !== "boolean") return null;
  if (typeof uploadedAt !== "string" || !ISO_TIME.test(uploadedAt)) return null;
  if (!sealed || typeof sealed !== "object" || Object.keys(sealed).sort().join(",") !== "ciphertext,iv,tag") return null;
  if (![sealed.ciphertext, sealed.iv, sealed.tag].every((value) => typeof value === "string" && BASE64.test(value))) return null;
  if (Buffer.from(sealed.iv, "base64").length !== 12 || Buffer.from(sealed.tag, "base64").length !== 16) return null;
  return { cookies: { count, signedIn, uploadedAt }, sealed };
}

// {state: "none"} | {state: "corrupt"} | {state: "ok", cookies, sealed}
async function readStore(env) {
  const { file } = storePaths(env);
  let handle;
  try {
    handle = await open(/* turbopackIgnore: true */ file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "none" };
    if (error?.code === "ELOOP") return { state: "corrupt" };
    throw new YoutubeCookiesError("settings_unavailable");
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_STORE_BYTES) return { state: "corrupt" };
    let document;
    try { document = JSON.parse((await handle.readFile()).toString("utf8")); } catch { return { state: "corrupt" }; }
    const valid = validDocument(document);
    return valid ? { state: "ok", ...valid } : { state: "corrupt" };
  } finally {
    await handle.close().catch(() => {});
  }
}

async function settingsDirectory(dir) {
  try {
    await mkdir(/* turbopackIgnore: true */ dir, { recursive: true, mode: 0o700 });
    const info = await lstat(/* turbopackIgnore: true */ dir);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("not a directory");
    if ((info.mode & 0o077) !== 0) await chmod(/* turbopackIgnore: true */ dir, 0o700);
  } catch {
    throw new YoutubeCookiesError("settings_unavailable");
  }
}

async function writeStore(env, document) {
  const { dir, file } = storePaths(env);
  await settingsDirectory(dir);
  const temporary = path.join(dir, `.${YOUTUBE_COOKIES_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
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
    throw new YoutubeCookiesError("settings_unavailable");
  }
  try {
    const directory = await open(/* turbopackIgnore: true */ dir, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await directory.sync(); } finally { await directory.close(); }
  } catch { /* best effort */ }
}

// One change at a time in this process (the web app is one process).
const LOCK = Symbol.for("potongin.youtubeCookiesLock");

function locked(task) {
  const previous = globalThis[LOCK] ?? Promise.resolve();
  const run = previous.then(task, task);
  globalThis[LOCK] = run.catch(() => {});
  return run;
}

/** What the page may see: counts and dates, never a cookie. */
export async function readYoutubeCookiesStatus(env = process.env) {
  const secret = settingsSecret(env);
  const stored = await readStore(env);
  const base = { cookies: null, problem: null, secretConfigured: secret !== null };
  if (stored.state === "none") return base;
  if (stored.state === "corrupt") return { ...base, problem: "corrupt" };
  if (secret === null) return { ...base, cookies: stored.cookies, problem: "secret_missing" };
  return { ...base, cookies: stored.cookies, problem: unseal(stored.sealed, secret) === null ? "unreadable" : null };
}

/**
 * Checks and seals an uploaded file, replacing the stored one. `{cookies, skipped}`; throws
 * CookiesFileError (the file) or YoutubeCookiesError (secret_missing, settings_unavailable).
 */
export async function saveYoutubeCookies(bytes, { env = process.env, now = new Date() } = {}) {
  const secret = settingsSecret(env);
  if (secret === null) throw new YoutubeCookiesError("secret_missing");
  const checked = parseCookiesFile(bytes, { now: now.getTime() });
  const cookies = { count: checked.count, signedIn: checked.signedIn, uploadedAt: now.toISOString() };
  await locked(() => writeStore(env, { schema: YOUTUBE_COOKIES_SCHEMA, ...cookies, sealed: seal(checked.text, secret) }));
  return { cookies, skipped: checked.skipped };
}

export async function removeYoutubeCookies(env = process.env) {
  const { file } = storePaths(env);
  await locked(async () => {
    try {
      await rm(/* turbopackIgnore: true */ file, { force: true });
    } catch {
      throw new YoutubeCookiesError("settings_unavailable");
    }
  });
}

/** `{state: "ok", text}` (the Netscape file), or `{state}`: none, corrupt, unreadable, secret_missing, unavailable. */
export async function openYoutubeCookies(env = process.env) {
  let stored;
  try { stored = await readStore(env); } catch { return { state: "unavailable" }; }
  if (stored.state !== "ok") return { state: stored.state };
  const secret = settingsSecret(env);
  if (secret === null) return { state: "secret_missing" };
  const text = unseal(stored.sealed, secret);
  return text === null ? { state: "unreadable" } : { state: "ok", text };
}

// --- The copy for yt-dlp ------------------------------------------------------------------

function processGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

// Folders of runners that no longer exist (killed before their cleanup ran).
async function sweepStaleCopies(tmpDir) {
  let names;
  try { names = await readdir(/* turbopackIgnore: true */ tmpDir); } catch { return; }
  for (const name of names) {
    const match = COPY_NAME.exec(name);
    if (!match || Number(match[1]) === process.pid || !processGone(Number(match[1]))) continue;
    const target = path.join(tmpDir, name);
    try {
      const info = await lstat(/* turbopackIgnore: true */ target);
      if (info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid?.()) await rm(/* turbopackIgnore: true */ target, { recursive: true, force: true });
    } catch { /* gone already */ }
  }
}

/**
 * A 0600 copy of the stored cookies for this job's yt-dlp runs: `{file, dispose}`, or null when
 * none are stored or they cannot be opened (logged by reason, never by content).
 */
export async function prepareYoutubeCookies(env = process.env, { tmpDir = os.tmpdir(), log = console.warn } = {}) {
  const opened = await openYoutubeCookies(env);
  if (opened.state === "none") return null;
  if (opened.state !== "ok") {
    log(`Cookies YouTube dilewati (${opened.state}); unduhan berjalan tanpa cookies.`);
    return null;
  }
  await sweepStaleCopies(tmpDir);
  let folder = null;
  try {
    folder = await mkdtemp(/* turbopackIgnore: true */ path.join(tmpDir, `${COOKIES_COPY_PREFIX}${process.pid}-`));
    await chmod(/* turbopackIgnore: true */ folder, 0o700);
    const file = path.join(folder, "cookies.txt");
    const handle = await open(/* turbopackIgnore: true */ file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(opened.text, "utf8");
    } finally {
      await handle.close();
    }
    const target = folder;
    return { file, dispose: () => rm(/* turbopackIgnore: true */ target, { recursive: true, force: true }).catch(() => {}) };
  } catch (error) {
    if (folder) await rm(/* turbopackIgnore: true */ folder, { recursive: true, force: true }).catch(() => {});
    log(`Cookies YouTube dilewati (${error?.code || "copy_failed"}); unduhan berjalan tanpa cookies.`);
    return null;
  }
}

// --- Route --------------------------------------------------------------------------------

function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

function refusal(code, status) {
  return json({ error: MESSAGES[code] ?? "Cookies gagal disimpan.", code }, status);
}

// The body, or null when it grows past `limit` (the reader is then cancelled).
async function readBody(request, limit) {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value?.byteLength ?? 0;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { reader.releaseLock(); } catch { /* released */ }
  }
  return Buffer.concat(chunks, total);
}

export function createYoutubeCookiesRoute({ authorize = requireAuth, env = process.env, now = () => new Date(), sameOrigin = sameOriginMutation } = {}) {
  async function status() {
    try { return json(await readYoutubeCookiesStatus(env)); } catch { return refusal("settings_unavailable", 503); }
  }

  return {
    async GET(request) {
      const denied = authorize(request);
      if (denied) return denied;
      return status();
    },

    async DELETE(request) {
      const denied = authorize(request);
      if (denied) return denied;
      if (!sameOrigin(request)) return refusal("csrf_rejected", 403);
      try { await removeYoutubeCookies(env); } catch { return refusal("settings_unavailable", 503); }
      return status();
    },

    async POST(request) {
      const denied = authorize(request);
      if (denied) return denied;
      if (!sameOrigin(request)) return refusal("csrf_rejected", 403);
      if (!TEXT_TYPES.test(request.headers.get("content-type") ?? "")) return refusal("unsupported_media_type", 415);
      const declared = request.headers.get("content-length");
      if (declared !== null && (!/^\d{1,15}$/.test(declared) || Number(declared) > MAX_COOKIES_FILE_BYTES)) return refusal("cookies_too_large", 413);
      if (settingsSecret(env) === null) return refusal("secret_missing", 503);
      let bytes;
      try { bytes = await readBody(request, MAX_COOKIES_FILE_BYTES); } catch { return refusal("invalid_request", 400); }
      if (bytes === null) return refusal("cookies_too_large", 413);
      try {
        const saved = await saveYoutubeCookies(bytes, { env, now: now() });
        return json({ ...saved, problem: null, secretConfigured: true });
      } catch (error) {
        if (error instanceof CookiesFileError) return refusal(error.code, error.code === "cookies_too_large" ? 413 : 422);
        if (error instanceof YoutubeCookiesError && error.code === "secret_missing") return refusal("secret_missing", 503);
        return refusal("settings_unavailable", 503);
      }
    },
  };
}
