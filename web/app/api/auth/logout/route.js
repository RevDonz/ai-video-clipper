import { clearSessionCookie } from "../../../../lib/auth.mjs";
import { sameOriginMutation } from "../../../../lib/request-security.mjs";
import { withErrorCodes } from "../../../../lib/api-error-response.mjs";

export const runtime = "nodejs";

async function handlePOST(request) {
  if (!sameOriginMutation(request)) return Response.json({ error: "Origin permintaan tidak diizinkan", code: "csrf_rejected", messageId: "web.csrf_rejected" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/login",
      "Set-Cookie": clearSessionCookie(),
      "Cache-Control": "no-store",
    },
  });
}

export const POST = withErrorCodes(handlePOST);
