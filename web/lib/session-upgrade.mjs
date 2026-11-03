// The v1 cookie's one upgrade (rombak 02 §4.3): the Set-Cookie headers that replace it with its s2
// session. Any failure returns no header: the v1 cookie stays, and the request still passes on it.
import { SESSION_COOKIE, cookieValue } from "./auth.mjs";
import { clearLegacyCookie, sessionCookie, upgradeV1Session } from "./sessions.mjs";

export function upgradeLegacyCookie(request, principal, { env = process.env, now = Date.now() } = {}) {
  try {
    const expiresAtMs = principal.v1ExpiresAt * 1000;
    const upgraded = upgradeV1Session(cookieValue(request, SESSION_COOKIE), env.APP_SESSION_SECRET, {
      userId: principal.id, expiresAtMs, userAgent: request.headers.get("user-agent"), now,
    });
    if (!upgraded) return [];
    const maxAge = Math.max(1, Math.floor((upgraded.expiresAt - now) / 1000));
    return [sessionCookie(upgraded.token, { maxAge }), clearLegacyCookie()];
  } catch (error) {
    console.warn(`[auth] upgrade cookie v1 gagal: ${error?.code ?? "error"}`);
    return [];
  }
}
