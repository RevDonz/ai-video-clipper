// "Hook di video" (CONTRACTS §5.57): the project page switches one clip's hook overlay on or off.
//
//   POST /api/jobs/:id/clips/:clipId/hook   body exactly {on, etag} ≤ 1 KiB, Idempotency-Key
//
// Session, the editor flag, same-origin and the ids come first (clip-edit.mjs `guard`); the work
// is the api CLI's `set_hook`, which saves the clip's document through the store (If-Match,
// revision + 1, receipts) as the editor's SetHookEnabled would. The page then exports the new
// revision through the renders route, so the file and the editor agree.
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
  sanitizeHookState,
} from "./clip-edit.mjs";

function parseBody(raw) {
  let body;
  try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); } catch { return null; }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const keys = Object.keys(body).sort();
  if (keys.length !== 2 || keys[0] !== "etag" || keys[1] !== "on") return null;
  if (typeof body.on !== "boolean" || !isEtag(body.etag)) return null;
  return body;
}

/** The CLI's answer reduced to `{etag, revision, changed, hook}`, or null when it is malformed. */
export function sanitizeHookResult(json) {
  const hook = sanitizeHookState(json?.hook);
  if (!hook || !isEtag(json.etag) || !Number.isSafeInteger(json.revision) || json.revision < 0
    || typeof json.changed !== "boolean") return null;
  return { etag: json.etag, revision: json.revision, changed: json.changed, hook };
}

export function createClipHookRoute(options = {}) {
  const deps = editorDeps(options);
  return {
    async POST(request, { params }) {
      const checked = await guard(request, params, deps, { ids: { id: isJobId, clipId: isClipId }, mutation: true });
      if (checked.denied) return checked.denied;
      const key = request.headers.get("idempotency-key");
      if (!isIdempotencyKey(key) || !isJsonRequest(request)) return editorError("invalid_request", 400);
      let raw;
      try { raw = await readBoundedBody(request, MAX_SMALL_BODY_BYTES); } catch (error) {
        return error instanceof BodyTooLargeError ? editorError("payload_too_large", 413) : editorError("invalid_request", 400);
      }
      const body = parseBody(raw);
      if (!body) return editorError("invalid_request", 400);
      const { id: jobId, clipId } = checked.params;
      const result = await callCli(deps, EDIT_API_MODULE, "set_hook", {
        jobId, clipId, etag: body.etag, hook: body.on ? "on" : "off", idempotencyKey: key,
      });
      // The newer revision belongs to the editor or another tab: no document travels back.
      if (result?.exitCode === 5) return editorError("revision_conflict", 409);
      if (result?.exitCode !== 0) return apiFailure(result);
      const clean = sanitizeHookResult(result.json);
      return clean ? editorResponse(clean) : apiFailure(null);
    },
  };
}
