import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "potongin_session";
export const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

function equal(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function configured(env) {
  return Boolean(
    env.APP_USERNAME &&
      env.APP_PASSWORD &&
      env.APP_SESSION_SECRET &&
      env.APP_SESSION_SECRET.length >= 32,
  );
}

function signature(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function authenticateCredentials(username, password, env = process.env) {
  if (!configured(env)) return false;
  return equal(username, env.APP_USERNAME) && equal(password, env.APP_PASSWORD);
}

export function createSessionToken(env = process.env, now = Math.floor(Date.now() / 1000)) {
  if (!configured(env)) throw new Error("Application session authentication is not configured");
  const payload = Buffer.from(
    JSON.stringify({ username: env.APP_USERNAME, expiresAt: now + SESSION_MAX_AGE }),
  ).toString("base64url");
  return `${payload}.${signature(payload, env.APP_SESSION_SECRET)}`;
}

export function verifySessionToken(token, env = process.env, now = Math.floor(Date.now() / 1000)) {
  if (!configured(env) || typeof token !== "string") return false;
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return false;
  const payload = token.slice(0, separator);
  const supplied = token.slice(separator + 1);
  const expected = signature(payload, env.APP_SESSION_SECRET);
  if (!equal(supplied, expected)) return false;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return (
      session.username === env.APP_USERNAME &&
      Number.isInteger(session.expiresAt) &&
      session.expiresAt > now
    );
  } catch {
    return false;
  }
}

function cookieValue(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === name) return item.slice(separator + 1).trim();
  }
  return null;
}

export function isAuthorized(request, env = process.env, now = Math.floor(Date.now() / 1000)) {
  return verifySessionToken(cookieValue(request, SESSION_COOKIE), env, now);
}

export function sessionCookie(token) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function requireAuth(request) {
  if (isAuthorized(request)) return null;
  return Response.json({ error: "Sesi login tidak valid atau sudah berakhir" }, {
    status: 401,
    headers: { "Cache-Control": "no-store" },
  });
}
