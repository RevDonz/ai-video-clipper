import { requireAuth } from "../../../../../lib/auth.mjs";
import { LlmActionError, runProviderCheck } from "../../../../../lib/llm-settings-actions.mjs";
import {
  MAX_ACTION_BODY_BYTES,
  errorResponse,
  guardRequest,
  noStore,
  providerRequest,
  rateLimited,
  readJsonBody,
} from "../../../../../lib/llm-settings-http.mjs";
import { AuthRateLimiter, sameOriginMutation } from "../../../../../lib/request-security.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SHARED_LIMITER = new AuthRateLimiter({ attempts: 12, windowMs: 60_000 });
let running = 0;

// Sends the engine's tiny JSON ping to ONE saved provider and reports the
// outcome as { status, model, latencyS, code, message } — never the key or the
// provider's raw error text.
export function createLlmTestRoute({
  authorize = requireAuth,
  env = process.env,
  sameOrigin = sameOriginMutation,
  limiter = SHARED_LIMITER,
  pythonBin,
  timeoutMs,
} = {}) {
  return {
    async POST(request) {
      const denied = guardRequest(request, { authorize, sameOrigin, mutation: true });
      if (denied) return denied;
      try {
        const provider = providerRequest(await readJsonBody(request, { maxBytes: MAX_ACTION_BODY_BYTES }));
        const limited = rateLimited(limiter, "llm-connection-test");
        if (limited) return limited;
        if (running >= 2) return noStore({ error: "Tes koneksi lain masih berjalan. Tunggu sebentar.", code: "busy" }, 429, { "Retry-After": "5" });
        running += 1;
        try {
          const result = await runProviderCheck({ provider, env, ...(pythonBin ? { pythonBin } : {}), ...(timeoutMs ? { timeoutMs } : {}) });
          return noStore({ result });
        } finally {
          running -= 1;
        }
      } catch (error) {
        if (error instanceof LlmActionError) return noStore({ error: error.message, code: error.code }, error.status);
        return errorResponse(error);
      }
    },
  };
}

const route = createLlmTestRoute();

export async function POST(request) {
  return route.POST(request);
}
