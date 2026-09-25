// GET: the current document or the seed (?seed=1); PUT: save a revision (plan §4.2, §4.4).
import { createEditRoute } from "../../../../../../../lib/clip-edit.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createEditRoute();

export const GET = route.GET;
export const PUT = route.PUT;
