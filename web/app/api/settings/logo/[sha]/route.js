// GET/HEAD: the normalised PNG of the current default logo. This route runs behind web/proxy.js.
import { createDefaultLogoFileRoute } from "../../../../../lib/default-logo.mjs";
import { secureRoute } from "../../../../../lib/security-headers.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createDefaultLogoFileRoute();

export const GET = secureRoute(route.GET, { params: ["sha"] });
export const HEAD = secureRoute(route.HEAD, { params: ["sha"] });
