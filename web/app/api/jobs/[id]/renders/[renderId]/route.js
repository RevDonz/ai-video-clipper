// GET: status of an export; DELETE: cancel it (plan §4.2, §4.6). Requests of the retired
// candidate editor answer 404. The handlers live in web/lib/clip-renders.mjs; both methods pass
// the shared guard of the editor routes first (session, origin, ids, the api bucket, headers).
import { createRenderStatusRoute } from "../../../../../../lib/clip-renders.mjs";
import { secureRoute } from "../../../../../../lib/security-headers.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createRenderStatusRoute();

export const GET = secureRoute(route.GET, { params: ["id", "renderId"], limit: "api" });
export const DELETE = secureRoute(route.DELETE, { params: ["id", "renderId"], limit: "api" });
