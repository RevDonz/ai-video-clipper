// POST /api/jobs/:id/clips/:clipId/preview/frame (plan §4.2; T2.3): the truth frame `f` of an
// unsaved document, `image/png` at the output size (the final graph including 4:2:0 and an intra
// encode at the export CRF). At most 4/s per session; cached by (plan, f).
import { frameResponse } from "../../../../../../../../lib/preview-lane.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request, { params }) {
  return frameResponse(request, await params);
}
