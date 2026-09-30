// GET /api/jobs/:id/clips/:clipId/coldopen-suggestions (plan §4.2, §7.2; T3.7): the cold-open
// candidates of `python -m ai_clipper.edit_v2.coldopen list` for the clip's revision 0.
//
// The same prologue as every editor route (clip-edit.mjs `guard`: session, the editor flag, ids
// by regex before anything runs); Python only through web/lib/python-cli.mjs (allowlisted env,
// E11). The answer depends only on the clip's immutable seed and words artifact, so one app
// process keeps it in memory (MEMO_TTL_MS, at most MEMO_SIZE clips) and answers repeats and
// If-None-Match without a new process. The CLI's output is re-checked field by field: only
// well-formed candidates with the known keys leave the server.
import { createHash } from "node:crypto";

import { apiFailure, callCli, editorDeps, editorError, guard, isClipId, isJobId } from "./clip-edit.mjs";

export const COLDOPEN_MODULE = "ai_clipper.edit_v2.coldopen";
export const MEMO_TTL_MS = 10 * 60_000;
export const MEMO_SIZE = 64;
export const MAX_CANDIDATES = 5;
const TIMEOUT_MS = 15_000;
const MAX_STDOUT_BYTES = 256 * 1024;
const MAX_TEXT = 400;
const MAX_REASON = 120;
const SHA = /^[0-9a-f]{64}$/;
const ID = /^co_[1-9][0-9]{0,2}$/;
const WORD = /^w[0-9]{6,7}$/;
const UNIT = /^S[0-9]{4,}$/;
const SOURCES = new Set(["selection", "hook", "strong"]);

const count = (value) => Number.isSafeInteger(value) && value >= 0;

/** One candidate reduced to the route's keys, or null when any field is malformed. */
export function sanitizeCandidate(value) {
  if (!value || typeof value !== "object") return null;
  const { id, source, firstWord, lastWord, inSf, outSf, frames, durMs, unitIds, text, question, laughTail, reason } = value;
  if (typeof id !== "string" || !ID.test(id) || !SOURCES.has(source)) return null;
  if (typeof firstWord !== "string" || !WORD.test(firstWord) || typeof lastWord !== "string" || !WORD.test(lastWord)) return null;
  if (![inSf, outSf, frames, durMs].every(count) || inSf >= outSf || frames !== outSf - inSf) return null;
  if (!Array.isArray(unitIds) || unitIds.length > 20 || !unitIds.every((unit) => typeof unit === "string" && UNIT.test(unit))) return null;
  if (typeof text !== "string" || typeof reason !== "string" || typeof question !== "boolean" || typeof laughTail !== "boolean") return null;
  return { id, source, firstWord, lastWord, inSf, outSf, frames, durMs, unitIds: [...unitIds],
    text: text.slice(0, MAX_TEXT), question, laughTail, reason: reason.slice(0, MAX_REASON) };
}

/** `{wordsSha256, candidates}` of the CLI's JSON, or null for a malformed answer. */
export function sanitizeSuggestions(json) {
  if (!json || typeof json !== "object" || typeof json.wordsSha256 !== "string" || !SHA.test(json.wordsSha256)) return null;
  if (!Array.isArray(json.candidates)) return null;
  const candidates = json.candidates.map(sanitizeCandidate).filter(Boolean).slice(0, MAX_CANDIDATES);
  return { wordsSha256: json.wordsSha256, candidates };
}

function etagMatches(request, etag) {
  const header = request.headers.get("if-none-match");
  if (!header) return false;
  return header.split(",").map((item) => item.trim().replace(/^W\//, "")).includes(`"${etag}"`);
}

export function createColdOpenSuggestionsRoute(options = {}) {
  const deps = editorDeps(options);
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? MEMO_TTL_MS;
  const memo = new Map();
  return {
    async GET(request, { params }) {
      const checked = await guard(request, params, deps, { ids: { id: isJobId, clipId: isClipId } });
      if (checked.denied) return checked.denied;
      if (new URL(request.url).search) return editorError("invalid_request", 400);
      const { id: jobId, clipId } = checked.params;
      const key = `${jobId}/${clipId}`;
      let entry = memo.get(key);
      if (!entry || now() - entry.at > ttlMs) {
        const result = await callCli(deps, COLDOPEN_MODULE, "list", { jobId, clipId },
          { timeoutMs: TIMEOUT_MS, maxStdoutBytes: MAX_STDOUT_BYTES });
        if (result?.exitCode !== 0) return apiFailure(result);
        const body = sanitizeSuggestions(result.json);
        if (!body) return apiFailure(null);
        const text = JSON.stringify(body);
        entry = { at: now(), text, etag: createHash("sha256").update(text).digest("hex") };
        memo.delete(key);
        memo.set(key, entry);
        while (memo.size > MEMO_SIZE) memo.delete(memo.keys().next().value);
      }
      const headers = { ETag: `"${entry.etag}"`, "Cache-Control": "private, no-cache", "X-Content-Type-Options": "nosniff" };
      if (etagMatches(request, entry.etag)) return new Response(null, { status: 304, headers });
      return new Response(entry.text, { status: 200, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });
    },
  };
}
