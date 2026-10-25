// Every error answer of web/app/api carries a code and a messageId (rombak 07 §10.1, CONTRACTS
// §5.65). Each route.js wraps its exported methods with withErrorCodes(); the wrapper only adds
// fields, so a body keeps its shape, its Indonesian "error" string and every old field:
//   flat    { error, code } -> + messageId (+ params.detail for "code:detail")
//   flat    { error }       -> + code from the HTTP status (STATUS_CODES) + messageId
//   nested  { error: { code } } -> + error.messageId
//   text or empty body (a GET, never a HEAD) -> { error: <the text or the catalog's id text>, code, messageId }
// A messageId names the first of the route's `domains` whose Indonesian catalog has the code,
// else the last domain (web). An answer below 400, a HEAD answer and a body that already has its
// messageId pass unchanged. Server only (reads web/messages through catalog.mjs).
import { baseCode, messageIdFor, statusCode } from "./error-codes.mjs";
import { loadNamespace } from "./i18n/catalog.mjs";
import { SOURCE_LOCALE } from "./i18n/locales.mjs";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const DEFAULT_DOMAINS = Object.freeze(["web"]);

function sourceErrors() {
  return loadNamespace(SOURCE_LOCALE, "errors");
}

/** The messageId of `code` for a route of `domains` (the first whose catalog has the code). */
export function resolveMessageId(code, domains = DEFAULT_DOMAINS) {
  const list = domains.length ? domains : DEFAULT_DOMAINS;
  const base = baseCode(code);
  const errors = sourceErrors();
  const domain = list.find((name) => isObject(errors[name]) && typeof errors[name][base] === "string") ?? list.at(-1);
  return messageIdFor(base, domain);
}

/** The Indonesian catalog text of a code in the web domain, for an answer without its own text. */
export function legacyErrorText(code) {
  const web = sourceErrors().web ?? {};
  return web[baseCode(code)] ?? web.unknown;
}

function withDetail(fields, code) {
  if (typeof code !== "string" || !code.includes(":")) return fields;
  const params = isObject(fields.params) ? fields.params : {};
  if (params.detail !== undefined) return fields;
  return { ...fields, params: { ...params, detail: code.slice(code.indexOf(":") + 1) } };
}

/** `body` with the code fields an error answer of `status` needs, or null when it has them. */
export function codedErrorBody(body, status, domains = DEFAULT_DOMAINS) {
  if (!isObject(body)) return null;
  if (isObject(body.error)) {
    const inner = body.error;
    if (typeof inner.messageId === "string" && typeof inner.code === "string") return null;
    const code = typeof inner.code === "string" && inner.code ? inner.code : statusCode(status);
    const next = withDetail({ ...inner, code, messageId: typeof inner.messageId === "string" ? inner.messageId : resolveMessageId(code, domains) }, code);
    return { ...body, error: next };
  }
  if (typeof body.code === "string" && body.code && typeof body.messageId === "string") return null;
  const code = typeof body.code === "string" && body.code ? body.code : statusCode(status);
  const messageId = typeof body.messageId === "string" ? body.messageId : resolveMessageId(code, domains);
  return withDetail({ ...body, code, messageId }, code);
}

function rebuilt(response, body) {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { status: response.status, statusText: response.statusText, headers });
}

/** `response` with the code fields added to its error body (see the head of this file). */
export async function withErrorCode(response, { domains = DEFAULT_DOMAINS, method = "GET" } = {}) {
  if (!(response instanceof Response) || response.status < 400) return response;
  if (String(method).toUpperCase() === "HEAD") return response;
  const type = response.headers.get("content-type") || "";
  let raw;
  try {
    raw = await response.clone().text();
  } catch {
    return response;
  }
  if (/\bjson\b/i.test(type)) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
    if (isObject(parsed)) {
      const next = codedErrorBody(parsed, response.status, domains);
      return next ? rebuilt(response, next) : response;
    }
  }
  const code = statusCode(response.status);
  const line = raw.trim();
  return rebuilt(response, {
    error: line && line.length <= 300 ? line : legacyErrorText(code),
    code,
    messageId: resolveMessageId(code, domains),
  });
}

/**
 * A route method whose error answers carry a code and a messageId. `domains`: where the
 * messageId of a code is looked up first ("edit" for the editor routes); web is always last.
 */
export function withErrorCodes(handler, { domains = [] } = {}) {
  const list = Object.freeze([...domains.filter((name) => name !== "web"), "web"]);
  const wrapped = async function errorCoded(request, context) {
    const response = await handler(request, context);
    return withErrorCode(response, { domains: list, method: request?.method });
  };
  wrapped.errorDomains = list;
  return wrapped;
}
