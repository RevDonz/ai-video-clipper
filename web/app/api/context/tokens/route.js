import { requireAuth } from "../../../../lib/auth.mjs";
import { MAX_ACTIVE_TOKENS, createIngestToken, listIngestTokens } from "../../../../lib/ingest-tokens.mjs";
import { sameOriginMutation } from "../../../../lib/request-security.mjs";
import {
  TrendContextError,
  guardDashboardRequest,
  jsonNoStore,
  readJsonRequestBody,
  trendErrorResponse,
} from "../../../../lib/trend-context.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 1024;

// GET: the agent tokens (id, label, prefix, createdAt, lastUsedAt, revokedAt), never a token
// value or hash. POST { "label" }: 201 with the new token value, which is never shown again.
export function createIngestTokensRoute({ authorize = requireAuth, env = process.env, sameOrigin = sameOriginMutation, now = () => new Date() } = {}) {
  return {
    async GET(request) {
      const denied = guardDashboardRequest(request, { authorize, sameOrigin });
      if (denied) return denied;
      try {
        return jsonNoStore({ tokens: await listIngestTokens({ env }), maxActive: MAX_ACTIVE_TOKENS });
      } catch (error) {
        return trendErrorResponse(error);
      }
    },
    async POST(request) {
      const denied = guardDashboardRequest(request, { authorize, sameOrigin, mutation: true });
      if (denied) return denied;
      try {
        const body = await readJsonRequestBody(request, { maxBytes: MAX_BODY_BYTES });
        if (body === null || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "label")) {
          throw new TrendContextError("invalid_body", "Isi permintaan harus { \"label\": \"…\" }.");
        }
        const { token, record } = await createIngestToken(body.label, { env, now: now() });
        return jsonNoStore({ token, ...record }, 201);
      } catch (error) {
        return trendErrorResponse(error);
      }
    },
  };
}

const route = createIngestTokensRoute();

export async function GET(request) {
  return route.GET(request);
}

export async function POST(request) {
  return route.POST(request);
}
