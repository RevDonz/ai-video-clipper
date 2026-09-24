import { requireAuth } from "../../../../lib/auth.mjs";
import {
  MAX_SETTINGS_BODY_BYTES,
  errorResponse,
  guardRequest,
  noStore,
  readJsonBody,
} from "../../../../lib/llm-settings-http.mjs";
import {
  publicSettingsView,
  readEffectiveLlmStatus,
  readLlmSettingsView,
  saveLlmSettings,
  settingsSecret,
} from "../../../../lib/llm-settings.mjs";
import { sameOriginMutation } from "../../../../lib/request-security.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET: the LLM settings the page edits (keys only as apiKeySet/apiKeyUnreadable
// flags) plus the effective status. PUT: saves the whole document; each
// provider's apiKey is { action: "keep" | "replace" | "clear", value? }.
export function createLlmSettingsRoute({ authorize = requireAuth, env = process.env, sameOrigin = sameOriginMutation } = {}) {
  return {
    async GET(request) {
      const denied = guardRequest(request, { authorize });
      if (denied) return denied;
      try {
        return noStore(await readLlmSettingsView(env));
      } catch (error) {
        return errorResponse(error);
      }
    },
    async PUT(request) {
      const denied = guardRequest(request, { authorize, sameOrigin, mutation: true });
      if (denied) return denied;
      try {
        const input = await readJsonBody(request, { maxBytes: MAX_SETTINGS_BODY_BYTES });
        const saved = await saveLlmSettings(input, { env });
        const read = { exists: true, settings: saved };
        return noStore({
          settings: publicSettingsView(saved, { secret: settingsSecret(env), source: "ui" }),
          status: await readEffectiveLlmStatus(env, { read }),
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

const route = createLlmSettingsRoute();

export async function GET(request) {
  return route.GET(request);
}

export async function PUT(request) {
  return route.PUT(request);
}
