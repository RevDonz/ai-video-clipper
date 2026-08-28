import { requireAuth } from "./lib/auth.mjs";

export function proxy(request) {
  return requireAuth(request) || undefined;
}

export const config = {
  matcher: ["/((?!api/health|_next/static|_next/image|favicon.ico).*)"],
};
