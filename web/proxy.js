import { NextResponse } from "next/server.js";

import { isAuthorized } from "./lib/auth.mjs";

export function proxy(request) {
  if (request.nextUrl.pathname === "/") return NextResponse.next();
  if (isAuthorized(request)) return NextResponse.next();
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Sesi login diperlukan", code: "unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  const destination = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  const login = request.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  if (destination !== "/dashboard") login.searchParams.set("next", destination);
  return NextResponse.redirect(login);
}

// POST /api/jobs streams video uploads to disk. A proxy in front of it makes Next buffer the
// body up to proxyClientMaxBodySize (10 MB) and hand the route a truncated body, so the upload
// route is excluded here; it checks the session itself (requireAuth + sameOriginMutation).
// /api/ingest/trends is the endpoint of the owner's agent (Hermes), which has no session
// cookie: it is excluded too and authenticates every request itself with a ptk_ bearer token
// (cookies are refused there), reading its body with a 256 KiB cap.
export const config = {
  matcher: ["/((?!api/health|api/auth/login|api/jobs/?$|api/ingest/trends/?$|login|_next/static|_next/image|favicon.ico).*)"],
};
