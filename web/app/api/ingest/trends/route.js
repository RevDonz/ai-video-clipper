import { IngestRateLimiter } from "../../../../lib/ingest-rate-limit.mjs";
import { verifyIngestToken } from "../../../../lib/ingest-tokens.mjs";
import {
  EXTERNAL_ID_PATTERN,
  TREND_LIMITS,
  TrendContextError,
  deleteTrendByExternalId,
  emptyNoStore,
  ingestTrendItems,
  jsonNoStore,
  listActiveTrendSummaries,
  readJsonRequestBody,
  trendErrorResponse,
} from "../../../../lib/trend-context.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The machine route for the owner's agent (Hermes): Authorization: Bearer ptk_… only.
// proxy.js skips this path (it only knows the session cookie), so the route authenticates
// every request itself and never accepts the cookie. The body is read with a hard 256 KiB cap.
//   POST   { items: [...] }      upsert, per-item rejections
//   GET                          active items, for the agent to dedupe
//   DELETE ?externalId=…         one item this token's source created

const SHARED_LIMITER = new IngestRateLimiter();

const AUTH_MESSAGES = Object.freeze({
  missing_token: "Token ingest diperlukan (Authorization: Bearer ptk_…).",
  invalid_token: "Token ingest tidak valid.",
  revoked_token: "Token ingest sudah dicabut.",
  insufficient_scope: "Token ini tidak punya izin untuk tindakan ini.",
  storage_unavailable: "Penyimpanan token tidak bisa dibaca di server.",
});

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

export function createIngestTrendsRoute({ env = process.env, limiter = SHARED_LIMITER, now = () => new Date() } = {}) {
  // { token } or { denied: Response }: 401/403/503 from the token check, then 429 per token.
  async function authenticate(request, scope) {
    const result = await verifyIngestToken(request.headers.get("authorization"), { env, scope, now: now() });
    if (!result.ok) {
      const headers = result.status !== 401 ? {}
        : { "WWW-Authenticate": result.code === "missing_token" ? 'Bearer realm="potongin"' : 'Bearer realm="potongin", error="invalid_token"' };
      return { denied: jsonNoStore({ error: AUTH_MESSAGES[result.code], code: result.code }, result.status, headers) };
    }
    const decision = limiter.consume(result.token.id, now().getTime());
    if (!decision.allowed) {
      return {
        denied: jsonNoStore(
          { error: "Terlalu banyak permintaan untuk token ini. Coba lagi nanti.", code: "rate_limited" },
          429,
          { "Retry-After": String(decision.retryAfterSeconds) },
        ),
      };
    }
    return { token: result.token };
  }

  return {
    async GET(request) {
      const auth = await authenticate(request, "trends:read");
      if (auth.denied) return auth.denied;
      try {
        return jsonNoStore({ items: await listActiveTrendSummaries({ env, now: now() }) });
      } catch (error) {
        return trendErrorResponse(error);
      }
    },

    async POST(request) {
      const auth = await authenticate(request, "trends:write");
      if (auth.denied) return auth.denied;
      try {
        const body = await readJsonRequestBody(request, { maxBytes: TREND_LIMITS.maxIngestBytes });
        if (!isPlainObject(body) || Object.keys(body).some((key) => key !== "items") || !Array.isArray(body.items)) {
          throw new TrendContextError("invalid_body", "Isi permintaan harus { \"items\": [ … ] }.");
        }
        if (body.items.length > TREND_LIMITS.maxBatchItems) {
          throw new TrendContextError("too_many_items", `Maksimal ${TREND_LIMITS.maxBatchItems} item per permintaan.`);
        }
        return jsonNoStore(await ingestTrendItems(body.items, { env, source: auth.token.label, now: now() }));
      } catch (error) {
        return trendErrorResponse(error);
      }
    },

    async DELETE(request) {
      const auth = await authenticate(request, "trends:write");
      if (auth.denied) return auth.denied;
      try {
        const values = new URL(request.url).searchParams.getAll("externalId");
        if (values.length !== 1 || !EXTERNAL_ID_PATTERN.test(values[0])) {
          throw new TrendContextError("invalid_body", "Sertakan tepat satu parameter externalId yang valid.");
        }
        const removed = await deleteTrendByExternalId(values[0], { env, source: auth.token.label, now: now() });
        return removed ? emptyNoStore(204) : jsonNoStore({ error: "Item tren tidak ditemukan untuk token ini.", code: "not_found" }, 404);
      } catch (error) {
        return trendErrorResponse(error);
      }
    },
  };
}

const route = createIngestTrendsRoute();

export async function GET(request) {
  return route.GET(request);
}

export async function POST(request) {
  return route.POST(request);
}

export async function DELETE(request) {
  return route.DELETE(request);
}
