// POST: "Hook di video" on the project page, the clip's hook overlay on or off (CONTRACTS §5.57).
import { createClipHookRoute } from "../../../../../../../lib/clip-hook-api.mjs";
import { secureRoute } from "../../../../../../../lib/security-headers.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createClipHookRoute();

export const POST = secureRoute(route.POST, { params: ["id", "clipId"], limit: "api" });
