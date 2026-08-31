import { clearSessionCookie } from "../../../../lib/auth.mjs";
import { sameOriginMutation } from "../../../../lib/request-security.mjs";

export const runtime = "nodejs";

export async function POST(request) {
  if (!sameOriginMutation(request)) return Response.json({ error: "Origin permintaan tidak diizinkan" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/login",
      "Set-Cookie": clearSessionCookie(),
      "Cache-Control": "no-store",
    },
  });
}
