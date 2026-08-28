import {
  authenticateCredentials,
  createSessionToken,
  sessionCookie,
} from "../../../../lib/auth.mjs";

export const runtime = "nodejs";

function safeDestination(value) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//")
    ? value
    : "/";
}

export async function POST(request) {
  const form = await request.formData();
  const username = String(form.get("username") || "");
  const password = String(form.get("password") || "");
  const next = safeDestination(String(form.get("next") || "/"));
  if (!authenticateCredentials(username, password)) {
    const login = new URL("/login", request.url);
    login.searchParams.set("error", "1");
    if (next !== "/") login.searchParams.set("next", next);
    return Response.redirect(login, 303);
  }
  return new Response(null, {
    status: 303,
    headers: {
      Location: new URL(next, request.url).toString(),
      "Set-Cookie": sessionCookie(createSessionToken()),
      "Cache-Control": "no-store",
    },
  });
}
