// GET/PUT/DELETE: the Pengaturan default text watermark (CONTRACTS §5.43). A small JSON body, so
// web/proxy.js runs in front; the handlers check the session again and the origin of a change.
import { createDefaultWatermarkRoute } from "../../../../lib/default-watermark.mjs";
import { secureRoute } from "../../../../lib/security-headers.mjs";
import { withErrorCodes } from "../../../../lib/api-error-response.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createDefaultWatermarkRoute();

export const GET = withErrorCodes(secureRoute(route.GET));
export const PUT = withErrorCodes(secureRoute(route.PUT));
export const DELETE = withErrorCodes(secureRoute(route.DELETE));
