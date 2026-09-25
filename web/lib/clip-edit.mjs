// Editor V3 routes for clips, the edit document and the words artifact (plan §4.2, §4.4, §9.1).
//
//   GET  /api/jobs/:id/clips                     V3 clips of the job (+ the latest export)
//   POST /api/jobs/:id/clips                     job-level prepare (api prepare_job), 202
//   GET  /api/jobs/:id/clips/:clipId/edit        current document or the seed (?seed=1)
//   PUT  /api/jobs/:id/clips/:clipId/edit        save (If-Match, Idempotency-Key, ≤ 1 MiB)
//   GET  /api/jobs/:id/clips/:clipId/words       words artifact (?sha=<64 hex>: immutable)
//
// Every route: session (requireAuth), then the POTONGIN_EDITOR_V3 flag (404 editor_disabled
// while off), ids by regex before anything is spawned, mutations same-origin only
// (sameOriginMutation) with streamed and counted bodies. Python is reached only through
// web/lib/python-cli.mjs (allowlisted env, E11); errors map to fixed codes with Indonesian
// messages and never echo a path, a stderr line or user text. Handlers are built by factories so
// the tests can inject the session check, the environment and the CLI runner.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import { requireAuth } from "./auth.mjs";
import { PythonCliError, runPythonCli } from "./python-cli.mjs";
import { sameOriginMutation } from "./request-security.mjs";

export const EDIT_API_MODULE = "ai_clipper.edit_v2.api";
export const MAX_DOC_BODY_BYTES = 1 << 20;
export const MAX_SMALL_BODY_BYTES = 1024;
export const MAX_WORDS_BYTES = 32 << 20;
const PREPARE_TIMEOUT_MS = 10 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLIP_ID = /^clip_[0-9a-f]{24}$/;
const SHA = /^[0-9a-f]{64}$/;
const CLIP_REASONS = new Set(["needs_prepare", "source_missing", "selection_unreadable", "transcript_missing",
  "analysis_incomplete", "not_v3"]);
const ENGINES = new Set(["edit-v2/1", "legacy"]);

export const MESSAGES = Object.freeze({
  invalid_request: "Permintaan tidak valid",
  csrf_rejected: "Origin permintaan tidak diizinkan",
  editor_disabled: "Editor V3 belum diaktifkan",
  not_found: "Data tidak ditemukan",
  payload_too_large: "Permintaan terlalu besar",
  precondition_required: "If-Match wajib diisi",
  backend_unavailable: "Layanan editor tidak tersedia",
  revision_conflict: "Klip ini diubah di tab lain",
  idempotency_conflict: "Permintaan simpan ganda dengan isi yang berbeda",
  analysis_missing: "Analisis klip belum siap",
  schema_too_new: "Dokumen ini dibuat versi editor yang lebih baru; muat ulang editor",
  document_invalid: "Dokumen edit tidak valid",
  source_missing: "Video sumber sudah tidak ada",
});

export function isEditorEnabled(env = process.env) {
  return env?.POTONGIN_EDITOR_V3 === "on";
}
export function isJobId(value) { return typeof value === "string" && UUID.test(value); }
export function isClipId(value) { return typeof value === "string" && CLIP_ID.test(value); }
export function isEtag(value) { return typeof value === "string" && SHA.test(value); }
export function isIdempotencyKey(value) { return typeof value === "string" && UUID.test(value); }

/** A JSON response of the editor routes: no-store and nosniff, plus `headers`. */
export function editorResponse(body, status = 200, headers = {}) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers },
  });
}

/** `{error, code}` with the fixed Indonesian message of `code` (or `message`). */
export function editorError(code, status, extra = {}, headers = {}) {
  return editorResponse({ error: MESSAGES[code] ?? MESSAGES.invalid_request, code, ...extra }, status, headers);
}

export class BodyTooLargeError extends Error {}
export class BodyInvalidError extends Error {}

