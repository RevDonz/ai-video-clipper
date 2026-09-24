import { requireAuth } from "../../../../lib/auth.mjs";
import { readEffectiveLlmStatus } from "../../../../lib/llm-settings.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

// Reports the LLM configuration the next job will use: the settings saved on
// the Pengaturan page when they exist, else this server's environment. It never
// calls a provider and never returns key values.
export function createLlmStatusHandler({ authorize = requireAuth, env = process.env, readStatus = readEffectiveLlmStatus } = {}) {
  return async function llmStatusHandler(request) {
    const denied = authorize(request);
    if (denied) {
      denied.headers.set("Cache-Control", "no-store");
      return denied;
    }
    try {
      return Response.json({ llm: await readStatus(env) }, { headers: NO_STORE });
    } catch {
      return Response.json({ llm: { state: "invalid", label: "Status LLM tidak dapat dibaca — memakai heuristik" } }, { status: 500, headers: NO_STORE });
    }
  };
}

export const GET = createLlmStatusHandler();
