// GET /api/resources/:kind/:name (plan §4.2; T2.3): the pinned caption fonts (checked against
// resources/fonts/fonts.json) and the caption-pack / hook-design JSON, byte for byte the files
// libass uses on the server (R6).
import { requireAuth } from "../../../../../lib/auth.mjs";
import { resourceResponse } from "../../../../../lib/clip-media.mjs";
import { editorV3Enabled } from "../../../../../lib/preview-lane.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handle(request, { params }, head) {
  if (!editorV3Enabled()) {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  }
  const denied = requireAuth(request);
  if (denied) return denied;
  const { kind, name } = await params;
  return resourceResponse(request, { kind, name, head });
}

export async function GET(request, context) {
  return handle(request, context, false);
}

export async function HEAD(request, context) {
  return handle(request, context, true);
}
