// One shape for every error body the API answers with (rombak 07 §10.3), so a page shows the
// catalog text of the viewer's language instead of the Indonesian "error" string:
//   string      "Job tidak ditemukan"                         -> legacyText
//   flat        { error, code, messageId?, params? }          -> its fields, legacyText = error
//   nested      { error: { code, messageId?, params?, … } }   -> the inner fields
//   no body                                                   -> messageId "http.s<status>"
// A code with a detail ("glyph_unsupported:U+1F602") passes the detail as params.detail. Pure:
// client components and lib modules use it.
import { HTTP_STATUSES, baseCode, httpMessageId, messageIdFor } from "./error-codes.mjs";
import { errorText } from "./i18n/errors.mjs";
import { SOURCE_LOCALE, localeOfIntl } from "./i18n/locales.mjs";

const MAX_PARAMS = 8;
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => (typeof value === "string" && value.trim() ? value : null);

// Primitives only, at most 8 keys (07 §10.1).
function cleanParams(value) {
  if (!isObject(value)) return {};
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (Object.keys(out).length >= MAX_PARAMS) break;
    if (typeof item === "string" || (typeof item === "number" && Number.isFinite(item))) out[key] = item;
  }
  return out;
}

/**
 * `{ code, messageId, params, legacyText, status }` of any error body. `domain` names the
 * messageId of a body that has a code and no messageId (an old server); it defaults to web.
 */
export function normalizeApiError(body, status, { domain = "web" } = {}) {
  const httpStatus = Number.isInteger(status) ? status : null;
  let code = null;
  let messageId = null;
  let params = {};
  let legacyText = null;
  if (typeof body === "string") {
    legacyText = text(body);
  } else if (isObject(body)) {
    const nested = isObject(body.error) ? body.error : null;
    const fields = nested ?? body;
    code = text(fields.code);
    messageId = text(fields.messageId);
    params = cleanParams(fields.params);
    legacyText = nested ? text(nested.message) : text(body.error);
  }
  if (code && !messageId) messageId = messageIdFor(code, domain);
  if (code && code.includes(":") && params.detail === undefined) params.detail = code.slice(code.indexOf(":") + 1);
  if (!code && !messageId && !legacyText && httpStatus !== null && httpStatus >= 400) {
    messageId = httpMessageId(HTTP_STATUSES.includes(httpStatus) ? httpStatus : httpStatus >= 500 ? 500 : 400);
  }
  return { code: code ? code : null, messageId, params, legacyText, status: httpStatus };
}

/** The normalised error of a fetch Response; its body is read once (JSON, else text). */
export async function readApiError(response, options) {
  let body = null;
  try {
    const raw = await response.text();
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
  } catch {
    body = null;
  }
  return normalizeApiError(body, response?.status, options);
}

/**
 * The text to show for `err`. In the source language the server's own Indonesian sentence is
 * the most specific text and stays what the viewer reads; in any other language the catalog
 * text of its messageId (errors.<messageId>), else the server's sentence, else
 * errors.web.unknown. `t` translates over the whole catalog (useTranslations() without a
 * namespace); `locale` is a registry code or a use-intl locale ("id", "en-US").
 */
export function apiErrorText(t, err, { locale } = {}) {
  if (err?.legacyText && localeOfIntl(locale) === SOURCE_LOCALE) return err.legacyText;
  return errorText(t, err);
}

/** The base code of an error, for help links and code switches. */
export function apiErrorCode(err) {
  return err?.code ? baseCode(err.code) : null;
}
