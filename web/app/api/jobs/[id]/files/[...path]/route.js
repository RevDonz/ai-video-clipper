import { requireAuth } from "../../../../../../lib/auth.mjs";
import {
  FinalFileInvalidError,
  FinalFileNotFoundError,
  finalFileResponse,
  isBoundedOutputPath,
  isFinalJobId,
} from "../../../../../../lib/final-files.mjs";
import { withErrorCodes } from "../../../../../../lib/api-error-response.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const errorResponse = (error, code, status) => Response.json({ error, code, messageId: `web.${code}` }, {
  status,
  headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
});

async function handle(request, { params }, head) {
  const denied = requireAuth(request);
  if (denied) return denied;
  const resolved = await params;
  if (!isFinalJobId(resolved.id)) return errorResponse("Bad job ID", "job_id_invalid", 400);
  if (!isBoundedOutputPath(resolved.path)) return errorResponse("Forbidden", "path_forbidden", 403);
  try {
    return await finalFileResponse(request, resolved.id, resolved.path, { head });
  } catch (error) {
    if (error instanceof FinalFileNotFoundError) return errorResponse("File not found", "file_not_found", 404);
    if (error instanceof FinalFileInvalidError) return errorResponse("File is invalid", "file_invalid", 422);
    return errorResponse("File service unavailable", "file_unavailable", 503);
  }
}

async function handleGET(request, context) {
  return handle(request, context, false);
}

async function handleHEAD(request, context) {
  return handle(request, context, true);
}

export const GET = withErrorCodes(handleGET);
export const HEAD = withErrorCodes(handleHEAD);
