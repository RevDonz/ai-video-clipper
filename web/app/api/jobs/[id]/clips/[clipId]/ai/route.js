// POST: hook suggestions for the edited clip (plan §7.1): the instant variants at once, the LLM
// task when it is switched on. Body exactly {task: "hooks", doc}. The job's LLM quota answers
// inside the 202 (`llm.state: "rate_limited"`), with the same wait as Retry-After.
import { createAiRoute } from "../../../../../../../lib/editor-ai.mjs";
import { llmRetryAfter, secureRoute } from "../../../../../../../lib/security-headers.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createAiRoute();

export const POST = secureRoute(route.POST, { params: ["id", "clipId"], limit: "api", after: llmRetryAfter });
