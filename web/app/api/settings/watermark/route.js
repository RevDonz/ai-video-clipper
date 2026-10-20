// GET/PUT/DELETE: the Pengaturan default text watermark (CONTRACTS §5.43). A small JSON body, so
// web/proxy.js runs in front; the handlers check the session again and the origin of a change.
import { createDefaultWatermarkRoute } from "../../../../lib/default-watermark.mjs";
import { secureRoute } from "../../../../lib/security-headers.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createDefaultWatermarkRoute();

export const GET = secureRoute(route.GET);
export const PUT = secureRoute(route.PUT);
export const DELETE = secureRoute(route.DELETE);
