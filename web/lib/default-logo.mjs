// Pengaturan "Logo bawaan" (plan 2026-10-20 A6): one logo in the settings directory that the
// seeds of every new job's clips carry (edit_v2.seed), replaceable per clip in the editor.
//
//   GET    /api/settings/logo         {logo: DTO | null, enabled, autoClips}
//   POST   /api/settings/logo         raw body, the transport of POST /api/jobs/:id/assets (logo)
//   DELETE /api/settings/logo         jobs created earlier keep their copy
//   GET    /api/settings/logo/:sha    the normalised PNG of the current logo
//
// web/proxy.js does not run in front of /api/settings/logo (it would buffer the body at 10 MB):
// every method checks the session itself, mutations their origin. The editor's own ingest
// (edit_v2.assets) normalises the upload in a scratch job under <dir>/.work/, so the PNG and its
// metadata are byte for byte what a job's asset store holds. Files, 0600 in a 0700 directory:
// <settings>/default-logo/{current.json, <sha>.png, <sha>.json}. snapshotDefaultLogo copies the
// pair into <job>/logo/ when a job is created; that copy is what its clips seed.
import { randomUUID as nodeRandomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";

import {
  ASSET_KINDS,
  ASSET_MODULE,
  INGEST_TIMEOUT_MS,
  MAX_DRAIN_BYTES,
  UploadRequestError,
  assetDirectories,
  drain,
  ingestGate,
  parseUploadRequest,
  streamToQuarantine,
  uploadError,
  uploadsEnabled,
  validAsset,
} from "./asset-upload.mjs";
import { callCli, editorDeps, isEditorEnabled } from "./clip-edit.mjs";
import { IMMUTABLE, openedFileResponse } from "./clip-media.mjs";
import { readEditorFlags } from "./editor/flags.mjs";
import { resolveSettingsPaths } from "./llm-settings.mjs";
import { sharedEditorRateLimits } from "./rate-limit.mjs";
import { sameOriginMutation } from "./request-security.mjs";
import { sessionTokenOf } from "./security-headers.mjs";

export const DEFAULT_LOGO_DIR = "default-logo";
export const DEFAULT_LOGO_SCHEMA = "potongin.default-logo/1";
const CURRENT_FILE = "current.json";
const WORK_DIR = ".work";
const JOB_LOGO_DIR = "logo"; // edit_v2.assets.JOB_LOGO_DIR
const MAX_PNG_BYTES = 8 * 1024 * 1024; // edit_v2.assets.MAX_LOGO_PNG_BYTES
const MAX_JSON_BYTES = 64 * 1024;
const SHA = /^[0-9a-f]{64}$/;
const SERVED_HEADERS = { "Content-Security-Policy": "default-src 'none'; sandbox" };
const SETTINGS_UNAVAILABLE = "Folder pengaturan di server belum bisa dipakai";

class Unavailable extends Error {}

function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

function unavailable() {
  return json({ error: SETTINGS_UNAVAILABLE, code: "settings_unavailable", messageId: "edit.settings_unavailable" }, 503);
}

/** Uploads need the editor and its uploads (the ingest is theirs). */
export function defaultLogoEnabled(env = process.env) {
  return isEditorEnabled(env) && uploadsEnabled(env);
}

function settingsDir(env) {
  try {
    return resolveSettingsPaths(env).dir;
  } catch {
    throw new Unavailable();
  }
}

// A directory that exists (created 0700 on request), is no symlink and resolves to itself.
async function realDirectory(target, { create = false } = {}) {
  if (create) {
    try { await mkdir(/* turbopackIgnore: true */ target, { recursive: true, mode: 0o700 }); } catch { throw new Unavailable(); }
  }
  let info;
  try { info = await lstat(/* turbopackIgnore: true */ target); } catch { throw new Unavailable(); }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Unavailable();
  if (await realpath(/* turbopackIgnore: true */ target).catch(() => null) !== target) throw new Unavailable();
  if (create && (info.mode & 0o077) !== 0) await chmod(/* turbopackIgnore: true */ target, 0o700).catch(() => {});
  return target;
}

// <settings>/default-logo, or null when it does not exist yet and `create` is false.
async function logoDirectory(env, { create = false } = {}) {
  const settings = settingsDir(env);
  if (create) {
    try { await mkdir(/* turbopackIgnore: true */ settings, { recursive: true, mode: 0o700 }); } catch { throw new Unavailable(); }
  }
  let root;
  try { root = await realpath(/* turbopackIgnore: true */ settings); } catch {
    if (create) throw new Unavailable();
    return null;
  }
  const target = path.join(root, DEFAULT_LOGO_DIR);
  if (!create) {
    try { await lstat(/* turbopackIgnore: true */ target); } catch { return null; }
  }
  return realDirectory(target, { create });
}

async function readSmall(target, limit) {
  let handle;
  try {
    handle = await open(/* turbopackIgnore: true */ target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) return null;
    return { bytes: await handle.readFile(), size: info.size };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function parse(bytes) {
  try { return JSON.parse(bytes.toString("utf8")); } catch { return null; }
}

/** The current logo `{sha256, w, h, name, updatedAtMs}`, or null (none, or not intact). */
async function readCurrent(directory) {
  const current = await readSmall(path.join(directory, CURRENT_FILE), MAX_JSON_BYTES);
  const pointer = current && parse(current.bytes);
  if (pointer?.schema !== DEFAULT_LOGO_SCHEMA || !SHA.test(pointer.sha256 ?? "") || !Number.isSafeInteger(pointer.updatedAtMs)) return null;
  const meta = await readSmall(path.join(directory, `${pointer.sha256}.json`), MAX_JSON_BYTES);
  const value = meta && parse(meta.bytes);
  const side = (item) => Number.isSafeInteger(item) && item >= 1 && item <= 1024;
  if (value?.kind !== "image" || value.mime !== "image/png" || !side(value.w) || !side(value.h)) return null;
  let png;
  try { png = await lstat(/* turbopackIgnore: true */ path.join(directory, `${pointer.sha256}.png`)); } catch { return null; }
  if (!png.isFile() || png.size !== value.bytes || png.size > MAX_PNG_BYTES) return null;
  return { sha256: pointer.sha256, w: value.w, h: value.h, name: typeof value.name === "string" ? value.name : null, updatedAtMs: pointer.updatedAtMs };
}

/** The current default logo, or null; never throws. */
export async function readDefaultLogo(env = process.env) {
  try {
    const directory = await logoDirectory(env);
    return directory ? await readCurrent(directory) : null;
  } catch {
    return null;
  }
}

/** The DTO of a logo: the asset upload's shape plus its URL and when it was set. */
export function defaultLogoDto(logo) {
  return {
    sha256: logo.sha256, kind: "logo", mime: "image/png", w: logo.w, h: logo.h, durationMs: null, lufsC: null,
    name: logo.name, peaksUrl: null, url: `/api/settings/logo/${logo.sha256}`, updatedAtMs: logo.updatedAtMs,
  };
}

function stateBody(logo, env) {
  return { logo: logo ? defaultLogoDto(logo) : null, enabled: defaultLogoEnabled(env), autoClips: readEditorFlags(env).renderEngine === "edit-v2" };
}

// One change at a time in this process (the web app is one process): an upload's install, a
// removal and a job's copy never see half of another.
const LOCK = Symbol.for("potongin.defaultLogoLock");

function locked(task) {
  const previous = globalThis[LOCK] ?? Promise.resolve();
  const run = previous.then(task, task);
  globalThis[LOCK] = run.catch(() => {});
  return run;
}

async function syncDirectory(directory) {
  try {
    const handle = await open(/* turbopackIgnore: true */ directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await handle.sync(); } finally { await handle.close(); }
  } catch { /* best effort */ }
}

async function writeNew(target, bytes) {
  const handle = await open(/* turbopackIgnore: true */ target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeCurrent(directory, value) {
  const temporary = path.join(directory, `.${CURRENT_FILE}.${nodeRandomUUID()}.tmp`);
  try {
    await writeNew(temporary, Buffer.from(`${JSON.stringify(value)}\n`));
    await rename(/* turbopackIgnore: true */ temporary, path.join(directory, CURRENT_FILE));
  } catch (error) {
    await unlink(/* turbopackIgnore: true */ temporary).catch(() => {});
    throw error;
  }
  await syncDirectory(directory);
}

// Every <sha>.png/.json but `keep`'s, and stale temporaries.
async function prune(directory, keep) {
  for (const name of await readdir(/* turbopackIgnore: true */ directory)) {
    const match = /^([0-9a-f]{64})\.(png|json)$/.exec(name);
    if ((match && match[1] !== keep) || /^\.current\.json\..+\.tmp$/.test(name)) {
      await unlink(/* turbopackIgnore: true */ path.join(directory, name)).catch(() => {});
    }
  }
}

/** Removes the default logo; jobs created earlier keep their copy. */
export async function removeDefaultLogo(env = process.env) {
  const directory = await logoDirectory(env);
  if (!directory) return;
  await locked(async () => {
    await unlink(/* turbopackIgnore: true */ path.join(directory, CURRENT_FILE)).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    await prune(directory, null);
    await syncDirectory(directory);
  });
}

/**
 * Copies the current logo into `<jobRoot>/logo/` (0700, files 0600) for a job being created;
 * true when it did. Never throws: a job without the copy simply seeds no logo.
 */
export async function snapshotDefaultLogo(jobRoot, env = process.env) {
  const target = path.join(jobRoot, JOB_LOGO_DIR);
  let made = false;
  try {
    const directory = await logoDirectory(env);
    if (!directory) return false;
    return await locked(async () => {
      const logo = await readCurrent(directory);
      if (!logo) return false;
      const png = await readSmall(path.join(directory, `${logo.sha256}.png`), MAX_PNG_BYTES);
      const meta = await readSmall(path.join(directory, `${logo.sha256}.json`), MAX_JSON_BYTES);
      if (!png || !meta) return false;
      await mkdir(/* turbopackIgnore: true */ target, { mode: 0o700 });
      made = true;
      await writeNew(path.join(target, `${logo.sha256}.png`), png.bytes);
      await writeNew(path.join(target, `${logo.sha256}.json`), meta.bytes);
      await syncDirectory(target);
      return true;
    });
  } catch {
    if (made) await rm(/* turbopackIgnore: true */ target, { recursive: true, force: true }).catch(() => {});
    return false;
  }
}

// Moves the ingest's pair into the logo directory and makes it current.
async function install(directory, store, asset, now) {
  return locked(async () => {
    for (const extension of ["png", "json"]) {
      const name = `${asset.sha256}.${extension}`;
      const info = await lstat(/* turbopackIgnore: true */ path.join(store, name));
      if (!info.isFile()) throw new Unavailable();
      await rename(/* turbopackIgnore: true */ path.join(store, name), path.join(directory, name));
    }
    const logo = { sha256: asset.sha256, w: asset.w, h: asset.h, name: asset.name ?? null, updatedAtMs: now() };
    await writeCurrent(directory, { schema: DEFAULT_LOGO_SCHEMA, sha256: logo.sha256, updatedAtMs: logo.updatedAtMs });
    await prune(directory, logo.sha256);
    if (!await readCurrent(directory)) throw new Unavailable();
    return logo;
  });
}

const EXIT3_STATUS = Object.freeze({ asset_type_unsupported: 415, asset_too_large: 413, asset_rejected: 422 });
const REASONS = new Set(["empty", "dimensions", "streams", "codec", "probe", "decode", "timeout"]);

function ingestFailure(result) {
  if (result?.exitCode === 3) {
    const code = result.json?.error?.code;
    const known = Object.hasOwn(EXIT3_STATUS, code) ? code : "asset_rejected";
    const ref = result.json?.error?.ref;
    return uploadError(known, EXIT3_STATUS[known], known === "asset_rejected" && REASONS.has(ref) ? { reason: ref } : {});
  }
  return uploadError("backend_unavailable", 503);
}

export function createDefaultLogoRoute(options = {}) {
  const deps = editorDeps(options);
  const limits = options.limits ?? sharedEditorRateLimits();
  const randomUUID = options.randomUUID ?? nodeRandomUUID;
  const gate = options.gate ?? ingestGate();
  const now = options.now ?? Date.now;

  return {
    async GET(request) {
      const denied = deps.authorize(request);
      if (denied) return denied;
      return json(stateBody(await readDefaultLogo(deps.env), deps.env));
    },

    async DELETE(request) {
      const denied = deps.authorize(request);
      if (denied) return denied;
      if (!sameOriginMutation(request)) return uploadError("csrf_rejected", 403);
      try { await removeDefaultLogo(deps.env); } catch { return unavailable(); }
      return json(stateBody(null, deps.env));
    },

    async POST(request) {
      const denied = deps.authorize(request);
      if (denied) return denied;
      if (!defaultLogoEnabled(deps.env)) return uploadError("uploads_disabled", 404);
      if (!sameOriginMutation(request)) return uploadError("csrf_rejected", 403);
      const verdict = limits.check("upload", { sessionToken: sessionTokenOf(request) || "anonymous" });
      if (!verdict.allowed) {
        return uploadError("rate_limited", 429, {}, { "Retry-After": String(Math.max(1, Math.ceil(verdict.retryAfterMs / 1000))) });
      }
      // A signed-in page of this origin from here on: a refusal reads the declared body first,
      // so the browser gets the answer instead of a reset connection.
      const declared = request.headers.get("content-length");
      const drainable = /^\d{1,15}$/.test(declared ?? "") && Number(declared) <= MAX_DRAIN_BYTES ? Number(declared) : 0;
      const refused = async (response) => {
        await drain(request, drainable);
        return response;
      };
      let upload;
      try { upload = parseUploadRequest(request.headers); } catch (error) {
        return refused(error instanceof UploadRequestError ? uploadError(error.code, error.status) : uploadError("invalid_request", 400));
      }
      if (upload.kind !== "logo") return refused(uploadError("asset_type_unsupported", 415));

      let directory;
      let workRoot;
      try {
        directory = await logoDirectory(deps.env, { create: true });
        workRoot = await realDirectory(path.join(directory, WORK_DIR), { create: true });
      } catch {
        return refused(unavailable());
      }
      const workId = randomUUID();
      const work = path.join(workRoot, workId);
      try {
        let store;
        let incoming;
        try {
          await mkdir(/* turbopackIgnore: true */ path.join(work, "analysis"), { recursive: true, mode: 0o700 });
          ({ store, incoming } = await assetDirectories(workRoot, workId, { create: true }));
        } catch {
          return refused(unavailable());
        }
        const incomingId = randomUUID();
        try {
          await streamToQuarantine(request, path.join(incoming, incomingId), { length: upload.length, format: upload.format, maxBytes: ASSET_KINDS.logo.maxBytes });
        } catch (error) {
          return error instanceof UploadRequestError ? uploadError(error.code, error.status) : uploadError("invalid_request", 400);
        }
        const ingestDeps = { ...deps, runCli: editorDeps({ ...options, env: { ...deps.env, JOBS_ROOT: workRoot } }).runCli };
        const result = await gate(() => callCli(ingestDeps, ASSET_MODULE, "ingest", {
          jobId: workId, incomingId, kind: "logo", mime: upload.mime, name: upload.name, idempotencyKey: upload.idempotencyKey,
        }, { timeoutMs: INGEST_TIMEOUT_MS.logo }));
        if (result?.exitCode !== 0) return ingestFailure(result);
        const asset = result.json?.asset;
        if (!validAsset(asset, "logo")) return uploadError("backend_unavailable", 503);
        let logo;
        try { logo = await install(directory, store, asset, now); } catch { return unavailable(); }
        return json(defaultLogoDto(logo), 201);
      } finally {
        await rm(/* turbopackIgnore: true */ work, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}

function notFound() {
  return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Type": "text/plain; charset=utf-8" } });
}

export function createDefaultLogoFileRoute(options = {}) {
  const deps = editorDeps(options);

  async function serve(request, { params }, head) {
    const denied = deps.authorize(request);
    if (denied) return denied;
    const sha = (await params)?.sha;
    if (typeof sha !== "string" || !SHA.test(sha)) return uploadError("invalid_request", 400);
    let opened;
    try {
      const directory = await logoDirectory(deps.env);
      const logo = directory ? await readCurrent(directory) : null;
      if (!logo || logo.sha256 !== sha) return notFound();
      const handle = await open(/* turbopackIgnore: true */ path.join(directory, `${sha}.png`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await handle.stat();
      if (!info.isFile()) {
        await handle.close();
        return notFound();
      }
      opened = { handle, size: info.size };
    } catch {
      return notFound();
    }
    return openedFileResponse(request, opened, {
      type: "image/png", cacheControl: IMMUTABLE, head,
      extraHeaders: { ...SERVED_HEADERS, "Content-Disposition": 'inline; filename="logo.png"', ETag: `"${sha}"` },
    });
  }

  return {
    GET: (request, context) => serve(request, context, false),
    HEAD: (request, context) => serve(request, context, true),
  };
}
