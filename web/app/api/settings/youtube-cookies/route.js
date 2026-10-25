// GET/POST/DELETE: the Pengaturan "Cookies YouTube" file (lib/youtube-cookies.mjs). This path runs
// without web/proxy.js in front (see its matcher): every method checks the session itself
// (secureRoute, then again in the handler), mutations their origin.
import { secureRoute } from "../../../../lib/security-headers.mjs";
import { createYoutubeCookiesRoute } from "../../../../lib/youtube-cookies.mjs";
import { withErrorCodes } from "../../../../lib/api-error-response.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createYoutubeCookiesRoute();

export const GET = withErrorCodes(secureRoute(route.GET));
export const POST = withErrorCodes(secureRoute(route.POST));
export const DELETE = withErrorCodes(secureRoute(route.DELETE));
