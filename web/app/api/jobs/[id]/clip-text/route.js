// PATCH: the title and description the owner set for one clip ("Ubah" on the project page).
import { createClipTextRoute } from "../../../../../lib/clip-text-api.mjs";
import { secureRoute } from "../../../../../lib/security-headers.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createClipTextRoute();

export const PATCH = secureRoute(route.PATCH, { params: ["id"], limit: "api" });
