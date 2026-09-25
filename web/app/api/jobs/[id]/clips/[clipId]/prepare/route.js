// POST /api/jobs/:id/clips/:clipId/prepare (plan §4.2; T2.3): build the missing analysis
// artifacts of a clip (words, the camera plan of the requested layout) and queue its first plate
// cells. `202 {words, camera, plate: {state, ready, total}}`; idempotent.
import { prepareResponse } from "../../../../../../../lib/preview-lane.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request, { params }) {
  return prepareResponse(request, await params);
}
