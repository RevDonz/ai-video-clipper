// POST: "Pakai di semua klip", this clip's caption, logo or layout on every other clip of the job
// in one batch (CONTRACTS §5.53).
import { createApplyAllRoute } from "../../../../../../../lib/apply-all.mjs";
import { secureRoute } from "../../../../../../../lib/security-headers.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createApplyAllRoute();

export const POST = secureRoute(route.POST, { params: ["id", "clipId"], limit: "api" });
