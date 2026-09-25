import { requireAuth } from "../../../../../lib/auth.mjs";
import { sameOriginMutation } from "../../../../../lib/request-security.mjs";
import {
  TrendContextError,
  guardDashboardRequest,
  jsonNoStore,
  readJsonRequestBody,
  setTrendContextEnabled,
  trendErrorResponse,
} from "../../../../../lib/trend-context.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 1024;

// PUT { "enabled": true | false }: "Pakai konteks tren di pemilihan klip".
export function createTrendSettingsRoute({ authorize = requireAuth, env = process.env, sameOrigin = sameOriginMutation, now = () => new Date() } = {}) {
  return {
    async PUT(request) {
      const denied = guardDashboardRequest(request, { authorize, sameOrigin, mutation: true });
      if (denied) return denied;
      try {
        const body = await readJsonRequestBody(request, { maxBytes: MAX_BODY_BYTES });
        const valid = body !== null && typeof body === "object" && !Array.isArray(body)
          && Object.keys(body).length === 1 && typeof body.enabled === "boolean";
        if (!valid) throw new TrendContextError("invalid_body", "Isi permintaan harus { \"enabled\": true | false }.");
        return jsonNoStore(await setTrendContextEnabled(body.enabled, { env, now: now() }));
      } catch (error) {
        return trendErrorResponse(error);
      }
    },
  };
}

const route = createTrendSettingsRoute();

export async function PUT(request) {
  return route.PUT(request);
}
