import { requireAuth } from "../../../../../../lib/auth.mjs";
import {
  RenderQueueInvalidError, RenderQueueNotFoundError, RenderQueueUnavailableError,
  isRenderId, isRenderJobId, readRenderRequest, sanitizeRenderStatus,
} from "../../../../../../lib/render-requests.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
function response(body, status) { return Response.json(body, { status, headers: { "Cache-Control": "no-store" } }); }

export async function GET(request, { params }) {
  const denied = requireAuth(request); if (denied) return denied;
  const { id, renderId } = await params;
  if (!isRenderJobId(id) || !isRenderId(renderId)) return response({ error: "Render tidak valid", code: "invalid_request" }, 400);
  try {
    return response(sanitizeRenderStatus(id, await readRenderRequest(id, renderId)), 200);
  } catch (error) {
    if (error instanceof RenderQueueNotFoundError) return response({ error: "Render tidak ditemukan", code: "not_found" }, 404);
    if (error instanceof RenderQueueInvalidError) return response({ error: "Render tidak valid", code: "invalid_request" }, 400);
    if (error instanceof RenderQueueUnavailableError) return response({ error: "Layanan render tidak tersedia", code: "backend_unavailable" }, 503);
    return response({ error: "Layanan render tidak tersedia", code: "backend_unavailable" }, 503);
  }
}
