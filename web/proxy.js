import { NextResponse } from "next/server.js";

import { PASSWORD_CHANGE_PAGE, SESSION_COOKIE, cookieValue, currentUser, passwordChangeAllowed } from "./lib/auth.mjs";
import { isLandingMediaPath } from "./lib/landing-media.mjs";
import { upgradeLegacyCookie } from "./lib/session-upgrade.mjs";
import { clearLegacyCookie } from "./lib/sessions.mjs";

function withCookies(response, cookies) {
  for (const cookie of cookies) response.headers.append("Set-Cookie", cookie);
  return response;
}

export function proxy(request) {
  const { pathname } = request.nextUrl;
  if (pathname === "/") return NextResponse.next();
  // The public landing's own pictures and clip (public/landing), by exact path only.
  if (isLandingMediaPath(pathname)) return NextResponse.next();
  const principal = currentUser(request);
  if (!principal) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "Sesi login diperlukan", code: "unauthorized", messageId: "web.unauthorized" },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }
    const destination = `${pathname}${request.nextUrl.search}`;
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    login.search = "";
    if (destination !== "/dashboard") login.searchParams.set("next", destination);
    return NextResponse.redirect(login);
  }
  if (principal.mustChangePassword && pathname !== PASSWORD_CHANGE_PAGE && !passwordChangeAllowed(request.method, pathname)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "Ganti kata sandi dulu", code: "password_change_required", messageId: "web.password_change_required" },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }
    const change = request.nextUrl.clone();
    change.pathname = PASSWORD_CHANGE_PAGE;
    change.search = "";
    return NextResponse.redirect(change);
  }
  // A v1 cookie upgrades here, once; a failure leaves it in place and the request still passes.
  // Next to a valid s2 cookie it is only cleared (rombak 02 §4.3).
  if (cookieValue(request, SESSION_COOKIE)) {
    const cookies = principal.v1ExpiresAt ? upgradeLegacyCookie(request, principal)
      : principal.via === "v1" ? []
        : [clearLegacyCookie()];
    return withCookies(NextResponse.next(), cookies);
  }
  return NextResponse.next();
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
// a session exists (rombak 07 §9.2). It checks its origin and rate limit itself, and the session
// itself before it writes users.locale.
export const config = {
  matcher: ["/((?!api/health|api/auth/login|api/jobs/?$|api/jobs/[^/]+/assets/?$|api/settings/logo/?$|api/settings/youtube-cookies/?$|api/ingest/trends/?$|api/locale/?$|login|_next/static|_next/image|favicon.ico).*)"],
};
