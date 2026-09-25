// GET: status of a legacy (unchanged DTO) or render-request-v3 export; DELETE: cancel a v3
// export (plan §4.2, §4.6). The handlers live in web/lib/clip-renders.mjs.
import { createRenderStatusRoute } from "../../../../../../lib/clip-renders.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createRenderStatusRoute();

export const GET = route.GET;
export const DELETE = route.DELETE;
