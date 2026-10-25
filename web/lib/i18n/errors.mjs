// Error codes to catalog text (rombak 07 §10). A messageId is "<domain>.<code>" without the
// "errors." prefix; its key is "errors." + messageId. A code that carries a detail
// ("glyph_unsupported:U+1F602") keys on the part before ":" and passes the rest as {detail}.
// Pure, so client components use it too; the Indonesian text for a response's "error" field
// comes from legacyMessage() in server.mjs.

/** { code, detail } of a code that may carry ":<detail>". */
export function splitDetail(code) {
  const text = String(code ?? "");
  const index = text.indexOf(":");
  return index < 0 ? { code: text, detail: null } : { code: text.slice(0, index), detail: text.slice(index + 1) };
}

function baseMessageId(messageId) {
  const text = String(messageId ?? "");
  const dot = text.indexOf(".");
  if (dot < 0) return splitDetail(text).code;
  return `${text.slice(0, dot)}.${splitDetail(text.slice(dot + 1)).code}`;
}

export function errorKey(messageId) {
  return `errors.${baseMessageId(messageId)}`;
}

function paramsOf(err) {
  const params = { ...(err?.params ?? {}) };
  const { detail } = splitDetail(err?.code);
  if (detail !== null && params.detail === undefined) params.detail = detail;
  return params;
}

/** errors.<messageId> when the catalog has it, else the server's own text, else errors.web.unknown. */
export function errorText(t, err) {
  if (err?.messageId) {
    const key = errorKey(err.messageId);
    if (t.has(key)) return t(key, paramsOf(err));
  }
  if (typeof err?.legacyText === "string" && err.legacyText) return err.legacyText;
  return t("errors.web.unknown");
}

/** hints.<messageId>, or null. */
export function hintText(t, err) {
  if (!err?.messageId) return null;
  const key = `hints.${baseMessageId(err.messageId)}`;
  return t.has(key) ? t(key, paramsOf(err)) : null;
}

/** The help page anchor of an error: the base code, the same in every language. */
export function helpAnchor(err) {
  return `/bantuan#${splitDetail(err?.code).code}`;
}
