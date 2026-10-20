// GET: the project's clips (or the picked ones, ?clips=1,3) as one ZIP; ?check=1 answers its size.
import { clipsZipRoute } from "../../../../../lib/clips-zip.mjs";
import { secureRoute } from "../../../../../lib/security-headers.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = secureRoute(clipsZipRoute, { params: ["id"] });
