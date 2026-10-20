// GET/POST/DELETE: the Pengaturan default logo (plan 2026-10-20 A6). This path runs without
// web/proxy.js in front (see its matcher) so the upload body is streamed, not buffered: every
// method checks the session itself (secureRoute, then again in the handler).
import { createDefaultLogoRoute } from "../../../../lib/default-logo.mjs";
import { secureRoute } from "../../../../lib/security-headers.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createDefaultLogoRoute();

export const GET = secureRoute(route.GET);
export const POST = secureRoute(route.POST);
export const DELETE = secureRoute(route.DELETE);
