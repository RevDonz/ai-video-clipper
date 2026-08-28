import { timingSafeEqual } from "node:crypto";

function equal(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isAuthorized(request, env = process.env) {
  const username = env.APP_USERNAME;
  const password = env.APP_PASSWORD;
  if (!username || !password) return false;
  const header = request.headers.get("authorization") || "";
  if (!header.startsWith("Basic ")) return false;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return false;
    return equal(decoded.slice(0, separator), username) && equal(decoded.slice(separator + 1), password);
  } catch {
    return false;
  }
}

export function requireAuth(request) {
  if (isAuthorized(request)) return null;
  const configured = Boolean(process.env.APP_USERNAME && process.env.APP_PASSWORD);
  return new Response(configured ? "Authentication required" : "Application auth is not configured", {
    status: configured ? 401 : 503,
    headers: {
      "WWW-Authenticate": 'Basic realm="Potongin AI", charset="UTF-8"',
      "Cache-Control": "no-store",
    },
  });
}
