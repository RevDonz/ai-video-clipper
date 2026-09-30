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
import { safeNextPath } from "../../../../lib/login-view.mjs";

export const runtime = "nodejs";

const authRateLimiter = new AuthRateLimiter(parseAuthRateLimitConfig());

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
  const next = safeNextPath(String(form.get("next") || "/dashboard"));
  const limitKeys = authRateLimitKeys(request, username);
  if (!authenticateCredentials(username, password)) {
    const limits = limitKeys.map((key) => authRateLimiter.consume(key));
    const limited = limits.find((entry) => !entry.allowed);
    // The login form is a plain HTML form: both refusals go back to it with a message.
    const query = new URLSearchParams({ error: limited ? "limit" : "1" });
    if (next !== "/dashboard") query.set("next", next);
    const headers = { Location: `/login?${query}` };
    if (limited) Object.assign(headers, { "Cache-Control": "no-store", "Retry-After": String(limited.retryAfterSeconds) });
    return new Response(null, { status: 303, headers });
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