/** Stream and count a request body; `allowEmpty` returns an empty Uint8Array for no body. */
export async function readBoundedBody(request, maximum, { allowEmpty = false } = {}) {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared))) throw new BodyInvalidError();
  if (declared !== null && Number(declared) > maximum) throw new BodyTooLargeError();
  if (!request.body) {
    if (allowEmpty) return new Uint8Array(0);
    throw new BodyInvalidError();
  }
  if (request.bodyUsed) throw new BodyInvalidError();
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      let item;
      try { item = await reader.read(); } catch { throw new BodyInvalidError(); }
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) throw new BodyInvalidError();
      total += item.value.byteLength;
      if (total > maximum) {
        try { await reader.cancel(); } catch { /* the stream is abandoned */ }
        throw new BodyTooLargeError();
      }
      chunks.push(item.value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  if (total === 0 && !allowEmpty) throw new BodyInvalidError();
  const raw = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
  return raw;
}

export function isJsonRequest(request) {
  return /^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "");
}

/** The shared prologue: session, flag, ids. Returns `{denied}` or the resolved params. */
export async function guard(request, params, deps, { ids, mutation = false }) {
  const denied = deps.authorize(request);
  if (denied) return { denied };
  if (!isEditorEnabled(deps.env)) return { denied: editorError("editor_disabled", 404) };
  if (mutation && !sameOriginMutation(request)) return { denied: editorError("csrf_rejected", 403) };
  const resolved = await params;
  for (const [name, check] of Object.entries(ids)) {
    if (!check(resolved?.[name])) return { denied: editorError("invalid_request", 400) };
  }
  return { params: resolved };
}

/** Default dependencies: requireAuth, process.env and runPythonCli. */
export function editorDeps(deps = {}) {
  const env = deps.env ?? process.env;
  const runner = deps.runCli ?? runPythonCli;
  return {
    ...deps,
    authorize: deps.authorize ?? requireAuth,
    env,
    jobsRoot: deps.jobsRoot ?? (env.JOBS_ROOT || "/data/jobs"),
    runCli: (module, op, payload, options = {}) => runner(module, op, payload, {
      env, ...(deps.pythonBin ? { pythonBin: deps.pythonBin } : {}), ...options,
    }),
  };
}

/** Run a CLI op; `{exitCode, json}`, or `null` for a spawn/protocol failure (→ 503). */
export async function callCli(deps, module, op, payload, options) {
  try {
    const result = await deps.runCli(module, op, payload, options);
    if (!result || !Number.isInteger(result.exitCode) || !result.json || typeof result.json !== "object") return null;
    return result;
  } catch (error) {
    if (error instanceof PythonCliError) return null;
    return null;
  }
}

function errorCode(json, fallback) {
  const code = json?.error?.code;
  return typeof code === "string" && /^[a-z_]{1,40}$/.test(code) ? code : fallback;
}

function issues(json) {
  const list = Array.isArray(json?.errors) ? json.errors : [];
  const clean = [];
  for (const item of list.slice(0, 200)) {
    if (!item || typeof item !== "object" || typeof item.code !== "string") continue;
    const issue = { code: item.code, path: typeof item.path === "string" ? item.path : null };
    if (typeof item.ref === "string") issue.ref = item.ref;
    if (Number.isInteger(item.f)) issue.f = item.f;
    clean.push(issue);
  }
  if (clean.length === 0 && json?.error) {
    clean.push({ code: errorCode(json, "invalid_json"), path: typeof json.error.path === "string" ? json.error.path : "" });
  }
  return clean;
}

