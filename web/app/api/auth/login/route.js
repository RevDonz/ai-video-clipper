import {
  authenticateCredentials,
  createSessionToken,
  sessionCookie,
} from "../../../../lib/auth.mjs";
import {
  AuthRateLimiter,
  authRateLimitKeys,
  parseAuthRateLimitConfig,
  readBoundedUrlEncodedForm,
  sameOriginMutation,
} from "../../../../lib/request-security.mjs";

export const runtime = "nodejs";

const authRateLimiter = new AuthRateLimiter(parseAuthRateLimitConfig());

function safeDestination(value) {
  return typeof value === "string"
    && value.startsWith("/")
    && !value.startsWith("//")
    && !value.includes("\\")
    && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : "/dashboard";
}

export async function POST(request) {
  if (!sameOriginMutation(request)) return Response.json({ error: "Origin permintaan tidak diizinkan" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  let form;
  try {
    form = await readBoundedUrlEncodedForm(request);
  } catch {
    return Response.json({ error: "Permintaan login tidak valid" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const username = String(form.get("username") || "");
  const password = String(form.get("password") || "");
  const next = safeDestination(String(form.get("next") || "/dashboard"));
  const limitKeys = authRateLimitKeys(request, username);
  if (!authenticateCredentials(username, password)) {
    const limits = limitKeys.map((key) => authRateLimiter.consume(key));
    const limited = limits.find((entry) => !entry.allowed);
    if (limited) return Response.json({ error: "Terlalu banyak percobaan login" }, {
      status: 429,
      headers: { "Cache-Control": "no-store", "Retry-After": String(limited.retryAfterSeconds) },
    });
    const query = new URLSearchParams({ error: "1" });
    if (next !== "/dashboard") query.set("next", next);
    return new Response(null, {
      status: 303,
      headers: { Location: `/login?${query}` },
    });
  }
  limitKeys.forEach((key) => authRateLimiter.reset(key));
  return new Response(null, {
    status: 303,
    headers: {
      Location: next,
      "Set-Cookie": sessionCookie(createSessionToken()),
      "Cache-Control": "no-store",
    },
  });
}
