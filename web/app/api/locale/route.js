// POST /api/locale (rombak 07 §9.2): the language picker's route. Public: it only writes the
// potongin_locale cookie, so the proxy lets it through (proxy.js) and it checks the origin
// itself. Checks run in the order method -> same origin -> rate limit -> body. A native form
// (the main path: account menu, /login) always gets a 303 to a same-site page, with
// ?bahasa=gagal when the change was refused, so a visitor without JS never sees raw JSON.
import { createHash } from "node:crypto";

import { loadNamespaces } from "../../../lib/i18n/catalog.mjs";
import { localeCookie } from "../../../lib/i18n/cookie.mjs";
import { SOURCE_LOCALE, enabledLocales } from "../../../lib/i18n/locales.mjs";
import { safeNextPath } from "../../../lib/login-view.mjs";
import { TokenBucketLimiter, retryAfterSeconds } from "../../../lib/rate-limit.mjs";
import { readBoundedUrlEncodedForm, sameOriginMutation, trustedClientIp } from "../../../lib/request-security.mjs";
import { withErrorCodes } from "../../../lib/api-error-response.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY = 1024;
const FAILED_PARAM = "bahasa";
const FAILED_VALUE = "gagal";
const NO_STORE = Object.freeze({ "Cache-Control": "no-store" });
const FORM_TYPE = /^application\/x-www-form-urlencoded(?:\s*;|$)/i;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;

class Refusal extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

// The Indonesian text every error response keeps next to its code (07 §10.1).
function errorBody(code) {
  const text = loadNamespaces(SOURCE_LOCALE, ["errors.web"]).errors.web;
  return { error: text[code] ?? text.unknown, code, messageId: `web.${code}` };
}

function errorResponse(status, code, headers = {}) {
  return Response.json(errorBody(code), { status, headers: { ...NO_STORE, ...headers } });
}

/** `value` when it is a same-site path that stays one after URL normalisation, else null. */
function sitePath(value) {
  if (typeof value !== "string" || safeNextPath(value) !== value) return null;
  try {
    // "/..//host" passes the prefix checks but normalises to the protocol-relative "//host".
    return new URL(value, "http://site.invalid").pathname.startsWith("//") ? null : value;
  } catch {
    return null;
  }
}

/** The path of a same-origin Referer, or null. */
function refererPath(request) {
  const referer = request.headers.get("referer");
  if (!referer) return null;
  try {
    const url = new URL(referer);
    if (url.host !== request.headers.get("host")) return null;
    return sitePath(`${url.pathname}${url.search}`);
  } catch {
    return null;
  }
}

// next (unchanged) -> same-origin Referer -> "/". Never safeNextPath's /dashboard fallback: a
// visitor of /login would land on a page that sends them back to /login.
function destination(request, next) {
  return sitePath(next) ?? refererPath(request) ?? "/";
}

function withFailure(target) {
  const url = new URL(target, "http://site.invalid");
  url.searchParams.set(FAILED_PARAM, FAILED_VALUE);
  return sitePath(`${url.pathname}${url.search}`) ?? `/?${FAILED_PARAM}=${FAILED_VALUE}`;
}

function redirect(location, headers = {}) {
  return new Response(null, { status: 303, headers: { Location: location, ...NO_STORE, ...headers } });
}

async function readJsonBody(request) {
  if (!request.body) throw new Refusal(400, "invalid_request");
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY) {
        await reader.cancel();
        throw new Refusal(413, "request_too_large");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
  } catch {
    throw new Refusal(400, "invalid_request");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Refusal(400, "invalid_request");
  return parsed;
}

const methodNotAllowed = withErrorCodes((request) => {
  const headers = { ...NO_STORE, Allow: "POST" };
  if (request?.method === "HEAD") return new Response(null, { status: 405, headers });
  return Response.json(errorBody("method_not_allowed"), { status: 405, headers });
});

export function createLocaleRoute({
  env = process.env,
  // 20 a minute per client (07 §9.2; 02 §7.1 kind "locale"), in this process.
  limiter = new TokenBucketLimiter({ capacity: 20, refillPerSecond: 20 / 60, maxKeys: 10_000 }),
} = {}) {
  const rateKey = (request) => `locale:${createHash("sha256").update(trustedClientIp(request, env) ?? "untrusted-proxy-client").digest("hex")}`;

  async function POST(request) {
    if (!sameOriginMutation(request)) return errorResponse(403, "csrf_rejected");
    const contentType = request.headers.get("content-type") || "";
    const isForm = FORM_TYPE.test(contentType);
    let next = null;
    // A native form goes back to its page; a JSON client reads the status.
    const refuse = (status, code, headers = {}) => (isForm
      ? redirect(withFailure(destination(request, next)), headers)
      : errorResponse(status, code, headers));

    const verdict = limiter.take(rateKey(request));
    if (!verdict.allowed) return refuse(429, "rate_limited", { "Retry-After": retryAfterSeconds(verdict.retryAfterMs) });

    const declared = request.headers.get("content-length");
    if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_BODY) return refuse(413, "request_too_large");

    let locale;
    try {
      if (isForm) {
        // One refusal for a broken body and an undeclared one over the cap (400 invalid_request).
        const fields = await readBoundedUrlEncodedForm(request, MAX_BODY).catch(() => {
          throw new Refusal(400, "invalid_request");
        });
        next = fields.get("next");
        locale = fields.get("locale");
        if (locale === null) throw new Refusal(400, "invalid_request");
      } else if (JSON_TYPE.test(contentType)) {
        locale = (await readJsonBody(request)).locale;
      } else {
        throw new Refusal(400, "invalid_request");
      }
    } catch (error) {
      if (error instanceof Refusal) return refuse(error.status, error.code);
      throw error;
    }

    if (typeof locale !== "string" || !enabledLocales(env).includes(locale)) return refuse(400, "locale_unsupported");
    const cookie = { "Set-Cookie": localeCookie(locale) };
    if (isForm) return redirect(destination(request, next), cookie);
    return Response.json({ locale }, { status: 200, headers: { ...NO_STORE, ...cookie } });
  }

  return { POST };
}

const route = createLocaleRoute();

async function handlePOST(request) {
  return route.POST(request);
}

export const GET = methodNotAllowed;
export const HEAD = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = methodNotAllowed;

export const POST = withErrorCodes(handlePOST);
