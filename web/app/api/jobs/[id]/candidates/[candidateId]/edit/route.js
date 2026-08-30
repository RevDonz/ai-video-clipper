import { requireAuth } from "../../../../../../../lib/auth.mjs";
import {
  EditBackendUnavailableError,
  EditConflictError,
  EditIdempotencyConflictError,
  EditJobNotFoundError,
  EditRequestInvalidError,
  EditSelectionChangedError,
  EditSemanticInvalidError,
  EditTimeoutError,
  MAX_EDIT_BODY_BYTES,
  isEditCandidateId,
  isEditIdempotencyKey,
  isEditJobId,
  readEditDocument,
} from "../../../../../../../lib/edit-document.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function response(body, status = 200, etag = null) {
  const headers = { "Cache-Control": "no-store" };
  if (etag) headers.ETag = `"${etag}"`;
  return Response.json(body, { status, headers });
}

function errorResponse(error) {
  if (error instanceof EditRequestInvalidError) return response({ error: "Dokumen edit tidak valid", code: "invalid_request" }, 400);
  if (error instanceof EditJobNotFoundError) return response({ error: "Job atau kandidat tidak ditemukan", code: "not_found" }, 404);
  if (error instanceof EditIdempotencyConflictError) return response({ error: "Idempotency key sudah digunakan untuk dokumen berbeda", code: "idempotency_conflict" }, 409);
  if (error instanceof EditSelectionChangedError) return response({ error: "Pilihan kandidat telah berubah", code: "selection_changed" }, 409);
  if (error instanceof EditConflictError) return response({
    error: "Dokumen edit telah berubah", code: "revision_conflict", current: error.current.manifest,
  }, 409, error.current.etag);
  if (error instanceof EditSemanticInvalidError) return response({ error: "Dokumen edit tidak memenuhi kontrak", code: "semantic_invalid" }, 422);
  if (error instanceof EditBackendUnavailableError || error instanceof EditTimeoutError) {
    return response({ error: "Layanan dokumen edit tidak tersedia", code: "backend_unavailable" }, 503);
  }
  return response({ error: "Layanan dokumen edit tidak tersedia", code: "backend_unavailable" }, 503);
}

async function identify(request, params) {
  const denied = requireAuth(request);
  if (denied) return { denied };
  const { id, candidateId } = await params;
  if (!isEditJobId(id) || !isEditCandidateId(candidateId)) {
    return { denied: response({ error: "Job atau kandidat tidak valid", code: "invalid_request" }, 400) };
  }
  return { id, candidateId };
}

async function boundedBody(request) {
  const type = request.headers.get("content-type") || "";
  if (!/^application\/json(?:\s*;|$)/i.test(type) || !request.body) throw new EditRequestInvalidError();
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new EditRequestInvalidError();
      total += value.byteLength;
      if (total > MAX_EDIT_BODY_BYTES) throw new EditRequestInvalidError();
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  if (total === 0) throw new EditRequestInvalidError();
  return Buffer.concat(chunks, total);
}

function verifySameOrigin(request) {
  let url;
  try { url = new URL(request.url); } catch { return false; }
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  const fetchSite = request.headers.get("sec-fetch-site");
  return origin === url.origin && host === url.host && (!fetchSite || fetchSite === "same-origin");
}

export async function GET(request, { params }) {
  const resolved = await identify(request, params);
  if (resolved.denied) return resolved.denied;
  try {
    const result = await readEditDocument(resolved.id, resolved.candidateId, {
      operation: "get", candidateId: resolved.candidateId,
    });
    return response(result.manifest, 200, result.etag);
  } catch (error) { return errorResponse(error); }
}

export async function PUT(request, { params }) {
  const resolved = await identify(request, params);
  if (resolved.denied) return resolved.denied;
  if (!verifySameOrigin(request)) return response({ error: "Origin permintaan tidak diizinkan", code: "csrf_rejected" }, 403);
  const match = request.headers.get("if-match");
  if (!match) return response({ error: "If-Match wajib diisi", code: "precondition_required" }, 428);
  const parsedMatch = /^"([0-9a-f]{64})"$/.exec(match);
  const key = request.headers.get("idempotency-key");
  if (!parsedMatch || !isEditIdempotencyKey(key)) {
    return response({ error: "Header edit tidak valid", code: "invalid_request" }, 400);
  }
  try {
    const raw = await boundedBody(request);
    const result = await readEditDocument(resolved.id, resolved.candidateId, {
      operation: "put", candidateId: resolved.candidateId, expectedEtag: parsedMatch[1],
      idempotencyKey: key, manifestRaw: raw.toString("base64"),
    });
    return response(result.manifest, 200, result.etag);
  } catch (error) { return errorResponse(error); }
}
