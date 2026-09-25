// GET /api/jobs/:id/clips/:clipId/media/:kind/:name (plan §4.2; T2.3): plate cells, audio
// mixes, ASS, derived logos and peaks of a clip, by content-hash name, with HTTP Range.
import { requireAuth } from "../../../../../../../../../lib/auth.mjs";
import { CLIP_ID, JOB_ID, clipMediaResponse, mediaFile } from "../../../../../../../../../lib/clip-media.mjs";
import { editorV3Enabled, getPreviewLane } from "../../../../../../../../../lib/preview-lane.mjs";

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
  if (!JOB_ID.test(id || "") || !CLIP_ID.test(clipId || "")) return plain(400, "Bad request");
  if (!mediaFile(kind, name)) return plain(404, "Not found");
  return clipMediaResponse(request, {
    jobId: id, clipId, kind, name, head,
    onServed: (file) => getPreviewLane().touch(file),
  });
}

export async function GET(request, context) {
  return handle(request, context, false);
}

export async function HEAD(request, context) {
  return handle(request, context, true);
}
