// GET: the clip's cold-open suggestions (plan §7.2); the handler is web/lib/coldopen-suggestions.mjs.
import { createColdOpenSuggestionsRoute } from "../../../../../../../lib/coldopen-suggestions.mjs";
import { secureRoute } from "../../../../../../../lib/security-headers.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createColdOpenSuggestionsRoute();

export const GET = secureRoute(route.GET, { params: ["id", "clipId"], limit: "api" });
