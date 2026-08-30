import {
  authenticateCredentials,
  createSessionToken,
  sessionCookie,
} from "../../../../lib/auth.mjs";

export const runtime = "nodejs";

function safeDestination(value) {
  return typeof value === "string"
    && value.startsWith("/")
    && !value.startsWith("//")
    && !value.includes("\\")
    && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : "/dashboard";
}

export async function POST(request) {
  const form = await request.formData();
  const username = String(form.get("username") || "");
  const password = String(form.get("password") || "");
  const next = safeDestination(String(form.get("next") || "/dashboard"));
  if (!authenticateCredentials(username, password)) {
    const query = new URLSearchParams({ error: "1" });
    if (next !== "/dashboard") query.set("next", next);
    return new Response(null, {
      status: 303,
      headers: { Location: `/login?${query}` },
    });
  }
  return new Response(null, {
    status: 303,
    headers: {
      Location: next,
      "Set-Cookie": sessionCookie(createSessionToken()),
      "Cache-Control": "no-store",
    },
  });
}
