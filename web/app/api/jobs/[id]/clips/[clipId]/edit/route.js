// GET: the current document or the seed (?seed=1); PUT: save a revision (plan §4.2, §4.4).
import { createEditRoute } from "../../../../../../../lib/clip-edit.mjs";
import { secureRoute } from "../../../../../../../lib/security-headers.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createEditRoute();

export const GET = secureRoute(route.GET, { params: ["id", "clipId"], limit: "api" });
export const PUT = secureRoute(route.PUT, { params: ["id", "clipId"], limit: "api" });
