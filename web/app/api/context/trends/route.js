import { requireAuth } from "../../../../lib/auth.mjs";
import { sameOriginMutation } from "../../../../lib/request-security.mjs";
import {
  TREND_LIMITS,
  createManualTrend,
  guardDashboardRequest,
  jsonNoStore,
  readJsonRequestBody,
  readTrendContextView,
  trendErrorResponse,
} from "../../../../lib/trend-context.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET: every item (active and up to seven days expired, each with `expired`), the global
// switch, updatedAt and lastIngestAt. POST: adds an item typed on the page (source "manual").
export function createContextTrendsRoute({ authorize = requireAuth, env = process.env, sameOrigin = sameOriginMutation, now = () => new Date() } = {}) {
  return {
    async GET(request) {
      const denied = guardDashboardRequest(request, { authorize, sameOrigin });
      if (denied) return denied;
      try {
        return jsonNoStore(await readTrendContextView({ env, now: now() }));
      } catch (error) {
        return trendErrorResponse(error);
      }
    },
    async POST(request) {
      const denied = guardDashboardRequest(request, { authorize, sameOrigin, mutation: true });
      if (denied) return denied;
      try {
        const input = await readJsonRequestBody(request, { maxBytes: TREND_LIMITS.maxDashboardBodyBytes });
        return jsonNoStore({ item: await createManualTrend(input, { env, now: now() }) }, 201);
      } catch (error) {
        return trendErrorResponse(error);
      }
    },
  };
}

const route = createContextTrendsRoute();

export async function GET(request) {
  return route.GET(request);
}

export async function POST(request) {
  return route.POST(request);
}
