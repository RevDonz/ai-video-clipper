// GET: one page of the Riwayat clip grid across every finished project (?q, high, since, cursor, limit).
import { clipLibraryRoute } from "../../../lib/clip-library.mjs";
import { secureRoute } from "../../../lib/security-headers.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = secureRoute(clipLibraryRoute);
