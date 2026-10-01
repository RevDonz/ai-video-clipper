// GET: the V3 clips of a job (+ the latest export); POST: job-level prepare (plan §4.2).
import { createClipsRoute } from "../../../../../lib/clip-edit.mjs";
import { secureRoute } from "../../../../../lib/security-headers.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createClipsRoute();

export const GET = secureRoute(route.GET, { params: ["id"], limit: "api" });
export const POST = secureRoute(route.POST, { params: ["id"], limit: "api" });
