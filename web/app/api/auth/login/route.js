import {
  authenticateCredentials,
  createSessionToken,
  identityAvailable,
  sessionCookie as legacySessionCookie,
} from "../../../../lib/auth.mjs";
import { isEnabled, localeEntry, enabledLocales } from "../../../../lib/i18n/locales.mjs";
import { localeCookie, readLocaleCookie } from "../../../../lib/i18n/cookie.mjs";
import { parseAcceptLanguage } from "../../../../lib/i18n/resolve.mjs";
import { DEFAULT_LOCALE } from "../../../../lib/i18n/locales.mjs";
import {
  authRateLimitKeys,
  readBoundedUrlEncodedForm,
  sameOriginMutation,
  sharedAuthLimiter,
} from "../../../../lib/request-security.mjs";
import { safeNextPath } from "../../../../lib/login-view.mjs";
import { withErrorCodes } from "../../../../lib/api-error-response.mjs";
import { PASSWORD_CHANGE_PAGE } from "../../../../lib/auth.mjs";
import { PasswordBusyError, verifyLogin } from "../../../../lib/passwords.mjs";
import { clearLegacyCookie, createSession, sessionCookie } from "../../../../lib/sessions.mjs";
import { markLogin, setUserLocale } from "../../../../lib/users.mjs";

export const runtime = "nodejs";

// The language this login leaves on the device, and whether the account takes it (07 §9.4): a saved
// language that is switched on wins; a saved one that is switched off changes nothing; none yet (or
// one no longer in the registry) is filled from the cookie, Accept-Language, then id.
function loginLocale(user, request) {
  if (localeEntry(user.locale)) {
    return isEnabled(user.locale) ? { cookie: user.locale, save: false } : { cookie: null, save: false };
  }
  const fromCookie = readLocaleCookie(request.headers.get("cookie"));
  const chosen = (fromCookie && isEnabled(fromCookie) ? fromCookie : null)
    ?? parseAcceptLanguage(request.headers.get("accept-language"), enabledLocales())
    ?? DEFAULT_LOCALE;
  return { cookie: chosen, save: true };
}

async function handlePOST(request) {
  if (!sameOriginMutation(request)) return Response.json({ error: "Origin permintaan tidak diizinkan", code: "csrf_rejected", messageId: "web.csrf_rejected" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  let form;
  try {
    form = await readBoundedUrlEncodedForm(request);
  } catch {
    return Response.json({ error: "Permintaan login tidak valid", code: "invalid_request", messageId: "web.invalid_request" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const username = String(form.get("username") || "");
  const password = String(form.get("password") || "");
  const next = safeNextPath(String(form.get("next") || "/dashboard"));
  const limitKeys = authRateLimitKeys(request, username);
  const authRateLimiter = sharedAuthLimiter("login");
  // The login form is a plain HTML form: both refusals go back to it with a message.
  const refuse = (retryAfterSeconds) => {
    const query = new URLSearchParams({ error: retryAfterSeconds ? "limit" : "1" });
    if (next !== "/dashboard") query.set("next", next);
    const headers = { Location: `/login?${query}` };
    if (retryAfterSeconds) Object.assign(headers, { "Cache-Control": "no-store", "Retry-After": String(retryAfterSeconds) });
    return new Response(null, { status: 303, headers });
  };
  // A throttled client is refused before the password is checked, so guessing cannot go on
  // until the right password happens to come through.
  const blocked = limitKeys.map((key) => authRateLimiter.blocked(key)).find((entry) => entry.blocked);
  if (blocked) return refuse(blocked.retryAfterSeconds);

  const failed = () => {
    const limited = limitKeys.map((key) => authRateLimiter.consume(key)).find((entry) => !entry.allowed);
    return refuse(limited ? limited.retryAfterSeconds : 0);
  };
  const succeeded = (location, cookies) => {
    limitKeys.forEach((key) => authRateLimiter.reset(key));
    const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
    for (const cookie of cookies) headers.append("Set-Cookie", cookie);
    return new Response(null, { status: 303, headers });
  };
  // The v1 cookie: only the APP_* login, only while the user database cannot be used.
  const singleUserLogin = () => (authenticateCredentials(username, password)
    ? succeeded(next, [legacySessionCookie(createSessionToken())])
    : failed());

  if (!identityAvailable()) return singleUserLogin();
  let account;
  let token;
  try {
    account = await verifyLogin(username, password);
    if (!account) return failed();
    ({ token } = createSession(account.user.id, { via: account.via, userAgent: request.headers.get("user-agent") }));
    markLogin(account.user.id);
  } catch (error) {
    if (error instanceof PasswordBusyError) return refuse(error.retryAfterSeconds);
    console.warn(`[auth] login lewat database gagal: ${error?.code ?? "error"}`);
    return singleUserLogin();
  }
  const cookies = [sessionCookie(token), clearLegacyCookie()];
  const locale = loginLocale(account.user, request);
  if (locale.cookie) cookies.push(localeCookie(locale.cookie));
  if (locale.save) {
    try { setUserLocale(account.user.id, locale.cookie); } catch (error) { console.warn(`[auth] bahasa tidak tersimpan: ${error?.code ?? "error"}`); }
  }
  return succeeded(account.user.must_change_password === 1 ? PASSWORD_CHANGE_PAGE : next, cookies);
}

export const POST = withErrorCodes(handlePOST);
