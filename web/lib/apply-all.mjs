// "Pakai di semua klip" (CONTRACTS §5.53): one clip's caption, logo or layout written to every
// other clip of its job in one batch, and its undo.
//
//   POST /api/jobs/:id/clips/:clipId/apply-all     body {group, etag} ≤ 1 KiB, Idempotency-Key
//   POST /api/jobs/:id/apply-all/:batchId/undo     empty body or {}
//
// Session, the editor flag, same-origin and the ids come first (clip-edit.mjs `guard`); the work
// is the api CLI's `apply_all` / `undo_apply_all`, which saves each clip through the document
// store (If-Match, revision + 1, receipts). The Idempotency-Key is the batch id, so a retried
// request replays its result instead of running twice.
import {
  BodyTooLargeError,
  EDIT_API_MODULE,
  MAX_SMALL_BODY_BYTES,
  apiFailure,
  callCli,
  editorDeps,
  editorError,
  editorResponse,
  guard,
  isClipId,
  isEtag,
  isIdempotencyKey,
  isJobId,
  isJsonRequest,
  readBoundedBody,
} from "./clip-edit.mjs";

export const APPLY_GROUPS = Object.freeze(["captions", "logo", "layout"]);
export const APPLY_SKIP_REASONS = Object.freeze(["edited", "not_ready", "read_only", "conflict", "invalid"]);
export const UNDO_SKIP_REASONS = Object.freeze(["changed", "invalid"]);
// Every target is validated and saved in one process: about a second per clip on a long job.
const APPLY_TIMEOUT_MS = 5 * 60_000;

function parseBody(raw) {
  let body;
  try { body = JSON.parse(Buffer.from(raw).toString("utf8")); } catch { return null; }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const keys = Object.keys(body).sort();
  if (keys.length !== 2 || keys[0] !== "etag" || keys[1] !== "group") return null;
  if (!APPLY_GROUPS.includes(body.group) || !isEtag(body.etag)) return null;
  return body;
}

function clipEntries(list, reasons = null) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 500).flatMap((item) => {
    if (!item || typeof item !== "object" || !Number.isInteger(item.index)) return [];
    const entry = { clipId: isClipId(item.clipId) ? item.clipId : null, index: item.index };
    if (reasons) entry.reason = reasons.includes(item.reason) ? item.reason : reasons.at(-1);
    return [entry];
  });
}

/** The CLI's batch result reduced to the contract fields. */
export function sanitizeApplyResult(json) {
  return {
    batchId: isIdempotencyKey(json?.batchId) ? json.batchId : null,
    group: APPLY_GROUPS.includes(json?.group) ? json.group : null,
    applied: clipEntries(json?.applied),
    skipped: clipEntries(json?.skipped, APPLY_SKIP_REASONS),
    unchanged: clipEntries(json?.unchanged),
  };
}

/** The CLI's undo result reduced to the contract fields. */
export function sanitizeUndoResult(json) {
  return {
    batchId: isIdempotencyKey(json?.batchId) ? json.batchId : null,
    group: APPLY_GROUPS.includes(json?.group) ? json.group : null,
    restored: clipEntries(json?.restored),
    skipped: clipEntries(json?.skipped, UNDO_SKIP_REASONS),
  };
}

export function createApplyAllRoute(options = {}) {
  const deps = editorDeps(options);
  return {
    async POST(request, { params }) {
      const checked = await guard(request, params, deps, { ids: { id: isJobId, clipId: isClipId }, mutation: true });
      if (checked.denied) return checked.denied;
      const batchId = request.headers.get("idempotency-key");
      if (!isIdempotencyKey(batchId) || !isJsonRequest(request)) return editorError("invalid_request", 400);
      let raw;
      try { raw = await readBoundedBody(request, MAX_SMALL_BODY_BYTES); } catch (error) {
        return error instanceof BodyTooLargeError ? editorError("payload_too_large", 413) : editorError("invalid_request", 400);
      }
      const body = parseBody(raw);
      if (!body) return editorError("invalid_request", 400);
      const { id: jobId, clipId } = checked.params;
      const result = await callCli(deps, EDIT_API_MODULE, "apply_all", {
        jobId, clipId, etag: body.etag, group: body.group, batchId: batchId.toLowerCase(),
      }, { timeoutMs: APPLY_TIMEOUT_MS });
      // The source's newer revision is the editor's own: no document travels back.
      if (result?.exitCode === 5) return editorError("revision_conflict", 409);
      if (result?.exitCode !== 0) return apiFailure(result);
      return editorResponse(sanitizeApplyResult(result.json));
    },
  };
}

export function createUndoApplyAllRoute(options = {}) {
  const deps = editorDeps(options);
  return {
    async POST(request, { params }) {
      const checked = await guard(request, params, deps, { ids: { id: isJobId, batchId: isIdempotencyKey }, mutation: true });
      if (checked.denied) return checked.denied;
      let raw;
      try { raw = await readBoundedBody(request, MAX_SMALL_BODY_BYTES, { allowEmpty: true }); } catch (error) {
        return error instanceof BodyTooLargeError ? editorError("payload_too_large", 413) : editorError("invalid_request", 400);
      }
      const text = Buffer.from(raw).toString("utf8");
      if (text.trim() !== "" && !/^\s*\{\s*\}\s*$/.test(text)) return editorError("invalid_request", 400);
      const { id: jobId, batchId } = checked.params;
      const result = await callCli(deps, EDIT_API_MODULE, "undo_apply_all", { jobId, batchId: batchId.toLowerCase() },
        { timeoutMs: APPLY_TIMEOUT_MS });
      if (result?.exitCode !== 0) return apiFailure(result);
      return editorResponse(sanitizeUndoResult(result.json));
    },
  };
}
