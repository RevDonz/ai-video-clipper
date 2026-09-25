// GET: the V3 clips of a job (+ the latest export); POST: job-level prepare (plan §4.2).
import { createClipsRoute } from "../../../../../lib/clip-edit.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createClipsRoute();

export const GET = route.GET;
export const POST = route.POST;
