import { INGEST_FAILED_AUTH_LIMITS, IngestRateLimiter } from "../../../../lib/ingest-rate-limit.mjs";
import { verifyIngestToken } from "../../../../lib/ingest-tokens.mjs";
import { trustedClientIp } from "../../../../lib/request-security.mjs";
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
const SHARED_CLIENT_LIMITER = new IngestRateLimiter(INGEST_FAILED_AUTH_LIMITS);

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

function rateLimited(message, retryAfterSeconds) {
  return jsonNoStore({ error: message, code: "rate_limited" }, 429, { "Retry-After": String(retryAfterSeconds) });
}

export function createIngestTrendsRoute({
  env = process.env, limiter = SHARED_LIMITER, clientLimiter = SHARED_CLIENT_LIMITER, now = () => new Date(),
} = {}) {
  // { token } or { denied: Response }: 429 for a client IP whose token checks keep failing,
  // 401/403/503 from the token check, then 429 per token. Failures are counted per client only
  // with a trusted client IP (AUTH_TRUSTED_CLIENT_IP_HEADER); without one every client would
  // share one budget and an attacker could lock the agent out.
  async function authenticate(request, scope) {
    const client = trustedClientIp(request, env);
    const clientKey = client === null ? null : `client:${client}`;
    if (clientKey !== null) {
      const gate = clientLimiter.peek(clientKey, now().getTime());
      if (!gate.allowed) return { denied: rateLimited("Terlalu banyak token salah dari alamat ini. Coba lagi nanti.", gate.retryAfterSeconds) };
    }
    const result = await verifyIngestToken(request.headers.get("authorization"), { env, scope, now: now() });
    if (!result.ok) {
      if (clientKey !== null && result.status === 401) clientLimiter.consume(clientKey, now().getTime());
      const headers = result.status !== 401 ? {}
        : { "WWW-Authenticate": result.code === "missing_token" ? 'Bearer realm="potongin"' : 'Bearer realm="potongin", error="invalid_token"' };
      return { denied: jsonNoStore({ error: AUTH_MESSAGES[result.code], code: result.code }, result.status, headers) };
    }
    const decision = limiter.consume(result.token.id, now().getTime());
    if (!decision.allowed) return { denied: rateLimited("Terlalu banyak permintaan untuk token ini. Coba lagi nanti.", decision.retryAfterSeconds) };
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

// Explicit 405s, so these carry { error, code } and no-store like every other answer here
// (Next's automatic 405 has neither).
function methodNotAllowed() {
  return jsonNoStore(
    { error: "Metode ini tidak didukung. Pakai GET, POST atau DELETE.", code: "method_not_allowed" },
    405,
    { Allow: "GET, POST, DELETE" },
  );
}

export async function PUT() {
  return methodNotAllowed();
}

export async function PATCH() {
  return methodNotAllowed();
}
