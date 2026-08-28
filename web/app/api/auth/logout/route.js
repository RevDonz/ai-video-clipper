import { clearSessionCookie } from "../../../../lib/auth.mjs";

export const runtime = "nodejs";

export async function POST() {
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/login",
      "Set-Cookie": clearSessionCookie(),
      "Cache-Control": "no-store",
    },
  });
}