/** The HTTP answer for a failed api op (CONTRACTS §5.3 exit codes). */
export function apiFailure(result) {
  if (result === null) return editorError("backend_unavailable", 503);
  const { exitCode, json } = result;
  if (exitCode === 3 || exitCode === 6) {
    const code = errorCode(json, exitCode === 3 ? "invalid_json" : "range_invalid");
    return editorResponse({ error: MESSAGES.document_invalid, code, errors: issues(json) }, 422);
  }
  if (exitCode === 4) {
    const code = errorCode(json, "not_found") === "source_missing" ? "source_missing" : "not_found";
    return editorError(code, 404);
  }
  if (exitCode === 5) {
    const extra = {};
    const headers = {};
    if (json.current && typeof json.current === "object") extra.current = json.current;
    if (isEtag(json.etag)) { extra.etag = json.etag; headers.ETag = `"${json.etag}"`; }
    return editorError("revision_conflict", 409, extra, headers);
  }
  if (exitCode === 7) return editorError("schema_too_new", 426);
  if (exitCode === 8) return editorError("analysis_missing", 409);
  if (exitCode === 9) return editorError("idempotency_conflict", 409);
  return editorError("backend_unavailable", 503);
}

// --- GET/POST /clips ---------------------------------------------------------------------------

function textOrNull(value) {
  return typeof value === "string" ? value : null;
}

/** A clips-listing entry reduced to the §4.2 contract fields (no path ever leaves the server). */
export function sanitizeClip(entry, latestRender = null) {
  const edit = entry?.edit && typeof entry.edit === "object"
    && ["seed", "edited"].includes(entry.edit.state) && Number.isInteger(entry.edit.revision) && isEtag(entry.edit.etag)
    ? { state: entry.edit.state, revision: entry.edit.revision, etag: entry.edit.etag,
      updatedAtMs: Number.isInteger(entry.edit.updatedAtMs) ? entry.edit.updatedAtMs : null }
    : null;
  return {
    clipId: isClipId(entry?.clipId) ? entry.clipId : null,
    index: Number.isInteger(entry?.index) && entry.index >= 1 ? entry.index : null,
    title: textOrNull(entry?.title),
    hookText: textOrNull(entry?.hookText),
    description: textOrNull(entry?.description),
    hashtags: Array.isArray(entry?.hashtags) ? entry.hashtags.filter((tag) => typeof tag === "string").slice(0, 50) : [],
    durationMs: Number.isInteger(entry?.durationMs) && entry.durationMs >= 0 ? entry.durationMs : null,
    engine: ENGINES.has(entry?.engine) ? entry.engine : null,
    edit,
    latestRender,
    openable: entry?.openable === true,
    reason: CLIP_REASONS.has(entry?.reason) ? entry.reason : null,
  };
}

export function createClipsRoute(options = {}) {
  const deps = editorDeps(options);
  const latest = options.latestRenders ?? (async (jobId) => {
    const { latestRenders } = await import("./clip-renders.mjs");
    return latestRenders(jobId, deps.jobsRoot);
  });
  return {
    async GET(request, { params }) {
      const checked = await guard(request, params, deps, { ids: { id: isJobId } });
      if (checked.denied) return checked.denied;
      const jobId = checked.params.id;
      const result = await callCli(deps, EDIT_API_MODULE, "clips", { jobId });
      if (result?.exitCode !== 0) return apiFailure(result);
      if (!Array.isArray(result.json.clips)) return apiFailure(null);
      let renders = new Map();
      try { renders = await latest(jobId); } catch { renders = new Map(); }
      const clips = result.json.clips.map((entry) => sanitizeClip(entry,
        isClipId(entry?.clipId) ? renders.get(entry.clipId) ?? null : null));
      return editorResponse({ clips });
    },
    async POST(request, { params }) {
      const checked = await guard(request, params, deps, { ids: { id: isJobId }, mutation: true });
      if (checked.denied) return checked.denied;
      let raw;
      try { raw = await readBoundedBody(request, MAX_SMALL_BODY_BYTES, { allowEmpty: true }); } catch (error) {
        return error instanceof BodyTooLargeError ? editorError("payload_too_large", 413) : editorError("invalid_request", 400);
      }
      const text = Buffer.from(raw).toString("utf8");
      if (text.trim() !== "" && !/^\s*\{\s*\}\s*$/.test(text)) return editorError("invalid_request", 400);
      const jobId = checked.params.id;
      const result = await callCli(deps, EDIT_API_MODULE, "prepare_job", { jobId }, { timeoutMs: PREPARE_TIMEOUT_MS });
      if (result?.exitCode !== 0) return apiFailure(result);
      const clips = Array.isArray(result.json.clips) ? result.json.clips.map((clip) => ({
        clipId: isClipId(clip?.clipId) ? clip.clipId : null,
        index: Number.isInteger(clip?.index) ? clip.index : null,
        openable: clip?.openable === true,
        reason: CLIP_REASONS.has(clip?.reason) ? clip.reason : null,
      })) : [];
      return editorResponse({ state: result.json.state === "done" ? "done" : "pending", clips }, 202);
    },
  };
}

