// GET/HEAD: the normalised PNG of the current default logo. This route runs behind web/proxy.js.
import { createDefaultLogoFileRoute } from "../../../../../lib/default-logo.mjs";
import { secureRoute } from "../../../../../lib/security-headers.mjs";
import { withErrorCodes } from "../../../../../lib/api-error-response.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createDefaultLogoFileRoute();

export const GET = withErrorCodes(secureRoute(route.GET, { params: ["sha"] }), { domains: ["edit"] });
export const HEAD = withErrorCodes(secureRoute(route.HEAD, { params: ["sha"] }), { domains: ["edit"] });
