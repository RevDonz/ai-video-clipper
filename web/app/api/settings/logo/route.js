// GET/POST/DELETE: the Pengaturan default logo (plan 2026-10-20 A6). This path runs without
// web/proxy.js in front (see its matcher) so the upload body is streamed, not buffered: every
// method checks the session itself (secureRoute, then again in the handler).
import { createDefaultLogoRoute } from "../../../../lib/default-logo.mjs";
import { secureRoute } from "../../../../lib/security-headers.mjs";
import { withErrorCodes } from "../../../../lib/api-error-response.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createDefaultLogoRoute();

export const GET = withErrorCodes(secureRoute(route.GET), { domains: ["edit"] });
export const POST = withErrorCodes(secureRoute(route.POST), { domains: ["edit"] });
export const DELETE = withErrorCodes(secureRoute(route.DELETE), { domains: ["edit"] });
