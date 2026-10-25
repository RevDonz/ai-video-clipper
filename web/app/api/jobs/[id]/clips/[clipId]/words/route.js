// GET: the clip's words artifact; `?sha=<64 hex>` pins it and caches it immutably (plan §4.2).
import { createWordsRoute } from "../../../../../../../lib/clip-edit.mjs";
import { secureRoute } from "../../../../../../../lib/security-headers.mjs";
import { withErrorCodes } from "../../../../../../../lib/api-error-response.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createWordsRoute();

export const GET = withErrorCodes(secureRoute(route.GET, { params: ["id", "clipId"], limit: "api" }), { domains: ["edit"] });
