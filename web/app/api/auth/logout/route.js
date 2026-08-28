import { clearSessionCookie } from "../../../../lib/auth.mjs";

export const runtime = "nodejs";

export async function POST(request) {
  return new Response(null, {
    status: 303,
    headers: {
      Location: new URL("/login", request.url).toString(),
      "Set-Cookie": clearSessionCookie(),
      "Cache-Control": "no-store",
    },
  });
}
