import { NextResponse } from "next/server";

import { isAuthorized } from "./lib/auth.mjs";

export function proxy(request) {
  if (isAuthorized(request)) return NextResponse.next();
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Sesi login diperlukan" }, { status: 401 });
  }
  const login = new URL("/login", request.url);
  const destination = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  if (destination !== "/") login.searchParams.set("next", destination);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!api/health|api/auth/login|login|_next/static|_next/image|favicon.ico).*)"],
};