// --- GET/PUT /clips/:clipId/edit -----------------------------------------------------------------

/** `If-Match`: `"<etag>"` or a bare etag; null when absent; throws for anything else. */
export function parseIfMatch(value) {
  if (value === null || value === undefined) return null;
  const match = /^(?:"([0-9a-f]{64})"|([0-9a-f]{64}))$/.exec(value.trim());
  if (!match) throw new BodyInvalidError();
  return match[1] ?? match[2];
}

function wordsUrl(jobId, clipId, sha) {
  return `/api/jobs/${jobId}/clips/${clipId}/words${isEtag(sha) ? `?sha=${sha}` : ""}`;
}

function editBody(jobId, clipId, json) {
  return {
    doc: json.doc,
    etag: json.etag,
    seed: json.isSeed === true,
    seedEtag: isEtag(json.seedEtag) ? json.seedEtag : null,
    engine: ENGINES.has(json.engine) ? json.engine : null,
    notices: Array.isArray(json.notices) ? json.notices.filter((notice) => typeof notice === "string") : [],
    words: { sha256: isEtag(json.words?.sha256) ? json.words.sha256 : null,
      url: wordsUrl(jobId, clipId, json.words?.sha256) },
    readOnly: json.readOnly === true,
    readOnlyReason: typeof json.readOnlyReason === "string" ? json.readOnlyReason : null,
  };
}

export function createEditRoute(options = {}) {
  const deps = editorDeps(options);
  const ids = { id: isJobId, clipId: isClipId };
  return {
    async GET(request, { params }) {
      const checked = await guard(request, params, deps, { ids });
      if (checked.denied) return checked.denied;
      const query = new URL(request.url).searchParams;
      const keys = [...query.keys()];
      if (keys.length > 1 || (keys.length === 1 && (keys[0] !== "seed" || query.get("seed") !== "1"))) {
        return editorError("invalid_request", 400);
      }
      const { id: jobId, clipId } = checked.params;
      const result = await callCli(deps, EDIT_API_MODULE, keys.length ? "seed" : "get", { jobId, clipId });
      if (result?.exitCode !== 0) return apiFailure(result);
      if (!isEtag(result.json.etag) || !result.json.doc) return apiFailure(null);
      const headers = { ETag: `"${result.json.etag}"` };
      if (result.json.isSeed === true) headers["X-Edit-Seed"] = "1";
      return editorResponse(editBody(jobId, clipId, result.json), 200, headers);
    },
    async PUT(request, { params }) {
      const checked = await guard(request, params, deps, { ids, mutation: true });
      if (checked.denied) return checked.denied;
      let expectedEtag;
      try { expectedEtag = parseIfMatch(request.headers.get("if-match")); } catch {
        return editorError("invalid_request", 400);
      }
      if (expectedEtag === null) return editorError("precondition_required", 428);
      const idempotencyKey = request.headers.get("idempotency-key");
      if (!isIdempotencyKey(idempotencyKey) || !isJsonRequest(request)) return editorError("invalid_request", 400);
      let raw;
      try { raw = await readBoundedBody(request, MAX_DOC_BODY_BYTES); } catch (error) {
        return error instanceof BodyTooLargeError ? editorError("payload_too_large", 413) : editorError("invalid_request", 400);
      }
      const { id: jobId, clipId } = checked.params;
      const result = await callCli(deps, EDIT_API_MODULE, "put", {
        jobId, clipId, expectedEtag, idempotencyKey, docRaw: Buffer.from(raw).toString("base64"),
      });
      if (result?.exitCode !== 0) return apiFailure(result);
      if (!isEtag(result.json.etag)) return apiFailure(null);
      return editorResponse({ doc: result.json.doc, etag: result.json.etag,
        warnings: Array.isArray(result.json.warnings) ? result.json.warnings : [] }, 200, { ETag: `"${result.json.etag}"` });
    },
  };
}

