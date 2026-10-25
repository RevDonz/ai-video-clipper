// GET/HEAD: a stored asset's normalised bytes, ?part=peaks (the music waveform) or ?part=meta
// (plan §4.2 "GET /assets/:sha", §9.2 "Serve"; T3.1). This route runs behind web/proxy.js.
import { createAssetFileRoute } from "../../../../../../lib/asset-upload.mjs";
import { secureRoute } from "../../../../../../lib/security-headers.mjs";
import { withErrorCodes } from "../../../../../../lib/api-error-response.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createAssetFileRoute();

// No rate limit: file reads only (the logo image and the music track while they play).
export const GET = withErrorCodes(secureRoute(route.GET, { params: ["id", "sha"] }), { domains: ["edit"] });
export const HEAD = withErrorCodes(secureRoute(route.HEAD, { params: ["id", "sha"] }), { domains: ["edit"] });
