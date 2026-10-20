// POST: "Tulis ulang", a new title and description for one clip from the free LLM chain.
import { createRewriteRoute } from "../../../../../../lib/clip-text-api.mjs";
import { secureRoute } from "../../../../../../lib/security-headers.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createRewriteRoute();

export const POST = secureRoute(route.POST, { params: ["id"], limit: "api" });
