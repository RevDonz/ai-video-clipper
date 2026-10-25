// GET: the project's clips (or the picked ones, ?clips=1,3) as one ZIP; ?check=1 answers its size.
import { clipsZipHead, clipsZipRoute } from "../../../../../lib/clips-zip.mjs";
import { secureRoute } from "../../../../../lib/security-headers.mjs";
import { withErrorCodes } from "../../../../../lib/api-error-response.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withErrorCodes(secureRoute(clipsZipRoute, { params: ["id"] }));
export const HEAD = withErrorCodes(secureRoute(clipsZipHead, { params: ["id"] }));
