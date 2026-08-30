import { requireAuth } from "../../../../../../../lib/auth.mjs";
import {
  RenderQueueConflictError, RenderQueueInvalidError, RenderQueueNotFoundError,
  RenderQueueUnavailableError, createRenderRequest, isRenderCandidateId,
  isRenderIdempotencyKey, isRenderJobId, isRenderEtag, sanitizeRenderStatus,
} from "../../../../../../../lib/render-requests.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function response(body, status) { return Response.json(body, { status, headers: { "Cache-Control": "no-store" } }); }
function sameOrigin(request) {
  try {
    const url = new URL(request.url);
    return request.headers.get("origin") === url.origin && request.headers.get("host") === url.host
      && [null, "same-origin"].includes(request.headers.get("sec-fetch-site"));
  } catch { return false; }
}
export class PayloadTooLargeError extends Error {}

export async function readBoundedJsonBytes(request, maximum = 1024) {
  if (!request || request.bodyUsed || request.signal?.aborted || !request.body
      || !Number.isInteger(maximum) || maximum < 0) {
    throw new RenderQueueInvalidError();
  }
  const declared = request.headers?.get?.("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maximum) {
    throw new PayloadTooLargeError();
  }

  let reader;
  try { reader = request.body.getReader(); } catch { throw new RenderQueueInvalidError(); }
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      let item;
      try { item = await reader.read(); } catch {
        try { await reader.cancel(); } catch {}
        throw new RenderQueueInvalidError();
      }
      if (request.signal?.aborted) {
        try { await reader.cancel(); } catch {}
        throw new RenderQueueInvalidError();
      }
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) throw new RenderQueueInvalidError();
      total += item.value.byteLength;
      if (total > maximum) {
        try { await reader.cancel(); } catch {}
        throw new PayloadTooLargeError();
      }
      chunks.push(item.value);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  if (total === 0) throw new RenderQueueInvalidError();
  const raw = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
  return raw;
}

export async function parseRenderBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) {
    throw new RenderQueueInvalidError();
  }
  let parsed;
  try {
    const raw = await readBoundedJsonBytes(request);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    if (!/^\s*\{\s*"editEtag"\s*:\s*"[0-9a-f]{64}"\s*\}\s*$/.test(text)) {
      throw new RenderQueueInvalidError();
    }
    parsed = JSON.parse(text);
  } catch (error) {
    if (error instanceof PayloadTooLargeError || error instanceof RenderQueueInvalidError) throw error;
    throw new RenderQueueInvalidError();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, "editEtag")
      || !isRenderEtag(parsed.editEtag)) throw new RenderQueueInvalidError();
  return parsed;
}

export async function POST(request, { params }) {
  const denied = requireAuth(request); if (denied) return denied;
  if (!sameOrigin(request)) return response({ error: "Origin permintaan tidak diizinkan", code: "csrf_rejected" }, 403);
  const { id, candidateId } = await params;
  const key = request.headers.get("idempotency-key");
  if (!isRenderJobId(id) || !isRenderCandidateId(candidateId) || !isRenderIdempotencyKey(key)) {
    return response({ error: "Permintaan render tidak valid", code: "invalid_request" }, 400);
  }
  try {
    const parsed = await parseRenderBody(request);
    const result = await createRenderRequest(id, candidateId, parsed.editEtag, key);
    return response(sanitizeRenderStatus(id, result), 202);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) return response({ error: "Permintaan render terlalu besar", code: "payload_too_large" }, 413);
    if (error instanceof RenderQueueConflictError) return response({ error: "Idempotency key atau revisi edit konflik", code: "render_conflict" }, 409);
    if (error instanceof RenderQueueNotFoundError) return response({ error: "Job atau kandidat tidak ditemukan", code: "not_found" }, 404);
    if (error instanceof RenderQueueInvalidError || error instanceof SyntaxError) return response({ error: "Permintaan render tidak valid", code: "invalid_request" }, 400);
    if (error instanceof RenderQueueUnavailableError) return response({ error: "Layanan render tidak tersedia", code: "backend_unavailable" }, 503);
    return response({ error: "Layanan render tidak tersedia", code: "backend_unavailable" }, 503);
  }
}
