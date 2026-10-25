// GET: status of an export; DELETE: cancel it (plan §4.2, §4.6). Requests of the retired
// candidate editor answer 404. The handlers live in web/lib/clip-renders.mjs; both methods pass
// the shared guard of the editor routes first (session, origin, ids, the api bucket, headers).
import { createRenderStatusRoute } from "../../../../../../lib/clip-renders.mjs";
import { secureRoute } from "../../../../../../lib/security-headers.mjs";
import { withErrorCodes } from "../../../../../../lib/api-error-response.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createRenderStatusRoute();

export const GET = withErrorCodes(secureRoute(route.GET, { params: ["id", "renderId"], limit: "api" }), { domains: ["edit"] });
export const DELETE = withErrorCodes(secureRoute(route.DELETE, { params: ["id", "renderId"], limit: "api" }), { domains: ["edit"] });
