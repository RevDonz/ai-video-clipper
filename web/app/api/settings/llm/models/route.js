import { requireAuth } from "../../../../../lib/auth.mjs";
import { LlmActionError, fetchProviderModels } from "../../../../../lib/llm-settings-actions.mjs";
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

const SHARED_LIMITER = new AuthRateLimiter({ attempts: 20, windowMs: 60_000 });

// Fetches {baseUrl}/models of ONE saved provider server-side with its stored
// key (no redirects, bounded time and size) and returns the model ids.
export function createLlmModelsRoute({
  authorize = requireAuth,
  env = process.env,
  sameOrigin = sameOriginMutation,
  limiter = SHARED_LIMITER,
  timeoutMs,
  maxBytes,
} = {}) {
  return {
    async POST(request) {
      const denied = guardRequest(request, { authorize, sameOrigin, mutation: true });
      if (denied) return denied;
      try {
        const provider = providerRequest(await readJsonBody(request, { maxBytes: MAX_ACTION_BODY_BYTES }));
        const limited = rateLimited(limiter, "llm-model-list");
        if (limited) return limited;
        return noStore(await fetchProviderModels({ provider, env, ...(timeoutMs ? { timeoutMs } : {}), ...(maxBytes ? { maxBytes } : {}) }));
      } catch (error) {
        if (error instanceof LlmActionError) return noStore({ error: error.message, code: error.code }, error.status);
        return errorResponse(error);
      }
    },
  };
}

const route = createLlmModelsRoute();

export async function POST(request) {
  return route.POST(request);
}
