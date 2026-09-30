// POST: hook suggestions for the edited clip (plan §7.1): the instant variants at once, the LLM
// task when it is switched on. Body exactly {task: "hooks", doc}.
import { createAiRoute } from "../../../../../../../lib/editor-ai.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createAiRoute();

export const POST = route.POST;
