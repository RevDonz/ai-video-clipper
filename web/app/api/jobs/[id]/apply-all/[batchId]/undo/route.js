// POST: undo one "Pakai di semua klip" batch on the clips nobody saved since (CONTRACTS §5.53).
import { createUndoApplyAllRoute } from "../../../../../../../lib/apply-all.mjs";
import { secureRoute } from "../../../../../../../lib/security-headers.mjs";
import { withErrorCodes } from "../../../../../../../lib/api-error-response.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createUndoApplyAllRoute();

export const POST = withErrorCodes(secureRoute(route.POST, { params: ["id", "batchId"], limit: "api" }), { domains: ["edit"] });
