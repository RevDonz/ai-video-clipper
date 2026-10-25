// POST /api/jobs/:id/clips/:clipId/preview/plan (plan §4.2, §4.3; T2.3): validate and resolve
// an unsaved document; `200 PlanDTO` or `422 {errors}`. At most 10/s per session (the lane's
// own bucket); a newer request for the clip cancels the superseded one.
import { planResponse } from "../../../../../../../../lib/preview-lane.mjs";
import { secureRoute } from "../../../../../../../../lib/security-headers.mjs";
import { withErrorCodes } from "../../../../../../../../lib/api-error-response.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withErrorCodes(secureRoute(async (request, { params }) => planResponse(request, await params),
  { params: ["id", "clipId"] }), { domains: ["edit"] });
