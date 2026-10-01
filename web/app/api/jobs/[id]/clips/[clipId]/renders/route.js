// POST: export a revision through render-request-v3; GET: the clip's exports (plan §4.2, §4.6).
import { createClipRendersRoute } from "../../../../../../../lib/clip-renders.mjs";
import { secureRoute } from "../../../../../../../lib/security-headers.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createClipRendersRoute();

export const GET = secureRoute(route.GET, { params: ["id", "clipId"], limit: "api" });
export const POST = secureRoute(route.POST, { params: ["id", "clipId"], limit: "api" });
