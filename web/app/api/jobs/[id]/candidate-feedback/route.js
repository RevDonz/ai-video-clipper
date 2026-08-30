import { requireAuth } from "../../../../../lib/auth.mjs";
import { sameOriginMutation } from "../../../../../lib/request-security.mjs";
import {
  FeedbackArtifactInvalidError,
  FeedbackBackendUnavailableError,
  FeedbackConflictError,
  FeedbackJobNotFoundError,
  FeedbackRequestInvalidError,
  FeedbackSelectionChangedError,
  FeedbackTimeoutError,
  MAX_FEEDBACK_COMMAND_BYTES,
  isFeedbackJobId,
  readCandidateFeedback,
} from "../../../../../lib/candidate-feedback.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const response = (body, status = 200) => Response.json(body, {
  status,
  headers: { "Cache-Control": "no-store" },
});

async function boundedBody(request) {
  const contentType = request.headers.get("content-type") || "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) throw new FeedbackRequestInvalidError();
  if (!request.body) throw new FeedbackRequestInvalidError();
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new FeedbackRequestInvalidError();
      total += value.byteLength;
      if (total > MAX_FEEDBACK_COMMAND_BYTES) throw new FeedbackRequestInvalidError();
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new FeedbackRequestInvalidError();
  return Buffer.concat(chunks, total);
}

export function feedbackErrorResponse(error) {
  if (error instanceof FeedbackRequestInvalidError) return response({ error: "Feedback kandidat tidak valid", code: "invalid_request" }, 400);
  if (error instanceof FeedbackJobNotFoundError) return response({ error: "Job atau artifact kandidat tidak ditemukan", code: "not_found" }, 404);
  if (error instanceof FeedbackConflictError) return response({ error: "Client request ID sudah digunakan untuk feedback berbeda", code: "idempotency_conflict" }, 409);
  if (error instanceof FeedbackSelectionChangedError) return response({ error: "Pilihan kandidat telah berubah", code: "selection_changed" }, 409);
  if (error instanceof FeedbackArtifactInvalidError) return response({ error: "Artifact kandidat atau feedback tidak valid", code: "invalid_artifact" }, 422);
  if (error instanceof FeedbackBackendUnavailableError || error instanceof FeedbackTimeoutError) return response({ error: "Layanan feedback kandidat tidak tersedia", code: "backend_unavailable" }, 503);
  return response({ error: "Layanan feedback kandidat tidak tersedia", code: "backend_unavailable" }, 503);
}

async function identify(request, params) {
  const denied = requireAuth(request);
  if (denied) return { denied };
  const { id } = await params;
  if (!isFeedbackJobId(id)) return { denied: response({ error: "Job ID tidak valid" }, 400) };
  return { id };
}

export async function GET(request, { params }) {
  const resolved = await identify(request, params);
  if (resolved.denied) return resolved.denied;
  try {
    return response(await readCandidateFeedback(resolved.id, "get"));
  } catch (error) {
    return feedbackErrorResponse(error);
  }
}

export async function PUT(request, { params }) {
  const resolved = await identify(request, params);
  if (resolved.denied) return resolved.denied;
  if (!sameOriginMutation(request)) return response({ error: "Origin permintaan tidak diizinkan", code: "csrf_rejected" }, 403);
  try {
    const raw = await boundedBody(request);
    const result = await readCandidateFeedback(resolved.id, "put", raw);
    return response(result, result.created ? 201 : 200);
  } catch (error) {
    return feedbackErrorResponse(error);
  }
}
