// GET: the clip's words artifact; `?sha=<64 hex>` pins it and caches it immutably (plan §4.2).
import { createWordsRoute } from "../../../../../../../lib/clip-edit.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createWordsRoute();

export const GET = route.GET;
