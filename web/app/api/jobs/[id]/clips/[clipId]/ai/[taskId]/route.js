// GET: the state of one LLM hook task (plan §7.1): pending, done with its suggestions, or failed.
import { createAiTaskRoute } from "../../../../../../../../lib/editor-ai.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createAiTaskRoute();

export const GET = route.GET;
