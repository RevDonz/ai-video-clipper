import { SESSION_COOKIE, cookieValue, currentUser } from "../../../../lib/auth.mjs";
import { sameOriginMutation } from "../../../../lib/request-security.mjs";
import { withErrorCodes } from "../../../../lib/api-error-response.mjs";
import { clearSessionCookies, revokeSession, revokeV1Token } from "../../../../lib/sessions.mjs";

export const runtime = "nodejs";

// Revokes on the server (rombak 02 §6.2): the stolen copy of this cookie stops working too. A v1
// cookie's row is revoked as well, so that token cannot sign in again until it expires.
function revokeOnServer(request) {
  const principal = currentUser(request);
  if (!principal?.id) return;
  try {
    if (principal.sessionId) revokeSession(principal.sessionId, "logout");
    const v1 = cookieValue(request, SESSION_COOKIE);
    if (v1 && principal.via === "upgrade_v1") {
      revokeV1Token(v1, process.env.APP_SESSION_SECRET, { userId: principal.id, expiresAtMs: principal.v1ExpiresAt * 1000 });
    }
  } catch (error) {
    console.warn(`[auth] logout tidak tercatat: ${error?.code ?? "error"}`);
  }
}

async function handlePOST(request) {
  if (!sameOriginMutation(request)) return Response.json({ error: "Origin permintaan tidak diizinkan", code: "csrf_rejected", messageId: "web.csrf_rejected" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  revokeOnServer(request);
  // ?keluar=1 tells the login page to clear this device's editor drafts (02 §6.2).
  const headers = new Headers({ Location: "/login?keluar=1", "Cache-Control": "no-store" });
  for (const cookie of clearSessionCookies()) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

export const POST = withErrorCodes(handlePOST);
