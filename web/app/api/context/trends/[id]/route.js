import { requireAuth } from "../../../../../lib/auth.mjs";
import { sameOriginMutation } from "../../../../../lib/request-security.mjs";
import {
  TREND_LIMITS,
  deleteTrendItem,
  emptyNoStore,
  guardDashboardRequest,
  jsonNoStore,
  readJsonRequestBody,
  trendErrorResponse,
  updateTrendItem,
} from "../../../../../lib/trend-context.mjs";
import { withErrorCodes } from "../../../../../lib/api-error-response.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// PATCH: edits title, summary, keywords, hashtags, sensitivity, expiresAt or enabled of one
// item. DELETE: removes it (204, or 404 when there is no such item).
export function createContextTrendItemRoute({ authorize = requireAuth, env = process.env, sameOrigin = sameOriginMutation, now = () => new Date() } = {}) {
  return {
    async PATCH(request, { params }) {
      const denied = guardDashboardRequest(request, { authorize, sameOrigin, mutation: true });
      if (denied) return denied;
      try {
        const { id } = await params;
        const patch = await readJsonRequestBody(request, { maxBytes: TREND_LIMITS.maxDashboardBodyBytes });
        return jsonNoStore({ item: await updateTrendItem(id, patch, { env, now: now() }) });
      } catch (error) {
        return trendErrorResponse(error);
      }
    },
    async DELETE(request, { params }) {
      const denied = guardDashboardRequest(request, { authorize, sameOrigin, mutation: true });
      if (denied) return denied;
      try {
        const { id } = await params;
        if (await deleteTrendItem(id, { env, now: now() })) return emptyNoStore(204);
        return jsonNoStore({ error: "Item tren tidak ditemukan.", code: "not_found" }, 404);
      } catch (error) {
        return trendErrorResponse(error);
      }
    },
  };
}

const route = createContextTrendItemRoute();

async function handlePATCH(request, context) {
  return route.PATCH(request, context);
}

async function handleDELETE(request, context) {
  return route.DELETE(request, context);
}

export const PATCH = withErrorCodes(handlePATCH);
export const DELETE = withErrorCodes(handleDELETE);
