import { NextResponse } from "next/server.js";

import { isAuthorized } from "./lib/auth.mjs";
import { isLandingMediaPath } from "./lib/landing-media.mjs";

export function proxy(request) {
  if (request.nextUrl.pathname === "/") return NextResponse.next();
  // The public landing's own pictures and clip (public/landing), by exact path only.
  if (isLandingMediaPath(request.nextUrl.pathname)) return NextResponse.next();
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
// POST /api/jobs/:id/assets (logo and music uploads, up to 50 MB) is excluded for the same reason
// and checks the session itself; serving an asset (/api/jobs/:id/assets/:sha) still runs the proxy.
// /api/settings/logo (the Pengaturan default logo, up to 10 MB) likewise: its GET, POST and
// DELETE check the session (and mutations their origin) themselves.
// /api/settings/youtube-cookies (the Pengaturan cookies.txt, up to 1 MB, read with its own cap)
// is excluded on the same terms.
// /api/ingest/trends is the endpoint of the owner's agent (Hermes), which has no session
// cookie: it is excluded too and authenticates every request itself with a ptk_ bearer token
// (cookies are refused there), reading its body with a 256 KiB cap.
// /api/locale: the UI language preference cookie, without user data, also used on /login before
// a session exists (rombak 07 §9.2). It checks its origin and rate limit itself; once there are
// user accounts it checks the session itself too.
export const config = {
  matcher: ["/((?!api/health|api/auth/login|api/jobs/?$|api/jobs/[^/]+/assets/?$|api/settings/logo/?$|api/settings/youtube-cookies/?$|api/ingest/trends/?$|api/locale/?$|login|_next/static|_next/image|favicon.ico).*)"],
};
