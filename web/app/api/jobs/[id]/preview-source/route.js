import { requireAuth } from "../../../../../lib/auth.mjs";
import {
  PreviewInvalidError,
  PreviewNotFoundError,
  isPreviewJobId,
  previewResponse,
} from "../../../../../lib/preview-source.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const errorResponse = (message, status) => new Response(message, {
  status,
  headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
});

async function handle(request, { params }, head) {
  const denied = requireAuth(request);
  if (denied) return denied;
  const { id } = await params;
  if (!isPreviewJobId(id)) return errorResponse("Bad job ID", 400);
  try {
    return await previewResponse(request, id, { head });
  } catch (error) {
    if (error instanceof PreviewNotFoundError) return errorResponse("Source not found", 404);
    if (error instanceof PreviewInvalidError) return errorResponse("Source is invalid", 422);
    return errorResponse("Preview service unavailable", 503);
  }
}

export async function GET(request, context) {
  return handle(request, context, false);
}

export async function HEAD(request, context) {
  return handle(request, context, true);
}