// --- GET /clips/:clipId/words ----------------------------------------------------------------------

class WordsNotFoundError extends Error {}

async function realDirectory(target) {
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(target) !== target) throw new WordsNotFoundError();
}

/** The words artifact `words.<sha16>.json` of a clip whose bytes hash to `sha` (no symlink). */
export async function readWordsArtifact(jobsRoot, jobId, clipId, sha) {
  if (!isJobId(jobId) || !isClipId(clipId) || !isEtag(sha)) throw new WordsNotFoundError();
  let handle;
  try {
    const root = await realpath(path.resolve(jobsRoot));
    const job = path.join(root, jobId);
    const clip = path.join(job, "analysis", "clips", clipId);
    for (const directory of [job, path.join(job, "analysis"), path.join(job, "analysis", "clips"), clip]) {
      await realDirectory(directory);
    }
    handle = await open(path.join(clip, `words.${sha.slice(0, 16)}.json`),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_WORDS_BYTES) throw new WordsNotFoundError();
    const raw = await handle.readFile();
    if (raw.length > MAX_WORDS_BYTES || createHash("sha256").update(raw).digest("hex") !== sha) throw new WordsNotFoundError();
    return raw;
  } catch {
    throw new WordsNotFoundError();
  } finally {
    await handle?.close().catch(() => {});
  }
}

function etagMatches(request, sha) {
  const header = request.headers.get("if-none-match");
  if (!header) return false;
  return header.split(",").map((item) => item.trim().replace(/^W\//, "")).includes(`"${sha}"`);
}

export function createWordsRoute(options = {}) {
  const deps = editorDeps(options);
  return {
    async GET(request, { params }) {
      const checked = await guard(request, params, deps, { ids: { id: isJobId, clipId: isClipId } });
      if (checked.denied) return checked.denied;
      const query = new URL(request.url).searchParams;
      const keys = [...query.keys()];
      if (keys.length > 1 || (keys.length === 1 && (keys[0] !== "sha" || !isEtag(query.get("sha"))))) {
        return editorError("invalid_request", 400);
      }
      const { id: jobId, clipId } = checked.params;
      let sha = query.get("sha");
      const pinned = sha !== null;
      if (!pinned) {
        const result = await callCli(deps, EDIT_API_MODULE, "get", { jobId, clipId });
        if (result?.exitCode !== 0) return apiFailure(result);
        sha = result.json.words?.sha256;
        if (!isEtag(sha)) return apiFailure(null);
      }
      const headers = {
        ETag: `"${sha}"`,
        "Cache-Control": pinned ? "private, max-age=31536000, immutable" : "private, no-cache",
        "X-Content-Type-Options": "nosniff",
      };
      if (etagMatches(request, sha)) return new Response(null, { status: 304, headers });
      let raw;
      try { raw = await readWordsArtifact(deps.jobsRoot, jobId, clipId, sha); } catch {
        return editorError("not_found", 404);
      }
      return new Response(raw, { status: 200, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });
    },
  };
}
