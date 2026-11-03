// POST /api/account/password (rombak 02 §6.5): the current password, the policy, the new hash, every
// other session of the user revoked and this one rotated. Runs behind the proxy, on the allowlist
// of a user who must change their password; a break-glass session may give APP_PASSWORD as current.
import { AuthError, requireUser } from "../../../../lib/auth.mjs";
import { withErrorCodes } from "../../../../lib/api-error-response.mjs";
import { writeAudit } from "../../../../lib/audit.mjs";
import { tx } from "../../../../lib/db/index.mjs";
import { PasswordBusyError, breakGlassMatches, checkPasswordPolicy, hashPassword, verifyPassword } from "../../../../lib/passwords.mjs";
import { sameOriginMutation, sharedAuthLimiter } from "../../../../lib/request-security.mjs";
import {
  clearLegacyCookie, createSession, revokeSession, revokeUserSessions, sessionCookie,
} from "../../../../lib/sessions.mjs";
import { findUserById, setUserPassword } from "../../../../lib/users.mjs";

export const runtime = "nodejs";

const MAX_BODY = 4096;
const NO_STORE = Object.freeze({ "Cache-Control": "no-store" });
const WEB_MESSAGES = Object.freeze({
  csrf_rejected: "Origin permintaan tidak diizinkan",
  invalid_request: "Permintaan tidak valid",
  rate_limited: "Terlalu banyak permintaan; tunggu sebentar lalu coba lagi",
  db_unavailable: "Database kontrol tidak tersedia",
  unauthorized: "Sesi login diperlukan",
  password_change_required: "Ganti kata sandi dulu",
});
const ACCOUNT_MESSAGES = Object.freeze({
  password_wrong: "Kata sandi sekarang salah",
  password_too_short: "Kata sandi minimal 12 karakter",
  password_too_long: "Kata sandi terlalu panjang",
  password_common: "Kata sandi ini terlalu umum",
  password_same_as_username: "Kata sandi tidak boleh sama dengan nama pengguna",
});

function webError(status, code, headers = {}) {
  return Response.json({ error: WEB_MESSAGES[code], code, messageId: `web.${code}` }, { status, headers: { ...NO_STORE, ...headers } });
}

function accountError(status, code) {
  return Response.json({ error: ACCOUNT_MESSAGES[code], code, messageId: `account.${code}` }, { status, headers: NO_STORE });
}

async function readBody(request) {
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY) return null;
  try {
    const body = JSON.parse(text);
    return typeof body?.current === "string" && typeof body?.next === "string" ? body : null;
  } catch {
    return null;
  }
}

async function handlePOST(request) {
  if (!sameOriginMutation(request)) return webError(403, "csrf_rejected");
  let principal;
  try {
    principal = requireUser(request);
  } catch (error) {
    if (error instanceof AuthError) return webError(error.status, error.code);
    throw error;
  }
  if (!principal.id) return webError(503, "db_unavailable");
  const limiter = sharedAuthLimiter("password");
  const limitKey = `user:${principal.id}`;
  const blocked = limiter.blocked(limitKey);
  if (blocked.blocked) return webError(429, "rate_limited", { "Retry-After": String(blocked.retryAfterSeconds) });

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY) return webError(400, "invalid_request");
  const body = await readBody(request);
  if (!body) return webError(400, "invalid_request");

  const user = findUserById(principal.id);
  if (!user) return webError(401, "unauthorized");
  try {
    const verdict = await verifyPassword(body.current, user.password_hash);
    const allowed = verdict.ok || (principal.via === "break_glass" && breakGlassMatches(user.username, body.current, process.env));
    if (!allowed) {
      limiter.consume(limitKey);
      return accountError(403, "password_wrong");
    }
    const refused = checkPasswordPolicy(body.next, user.username);
    if (refused) return accountError(400, refused);
    const passwordHash = await hashPassword(body.next);
    const { token } = tx(() => {
      setUserPassword(user.id, passwordHash, { mustChange: false });
      revokeUserSessions(user.id, "password_changed");
      if (principal.sessionId) revokeSession(principal.sessionId, "password_changed");
      writeAudit({ code: "user.password_changed", actorKind: "user", actorUserId: user.id, actorLabel: user.username, targetUserId: user.id, targetLabel: user.username, params: { via: "self" } });
      return createSession(user.id, { via: "password", userAgent: request.headers.get("user-agent") });
    });
    limiter.reset(limitKey);
    const headers = new Headers(NO_STORE);
    headers.append("Set-Cookie", sessionCookie(token));
    headers.append("Set-Cookie", clearLegacyCookie());
    return Response.json({ ok: true }, { status: 200, headers });
  } catch (error) {
    if (error instanceof PasswordBusyError) return webError(429, "rate_limited", { "Retry-After": String(error.retryAfterSeconds) });
    throw error;
  }
}

export const POST = withErrorCodes(handlePOST);
