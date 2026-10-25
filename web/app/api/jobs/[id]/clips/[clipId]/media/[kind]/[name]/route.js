// GET /api/jobs/:id/clips/:clipId/media/:kind/:name (plan §4.2; T2.3): plate cells, audio
// mixes, ASS, derived logos and peaks of a clip, by content-hash name, with HTTP Range.
import { requireAuth } from "../../../../../../../../../lib/auth.mjs";
import { clipMediaResponse, mediaFile } from "../../../../../../../../../lib/clip-media.mjs";
import { editorV3Enabled, getPreviewLane } from "../../../../../../../../../lib/preview-lane.mjs";
import { secureRoute } from "../../../../../../../../../lib/security-headers.mjs";
import { withErrorCodes } from "../../../../../../../../../lib/api-error-response.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const notFound = () => Response.json({ error: "Not found", code: "not_found", messageId: "edit.not_found" }, {
  status: 404,
  headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
});

async function handle(request, { params }, head) {
  if (!editorV3Enabled()) return notFound();
  const denied = requireAuth(request);
  if (denied) return denied;
  const { id, clipId, kind, name } = await params;
  if (!mediaFile(kind, name)) return notFound();
  return clipMediaResponse(request, {
    jobId: id, clipId, kind, name, head,
    onServed: (file) => getPreviewLane().touch(file),
  });
}

// No rate limit: file reads only (the player fetches cells and ranges while it plays).
export const GET = withErrorCodes(secureRoute((request, context) => handle(request, context, false), { params: ["id", "clipId"] }), { domains: ["edit"] });
export const HEAD = withErrorCodes(secureRoute((request, context) => handle(request, context, true), { params: ["id", "clipId"] }), { domains: ["edit"] });
