// GET: the state of one LLM hook task (plan §7.1): pending, done with its suggestions, or failed.
import { createAiTaskRoute } from "../../../../../../../../lib/editor-ai.mjs";
import { secureRoute } from "../../../../../../../../lib/security-headers.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createAiTaskRoute();

export const GET = secureRoute(route.GET, { params: ["id", "clipId", "taskId"], limit: "api" });
