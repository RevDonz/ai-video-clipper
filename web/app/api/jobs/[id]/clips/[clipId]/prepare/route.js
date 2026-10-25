// POST /api/jobs/:id/clips/:clipId/prepare (plan §4.2; T2.3): build the missing analysis
// artifacts of a clip (words, the camera plan of the requested layout) and queue its first plate
// cells. `202 {words, camera, plate: {state, ready, total}}`; idempotent.
import { prepareResponse } from "../../../../../../../lib/preview-lane.mjs";
import { secureRoute } from "../../../../../../../lib/security-headers.mjs";
import { withErrorCodes } from "../../../../../../../lib/api-error-response.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withErrorCodes(secureRoute(async (request, { params }) => prepareResponse(request, await params),
  { params: ["id", "clipId"], limit: "api" }), { domains: ["edit"] });
