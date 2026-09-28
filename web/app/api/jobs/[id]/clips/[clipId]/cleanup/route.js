// GET: the Rapikan review list of a clip (plan §4.2, §7.3): fillers, repeats and gaps, immutable
// per (words sha, lexicon digest) — ETag and If-None-Match (web/lib/editor-cleanup.mjs).
import { createCleanupRoute } from "../../../../../../../lib/editor-cleanup.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createCleanupRoute();

export const GET = route.GET;
