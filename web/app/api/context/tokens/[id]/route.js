import { requireAuth } from "../../../../../lib/auth.mjs";
import { revokeIngestToken } from "../../../../../lib/ingest-tokens.mjs";
import { sameOriginMutation } from "../../../../../lib/request-security.mjs";
import { guardDashboardRequest, jsonNoStore, trendErrorResponse } from "../../../../../lib/trend-context.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// DELETE: revokes the token (sets revokedAt; it stays listed as history).
export function createIngestTokenItemRoute({ authorize = requireAuth, env = process.env, sameOrigin = sameOriginMutation, now = () => new Date() } = {}) {
  return {
    async DELETE(request, { params }) {
      const denied = guardDashboardRequest(request, { authorize, sameOrigin, mutation: true });
      if (denied) return denied;
      try {
        const { id } = await params;
        const token = await revokeIngestToken(id, { env, now: now() });
        return token ? jsonNoStore({ token }) : jsonNoStore({ error: "Token tidak ditemukan.", code: "not_found" }, 404);
      } catch (error) {
        return trendErrorResponse(error);
      }
    },
  };
}

const route = createIngestTokenItemRoute();

export async function DELETE(request, context) {
  return route.DELETE(request, context);
}
