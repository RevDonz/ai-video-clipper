import { requireAuth } from "../../../../../../lib/auth.mjs";
import {
  FinalFileInvalidError,
  FinalFileNotFoundError,
  finalFileResponse,
  isBoundedOutputPath,
  isFinalJobId,
} from "../../../../../../lib/final-files.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const errorResponse = (message, status) => new Response(message, {
  status,
  headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
});

async function handle(request, { params }, head) {
  const denied = requireAuth(request);
  if (denied) return denied;
  const resolved = await params;
  if (!isFinalJobId(resolved.id)) return errorResponse("Bad job ID", 400);
  if (!isBoundedOutputPath(resolved.path)) return errorResponse("Forbidden", 403);
  try {
    return await finalFileResponse(request, resolved.id, resolved.path, { head });
  } catch (error) {
    if (error instanceof FinalFileNotFoundError) return errorResponse("File not found", 404);
    if (error instanceof FinalFileInvalidError) return errorResponse("File is invalid", 422);
    return errorResponse("File service unavailable", 503);
  }
}

export async function GET(request, context) {
  return handle(request, context, false);
}

export async function HEAD(request, context) {
  return handle(request, context, true);
}
