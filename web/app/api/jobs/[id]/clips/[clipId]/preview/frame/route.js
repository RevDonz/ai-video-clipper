// POST /api/jobs/:id/clips/:clipId/preview/frame (plan §4.2; T2.3): the truth frame `f` of an
// unsaved document, `image/png` at the output size (the final graph including 4:2:0 and an intra
// encode at the export CRF). At most 4/s per session (the lane's own bucket); cached by (plan, f).
import { frameResponse } from "../../../../../../../../lib/preview-lane.mjs";
import { secureRoute } from "../../../../../../../../lib/security-headers.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = secureRoute(async (request, { params }) => frameResponse(request, await params),
  { params: ["id", "clipId"] });
