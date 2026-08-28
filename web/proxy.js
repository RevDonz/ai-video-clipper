import { NextResponse } from "next/server";

import { isAuthorized } from "./lib/auth.mjs";

export function proxy(request) {
  if (isAuthorized(request)) return NextResponse.next();
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Sesi login diperlukan" }, { status: 401 });
  }
  const destination = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  const query = new URLSearchParams();
  if (destination !== "/") query.set("next", destination);
  const location = query.size ? `/login?${query}` : "/login";
  return new Response(null, { status: 307, headers: { Location: location } });
}

export const config = {
  matcher: ["/((?!api/health|api/auth/login|login|_next/static|_next/image|favicon.ico).*)"],
};
