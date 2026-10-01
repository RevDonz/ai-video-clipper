// GET: the Rapikan review list of a clip (plan §4.2, §7.3): fillers, repeats and gaps, with an
// ETag of its content (web/lib/editor-cleanup.mjs).
import { createCleanupRoute } from "../../../../../../../lib/editor-cleanup.mjs";
import { secureRoute } from "../../../../../../../lib/security-headers.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createCleanupRoute();

export const GET = secureRoute(route.GET, { params: ["id", "clipId"], limit: "api" });
