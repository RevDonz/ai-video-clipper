import { NextResponse } from "next/server";

import { isAuthorized } from "./lib/auth.mjs";

export function proxy(request) {
  if (request.nextUrl.pathname === "/") return NextResponse.next();
  if (isAuthorized(request)) return NextResponse.next();
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Sesi login diperlukan" }, { status: 401 });
  }
  const destination = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  const login = request.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  if (destination !== "/dashboard") login.searchParams.set("next", destination);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!api/health|api/auth/login|login|_next/static|_next/image|favicon.ico).*)"],
};
