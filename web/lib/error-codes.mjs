// The error code registry of the web domain and the rules that turn a code into a messageId
// (rombak 07 §10.2). A messageId is "<domain>.<code>" without the "errors." prefix; the catalog
// key is "errors." + messageId (web/messages/<locale>/errors.json). Pure: the client reads it too.
//
// Every code here needs errors.web.<code> in every locale (tests/i18n-error-codes.test.mjs).
// The other domains keep their own source of truth: download (download-errors.mjs), storage
// (STORAGE_ERROR_CODES), llm (src/ai_clipper/llm.py ERROR_CODES), edit (edit_v2/errors.py
// _MESSAGES, plus EDIT_WEB_CODES below), editor (COMMAND_MESSAGES), editor_ai (editor-ai.mjs).

export const ERROR_DOMAINS = Object.freeze([
  "web", "http", "download", "storage", "llm", "edit", "editor", "editor_ai", "social", "performance", "account", "global",
]);

// 07 §10.2 names these first; the rest are the codes the routes under web/app/api answer with
// today that belong to no other domain.
export const WEB_ERROR_CODES = Object.freeze([
  // 07 §10.2
  "invalid_request", "unauthorized", "csrf_rejected", "rate_limited", "queue_capacity_reached",
  "job_service_unavailable", "request_too_large", "method_not_allowed", "not_found", "job_not_found",
  "login_invalid", "locale_unsupported", "db_busy", "db_unavailable",
  "password_change_required", "reauth_required", "user_queue_full", "user_rate_limited", "user_storage_quota",
  "source_host_not_allowed", "source_rejected_kind", "source_private_address", "source_rejected_duration",
  "source_rejected_format", "source_rejected_codec", "source_platform_off",
  "unknown",
  // The code of an error body that came without one, by HTTP status (STATUS_CODES).
  "forbidden", "conflict", "length_required", "unsupported_media_type", "range_not_satisfiable",
  "internal_error", "bad_gateway", "service_unavailable", "gateway_timeout",
  // Projects (app/api/jobs/**).
  "job_id_invalid", "job_read_failed", "delete_failed", "cancel_failed", "job_finished", "job_deleting",
  "subtitle_invalid", "selection_mode_retired", "time_range_invalid",
  "file_not_found", "file_invalid", "file_unavailable", "path_forbidden",
  // Clip text, clip library, ZIP (lib/clip-text-api.mjs, clip-library.mjs, clips-zip.mjs).
  "read_failed", "save_failed", "clip_not_found", "title_empty", "title_too_long", "description_too_long",
  "no_transcript", "llm_disabled", "llm_settings", "llm_unavailable", "timeout", "invalid_output", "busy",
  "payload_too_large", "backend_unavailable",
  "not_ready", "no_clips", "invalid_clips", "unknown_clip", "clip_failed", "file_missing",
  "zip_config_invalid", "zip_too_large",
  // Pengaturan (lib/llm-settings*.mjs, transcription-settings.mjs, youtube-cookies.mjs,
  // default-watermark.mjs, system-info).
  "bad_request", "internal", "invalid", "config", "corrupt", "unreadable", "exists", "nothing_to_import",
  "secret_missing", "settings_unavailable", "key_unreadable", "auth", "network", "bad_response", "too_large",
  "blocked", "redirect", "engine_error", "engine_unavailable", "http_error",
  "system_info_failed", "llm_status_unreadable", "invalid_watermark",
  "cookies_empty", "cookies_too_large", "cookies_utf16", "cookies_not_text", "cookies_json",
  "cookies_not_netscape", "cookies_no_youtube", "cookies_expired",
  // Konteks Tren and its ingest tokens (lib/trend-context.mjs, ingest-tokens.mjs).
  "invalid_json", "invalid_body", "invalid_item", "invalid_label", "invalid_length", "invalid_type",
  "invalid_value", "missing_field", "unknown_field", "duplicate", "expired", "owned_by_other_source",
  "store_full", "too_many_items", "body_too_large", "storage_unavailable",
  "missing_token", "invalid_token", "revoked_token", "insufficient_scope", "label_taken", "token_limit",
  // Editor routes, for a code that edit_v2 does not know (lib/clip-edit.mjs, clip-renders.mjs).
  "editor_disabled", "uploads_disabled", "document_invalid", "revision_conflict", "idempotency_conflict",
  "precondition_required", "analysis_missing", "source_missing", "render_finished", "not_cancellable",
  "storage_admission_lost", "superseded",
]);

// Codes the web routes answer with messageId edit.<code> that edit_v2/errors.py does not list
// (lib/asset-upload.mjs, lib/default-logo.mjs). Their errors.edit.<code> text is the web's own.
export const EDIT_WEB_CODES = Object.freeze([
  "uploads_disabled", "length_required", "asset_empty", "asset_type_unsupported", "asset_too_large",
  "asset_rejected", "asset_quota_exceeded", "settings_unavailable",
]);

// The editor's AI routes (lib/editor-ai.mjs): its task codes and its route codes.
export const EDITOR_AI_ROUTE_CODES = Object.freeze([
  "invalid_request", "csrf_rejected", "editor_disabled", "not_found", "payload_too_large", "rate_limited",
  "backend_unavailable",
]);

// The statuses errors.http.s<status> has a text for (a response without a readable body).
export const HTTP_STATUSES = Object.freeze([400, 401, 403, 404, 413, 429, 500, 502, 503]);

// The code of an error body that came without one.
export const STATUS_CODES = Object.freeze({
  400: "invalid_request", 401: "unauthorized", 403: "forbidden", 404: "not_found", 405: "method_not_allowed",
  409: "conflict", 411: "length_required", 413: "request_too_large", 415: "unsupported_media_type",
  416: "range_not_satisfiable", 422: "invalid_request", 429: "rate_limited", 500: "internal_error",
  502: "bad_gateway", 503: "service_unavailable", 504: "gateway_timeout",
});

/** The code for an error status without its own code. */
export function statusCode(status) {
  const value = Number(status);
  if (Object.hasOwn(STATUS_CODES, value)) return STATUS_CODES[value];
  return value >= 500 ? "internal_error" : "invalid_request";
}

/** The code without its detail: "glyph_unsupported:U+1F602" -> "glyph_unsupported". */
export function baseCode(code) {
  const text = String(code ?? "");
  const index = text.indexOf(":");
  return index < 0 ? text : text.slice(0, index);
}

/** "<domain>.<base code>"; the domain defaults to web. */
export function messageIdFor(code, domain = "web") {
  return `${ERROR_DOMAINS.includes(domain) ? domain : "web"}.${baseCode(code)}`;
}

/** The messageId of a body without a readable code: "http.s<status>". */
export function httpMessageId(status) {
  return `http.s${Number.isInteger(Number(status)) ? Number(status) : 500}`;
}
