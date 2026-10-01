// GET /api/jobs/:id/clips/:clipId/media/:kind/:name (plan §4.2; T2.3): plate cells, audio
// mixes, ASS, derived logos and peaks of a clip, by content-hash name, with HTTP Range.
import { requireAuth } from "../../../../../../../../../lib/auth.mjs";
import { clipMediaResponse, mediaFile } from "../../../../../../../../../lib/clip-media.mjs";
import { editorV3Enabled, getPreviewLane } from "../../../../../../../../../lib/preview-lane.mjs";
import { secureRoute } from "../../../../../../../../../lib/security-headers.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const plain = (status, message) => new Response(message, {
  status,
  headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Type": "text/plain; charset=utf-8" },
});

async function handle(request, { params }, head) {
  if (!editorV3Enabled()) return plain(404, "Not found");
  const denied = requireAuth(request);
  if (denied) return denied;
  const { id, clipId, kind, name } = await params;
  if (!mediaFile(kind, name)) return plain(404, "Not found");
  return clipMediaResponse(request, {
    jobId: id, clipId, kind, name, head,
    onServed: (file) => getPreviewLane().touch(file),
  });
}

// No rate limit: file reads only (the player fetches cells and ranges while it plays).
export const GET = secureRoute((request, context) => handle(request, context, false), { params: ["id", "clipId"] });
export const HEAD = secureRoute((request, context) => handle(request, context, true), { params: ["id", "clipId"] });
