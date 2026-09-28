// GET/HEAD: a stored asset's normalised bytes, ?part=peaks (the music waveform) or ?part=meta
// (plan §4.2 "GET /assets/:sha", §9.2 "Serve"; T3.1). This route runs behind web/proxy.js.
import { createAssetFileRoute } from "../../../../../../lib/asset-upload.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createAssetFileRoute();

export const GET = route.GET;
export const HEAD = route.HEAD;
