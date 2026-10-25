// Every error answer of web/app/api carries a code (rombak 07 §10.1, CONTRACTS §5.65; ratchet 0).
// Each route.js wraps its exported methods with withErrorCodes(); the wrapper only adds fields to
// a body that has no code, so a coded body stays byte for byte what it was:
//   flat    { error }            -> + code from the HTTP status (STATUS_CODES) + messageId
//   nested  { error: { … } }     -> + error.code + error.messageId
//   text    "File not found"     -> { error: "File not found", code, messageId }
// A body that already has its code passes unchanged (with or without its messageId: the client
// reads "<domain>.<code>" then, lib/api-error.mjs), and so do an empty body (the client reads
// http.s<status>), an answer below 400 and a HEAD answer. A messageId names the first of the
// route's `domains` whose Indonesian catalog has the code, else web. Server only (reads
// web/messages through catalog.mjs).
import { baseCode, messageIdFor, statusCode } from "./error-codes.mjs";
import { loadNamespace } from "./i18n/catalog.mjs";
import { SOURCE_LOCALE } from "./i18n/locales.mjs";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hasCode = (fields) => typeof fields?.code === "string" && fields.code !== "";
const DEFAULT_DOMAINS = Object.freeze(["web"]);
const MAX_TEXT = 300;

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

/** The Indonesian catalog text of a web code. */
export function legacyErrorText(code) {
  const web = sourceErrors().web ?? {};
  return web[baseCode(code)] ?? web.unknown;
}

/** `body` with the code fields an error answer of `status` needs, or null when it has its code. */
export function codedErrorBody(body, status, domains = DEFAULT_DOMAINS) {
  if (!isObject(body)) return null;
  const code = statusCode(status);
  const fields = { code, messageId: resolveMessageId(code, domains) };
  if (isObject(body.error)) return hasCode(body.error) ? null : { ...body, error: { ...body.error, ...fields } };
  return hasCode(body) ? null : { ...body, ...fields };
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
  if (String(method).toUpperCase() === "HEAD" || response.body === null) return response;
  let raw;
  try {
    raw = await response.clone().text();
  } catch {
    return response;
  }
  const line = raw.trim();
  if (!line) return response;
  if (/\bjson\b/i.test(response.headers.get("content-type") || "")) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
    if (isObject(parsed)) {
      const next = codedErrorBody(parsed, response.status, domains);
      return next ? rebuilt(response, next) : response;
    }
  }
  const code = statusCode(response.status);
  return rebuilt(response, {
    error: line.length <= MAX_TEXT ? line : legacyErrorText(code),
    code,
    messageId: resolveMessageId(code, domains),
  });
}

/**
 * A route method whose error answers carry a code. `domains`: where the messageId of a code is
 * looked up first ("edit" for the editor routes); web is always last.
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
