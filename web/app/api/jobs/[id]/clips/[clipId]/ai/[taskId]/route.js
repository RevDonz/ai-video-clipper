// GET: the state of one LLM task, hooks or Cek ejaan (plan §7.1): pending, done with its suggestions, or failed.
import { createAiTaskRoute } from "../../../../../../../../lib/editor-ai.mjs";
import { secureRoute } from "../../../../../../../../lib/security-headers.mjs";
import { withErrorCodes } from "../../../../../../../../lib/api-error-response.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createAiTaskRoute();

export const GET = withErrorCodes(secureRoute(route.GET, { params: ["id", "clipId", "taskId"], limit: "api" }), { domains: ["editor_ai", "edit"] });
