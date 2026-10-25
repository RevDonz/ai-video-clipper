// PATCH: the title and description the owner set for one clip ("Ubah" on the project page).
import { createClipTextRoute } from "../../../../../lib/clip-text-api.mjs";
import { secureRoute } from "../../../../../lib/security-headers.mjs";
import { withErrorCodes } from "../../../../../lib/api-error-response.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createClipTextRoute();

export const PATCH = withErrorCodes(secureRoute(route.PATCH, { params: ["id"], limit: "api" }));
