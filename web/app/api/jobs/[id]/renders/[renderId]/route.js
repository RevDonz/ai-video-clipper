// GET: status of an export; DELETE: cancel it (plan §4.2, §4.6). Requests of the retired
// candidate editor answer 404. The handlers live in web/lib/clip-renders.mjs.
import { createRenderStatusRoute } from "../../../../../../lib/clip-renders.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createRenderStatusRoute();

export const GET = route.GET;
export const DELETE = route.DELETE;
