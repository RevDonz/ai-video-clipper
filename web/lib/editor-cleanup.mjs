// GET /api/jobs/:id/clips/:clipId/cleanup — the Rapikan review list (plan §4.2, §7.3; T3.5).
//
// The list is `python -m ai_clipper.edit_v2.cleanup` op `list` over the clip's current words
// artifact: fillers, repeats and gaps with the fields `ApplyCleanup` takes (CONTRACTS §5.17), no
// LLM. It is immutable per (words sha, lexicon digest), so the answer carries that pair as its
// ETag and a matching If-None-Match gets 304 (`private, no-cache`: the bare URL follows the
// current document, whose words change after "Mulai dari versi AI").
//
// Same prologue as every editor route (clip-edit.mjs): session, POTONGIN_EDITOR_V3, ids by regex
// before anything is spawned; Python only through web/lib/python-cli.mjs (allowlisted env, no LLM
// variables); fixed error codes; the CLI output passes a whitelist, so no path or text of the
// server reaches the browser.
import { createHash } from "node:crypto";

import { apiFailure, callCli, editorDeps, editorError, editorResponse, guard, isClipId, isJobId } from "./clip-edit.mjs";

export const CLEANUP_MODULE = "ai_clipper.edit_v2.cleanup";
export const CLEANUP_TIMEOUT_MS = 20_000;
export const MAX_CLEANUP_BYTES = 4 * 1024 * 1024;
const SCHEMA = "potongin.cleanup/1";
const ITEM_ID = /^[a-z]{2,3}_[0-9a-z]{1,16}$/;
const WORD_ID = /^w[0-9]{6,7}$/;
const SHA = /^[0-9a-f]{64}$/;
const CLIP_ID = /^clip_[0-9a-f]{24}$/;
const VERSION = /^[a-z0-9.+-]{1,80}$/;
const MISSING = new Set(["audio_timeline", "sound_events"]);
const MAX_ITEMS = 5000;
const MAX_ITEM_WORDS = 400;

const isInt = (value) => Number.isSafeInteger(value) && value >= 0;

function wordIds(value) {
  return Array.isArray(value) && value.length >= 1 && value.length <= MAX_ITEM_WORDS
    && value.every((id) => typeof id === "string" && WORD_ID.test(id)) ? [...value] : null;
}

function span(value) {
  return isInt(value.s) && isInt(value.e) && value.s <= value.e;
}

/** One review item reduced to its DTO fields, or null when it is malformed. */
function sanitizeItem(value) {
  if (!value || typeof value !== "object" || typeof value.id !== "string" || !ITEM_ID.test(value.id)) return null;
  if (!span(value) || typeof value.defaultOn !== "boolean") return null;
  const base = { id: value.id, kind: value.kind };
  if (value.kind === "filler" || value.kind === "repeat") {
    const ids = wordIds(value.wordIds);
    if (!ids) return null;
    const item = { ...base, wordIds: ids };
    if (value.kind === "repeat") {
      const kept = wordIds(value.repeatOf);
      if (!kept) return null;
      item.repeatOf = kept;
    }
    return { ...item, s: value.s, e: value.e, defaultOn: value.defaultOn };
  }
  if (value.kind !== "gap_silent" && value.kind !== "gap_voiced") return null;
  if (!WORD_ID.test(value.afterWord ?? "") || !WORD_ID.test(value.beforeWord ?? "")) return null;
  const item = { ...base, afterWord: value.afterWord, beforeWord: value.beforeWord, s: value.s, e: value.e };
  if (value.kind === "gap_silent") {
    if (!isInt(value.inSf) || !isInt(value.outSf) || value.inSf >= value.outSf) return null;
    return { ...item, inSf: value.inSf, outSf: value.outSf, defaultOn: value.defaultOn };
  }
  return { ...item, defaultOn: false, applicable: false };
}

const LOCK_REASONS = new Set(["laughter", "no_quiet_cut"]);

function sanitizeLocked(value) {
  if (!value || typeof value !== "object" || !LOCK_REASONS.has(value.reason) || !span(value)) return null;
  if (!["filler", "repeat", "gap"].includes(value.kind)) return null;
  const entry = { kind: value.kind, reason: value.reason, s: value.s, e: value.e };
  if (value.kind === "gap") {
    if (!WORD_ID.test(value.afterWord ?? "")) return null;
    entry.afterWord = value.afterWord;
  } else {
    const ids = wordIds(value.wordIds);
    if (!ids) return null;
    entry.wordIds = ids;
  }
  return entry;
}

/** The CLI result reduced to the route's DTO, or null when anything is malformed. */
export function sanitizeCleanup(json) {
  if (!json || typeof json !== "object" || json.schema !== SCHEMA) return null;
  if (!CLIP_ID.test(json.clipId ?? "") || !SHA.test(json.wordsSha256 ?? "")) return null;
  const lexicon = json.lexicon;
  if (!lexicon || !VERSION.test(lexicon.version ?? "") || !SHA.test(lexicon.sha256 ?? "")) return null;
  if (typeof json.fillerPrecheck !== "boolean" || !Array.isArray(json.missing) || !json.missing.every((name) => MISSING.has(name))) return null;
  if (!Array.isArray(json.items) || json.items.length > MAX_ITEMS || !Array.isArray(json.locked) || json.locked.length > MAX_ITEMS) return null;
  const items = json.items.map(sanitizeItem);
  const locked = json.locked.map(sanitizeLocked);
  if (items.includes(null) || locked.includes(null)) return null;
  if (new Set(items.map((item) => item.id)).size !== items.length) return null;
  return {
    schema: SCHEMA, clipId: json.clipId, wordsSha256: json.wordsSha256,
    lexicon: { version: lexicon.version, sha256: lexicon.sha256 },
    fillerPrecheck: json.fillerPrecheck, missing: [...json.missing], items, locked,
  };
}

/** The ETag of a list: its schema, words sha and lexicon digest (the list is a function of them). */
export function cleanupEtag(dto) {
  return createHash("sha256").update(`${SCHEMA}\0${dto.wordsSha256}\0${dto.lexicon.sha256}`).digest("hex");
}

function etagMatches(request, etag) {
  const header = request.headers.get("if-none-match");
  if (!header) return false;
  return header.split(",").map((item) => item.trim().replace(/^W\//, "")).includes(`"${etag}"`);
}

export function createCleanupRoute(options = {}) {
  const deps = editorDeps(options);
  return {
    async GET(request, { params }) {
      const checked = await guard(request, params, deps, { ids: { id: isJobId, clipId: isClipId } });
      if (checked.denied) return checked.denied;
      if ([...new URL(request.url).searchParams.keys()].length) return editorError("invalid_request", 400);
      const { id: jobId, clipId } = checked.params;
      const result = await callCli(deps, CLEANUP_MODULE, "list", { jobId, clipId },
        { timeoutMs: CLEANUP_TIMEOUT_MS, maxStdoutBytes: MAX_CLEANUP_BYTES });
      if (result?.exitCode !== 0) return apiFailure(result);
      const dto = sanitizeCleanup(result.json);
      if (!dto || dto.clipId !== clipId) return editorError("backend_unavailable", 503);
      const etag = cleanupEtag(dto);
      const headers = { ETag: `"${etag}"`, "Cache-Control": "private, no-cache" };
      if (etagMatches(request, etag)) {
        return new Response(null, { status: 304, headers: { ...headers, "X-Content-Type-Options": "nosniff" } });
      }
      return editorResponse(dto, 200, headers);
    },
  };
}
