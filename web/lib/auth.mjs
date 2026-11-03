// Who is asking (rombak 02 §4.4). Everything a guard calls is synchronous: secureRoute runs
// authorize(request) without await (tests/authorize-sync-contract.test.mjs).
//
// Two cookies during the transition: the s2 session (a row in the DB) and the v1 token signed with
// APP_SESSION_SECRET, which maps to the bootstrap owner and upgrades once (lib/sessions.mjs).
//
// Without a usable DB (POTONGIN_DB_PATH empty, the DB will not open, no owner yet) the v1 path alone
// works, as before the user database: the owner is never locked out by the control volume.
import { createHmac, timingSafeEqual } from "node:crypto";

import {
  LEGACY_COOKIE, S2_COOKIE, sessionFromToken, touchSession, v1UpgradeState,
} from "./sessions.mjs";
import { bootstrapOwnerId, findUserById } from "./users.mjs";

export const SESSION_COOKIE = LEGACY_COOKIE;
export { S2_COOKIE };
export const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

// With must_change_password=1 only these may run (02 §6.5).
const PASSWORD_CHANGE_ALLOWLIST = Object.freeze([
  ["GET", "/api/account"], ["POST", "/api/account/password"], ["POST", "/api/auth/logout"], ["POST", "/api/locale"],
]);
export const PASSWORD_CHANGE_PAGE = "/akun/kata-sandi";

const NO_STORE = Object.freeze({ "Cache-Control": "no-store" });

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

/** The v1 token's expiry in seconds when it is valid, else null. */
function v1Expiry(token, env, now) {
  if (!configured(env) || typeof token !== "string") return null;
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;
  const payload = token.slice(0, separator);
  const supplied = token.slice(separator + 1);
  const expected = signature(payload, env.APP_SESSION_SECRET);
  if (!equal(supplied, expected)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return session.username === env.APP_USERNAME && Number.isInteger(session.expiresAt) && session.expiresAt > now
      ? session.expiresAt
      : null;
  } catch {
    return null;
  }
}

export function verifySessionToken(token, env = process.env, now = Math.floor(Date.now() / 1000)) {
  return v1Expiry(token, env, now) !== null;
}

export function cookieValue(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === name) return item.slice(separator + 1).trim();
  }
  return null;
}

/** The bootstrap owner's id when the DB is usable; null means the v1-only path. */
export function identityOwnerId(env = process.env) {
  if (!env.POTONGIN_DB_PATH) return null;
  try {
    return bootstrapOwnerId();
  } catch {
    return null;
  }
}

/** Whether logins go through the user database. */
export function identityAvailable(env = process.env) {
  return identityOwnerId(env) !== null;
}

function principalOfSession({ session, user }) {
  return {
    id: user.id, username: user.username, displayName: user.displayName, role: user.role, status: user.status,
    mustChangePassword: user.mustChangePassword, isSmoke: user.isSmoke, locale: user.locale,
    sessionId: session.id, via: session.via, reauthAt: session.reauthAt,
  };
}

function legacyPrincipal(env) {
  const username = env.APP_USERNAME;
  return {
    id: null, username, displayName: username, role: "admin", status: "active", mustChangePassword: false, isSmoke: false, locale: null,
    sessionId: null, via: "v1", reauthAt: null,
  };
}

function principalFromTokens({ s2, v1 }, env, nowSeconds) {
  const ownerId = identityOwnerId(env);
  const nowMs = nowSeconds * 1000;
  if (ownerId !== null && s2) {
    const found = sessionFromToken(s2, nowMs);
    if (found) {
      try { touchSession(found.session.id, nowMs, found.session.lastSeenAt); } catch { /* a read-only moment is no reason to refuse */ }
      return principalOfSession(found);
    }
  }
  if (!v1) return null;
  const expiresAt = v1Expiry(v1, env, nowSeconds);
  if (expiresAt === null) return null;
  if (ownerId === null) return legacyPrincipal(env);
  try {
    if (v1UpgradeState(v1, env.APP_SESSION_SECRET, nowMs) === "ended") return null;
    const owner = findUserById(ownerId);
    if (!owner || owner.status !== "active") return null;
    return {
      id: owner.id, username: owner.username, displayName: owner.display_name, role: owner.role, status: owner.status,
      mustChangePassword: owner.must_change_password === 1, isSmoke: false, locale: owner.locale,
      sessionId: null, via: "upgrade_v1", reauthAt: null, v1ExpiresAt: expiresAt,
    };
  } catch {
    return legacyPrincipal(env);
  }
}

const cached = new WeakMap();

/** The principal of `request`, or null. Cached per request object for the default arguments. */
export function currentUser(request, env = process.env, now = undefined) {
  const cacheable = env === process.env && now === undefined;
  if (cacheable && cached.has(request)) return cached.get(request);
  const nowSeconds = now ?? Math.floor(Date.now() / 1000);
  const principal = principalFromTokens({ s2: cookieValue(request, S2_COOKIE), v1: cookieValue(request, SESSION_COOKIE) }, env, nowSeconds);
  if (cacheable) cached.set(request, principal);
  return principal;
}

/** The same principal for a server component, from `await cookies()`. */
export function sessionFromCookieStore(store, env = process.env, now = Math.floor(Date.now() / 1000)) {
  return principalFromTokens({ s2: store.get(S2_COOKIE)?.value ?? null, v1: store.get(SESSION_COOKIE)?.value ?? null }, env, now);
}

/** The prefix of this user's editor drafts on a shared device (rombak 02 §6.2): 16 hex, opaque. */
export function draftNamespaceFor(principal, env = process.env) {
  const secret = env.POTONGIN_SETTINGS_SECRET || env.APP_SESSION_SECRET || "";
  return createHmac("sha256", secret).update(`draft\0${principal?.id ?? "owner"}`).digest("hex").slice(0, 16);
}

export function isAuthorized(request, env = process.env, now = undefined) {
  return currentUser(request, env, now) !== null;
}

export function passwordChangeAllowed(method, pathname) {
  return PASSWORD_CHANGE_ALLOWLIST.some(([allowedMethod, allowedPath]) => allowedMethod === method && allowedPath === pathname);
}

function pathOf(request) {
  try { return new URL(request.url).pathname; } catch { return ""; }
}

function passwordChangeResponse() {
  return Response.json({ error: "Ganti kata sandi dulu", code: "password_change_required", messageId: "web.password_change_required" }, { status: 403, headers: NO_STORE });
}

export function requireAuth(request) {
  const principal = currentUser(request);
  if (!principal) {
    return Response.json({ error: "Sesi login tidak valid atau sudah berakhir", code: "unauthorized", messageId: "web.unauthorized" }, { status: 401, headers: NO_STORE });
  }
  if (principal.mustChangePassword && !passwordChangeAllowed(request.method, pathOf(request))) return passwordChangeResponse();
  return null;
}

export class AuthError extends Error {
  constructor(status, code) {
    super(code);
    this.name = "AuthError";
    this.status = status;
    this.code = code;
  }
}

/** For new routes: the principal, or throws AuthError(401|403, code). */
export function requireUser(request) {
  const principal = currentUser(request);
  if (!principal) throw new AuthError(401, "unauthorized");
  if (principal.mustChangePassword && !passwordChangeAllowed(request.method, pathOf(request))) throw new AuthError(403, "password_change_required");
  return principal;
}

// The v1 cookie, written only while the user database cannot be used (lib/sessions.mjs has s2's).
export function sessionCookie(token, now = Date.now()) {
  const expires = new Date(now + SESSION_MAX_AGE * 1000).toUTCString();
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}; Expires=${expires}`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}
