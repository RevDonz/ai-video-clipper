// POST: export a revision through render-request-v3; GET: the clip's exports (plan §4.2, §4.6).
import { createClipRendersRoute } from "../../../../../../../lib/clip-renders.mjs";
import { secureRoute } from "../../../../../../../lib/security-headers.mjs";
import { withErrorCodes } from "../../../../../../../lib/api-error-response.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createClipRendersRoute();

export const GET = withErrorCodes(secureRoute(route.GET, { params: ["id", "clipId"], limit: "api" }), { domains: ["edit"] });
export const POST = withErrorCodes(secureRoute(route.POST, { params: ["id", "clipId"], limit: "api" }), { domains: ["edit"] });
