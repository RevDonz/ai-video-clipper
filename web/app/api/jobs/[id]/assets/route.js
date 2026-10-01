// POST: upload a logo or a music file into the job's asset store (plan §4.2, §9.2; T3.1).
// This route runs without web/proxy.js in front (see its matcher): it authenticates every
// request itself (secureRoute, then requireAuth + sameOriginMutation again in the handler) and
// streams the raw body with a hard cap. Uploads have their own bucket (30/min per session).
import { createAssetUploadRoute } from "../../../../../lib/asset-upload.mjs";
import { secureRoute } from "../../../../../lib/security-headers.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createAssetUploadRoute();

export const POST = secureRoute(route.POST, { params: ["id"] });
