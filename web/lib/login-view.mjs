// The login form (app/login/page.jsx) and its route (app/api/auth/login/route.js). The words are
// in the catalogs (errors.web.login_invalid, auth.login.limited); this module only names them.

const LOGIN_ERRORS = Object.freeze({ 1: "invalid", limit: "limited" });

/** Which message the route's ?error= code asks for: "invalid", "limited", or null. */
export function loginErrorCode(code) {
  return typeof code === "string" && Object.hasOwn(LOGIN_ERRORS, code) ? LOGIN_ERRORS[code] : null;
}

/** Where to go after logging in: a same-site path, else the dashboard. */
export function safeNextPath(value) {
  return typeof value === "string"
    && value.startsWith("/")
    && !value.startsWith("//")
    && !value.includes("\\")
    && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : "/dashboard";
}

/**
 * Where the login page's language form comes back to (POST /api/locale): /login, keeping a
 * same-site ?next, without the old ?error or ?bahasa.
 */
export function loginLocaleNext(params) {
  const next = safeNextPath(params?.next);
  return next === "/dashboard" ? "/login" : `/login?${new URLSearchParams({ next })}`;
}
