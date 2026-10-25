// The error shapes of the API and their one normal form (rombak 07 §10.1, §10.3; i18n M2):
// lib/api-error.mjs reads any body on the client, lib/api-error-response.mjs adds the code
// fields to a route's error answers without changing anything else.
import assert from "node:assert/strict";
import test from "node:test";

import { createTranslator } from "use-intl/core";

import { apiErrorCode, apiErrorMessage, apiErrorText, normalizeApiError, readApiError } from "../lib/api-error.mjs";
import { codedErrorBody, legacyErrorText, resolveMessageId, withErrorCode, withErrorCodes } from "../lib/api-error-response.mjs";
import { loadNamespaces } from "../lib/i18n/catalog.mjs";

const translator = (locale) => createTranslator({ locale, messages: loadNamespaces(locale, ["errors"]) });

// --- normalizeApiError --------------------------------------------------------------------

test("a flat body keeps its fields and its Indonesian text as legacyText", () => {
  assert.deepEqual(normalizeApiError({ error: "Sesi login diperlukan", code: "unauthorized", messageId: "web.unauthorized" }, 401), {
    code: "unauthorized", messageId: "web.unauthorized", params: {}, legacyText: "Sesi login diperlukan", status: 401,
  });
});

test("a nested body is read from inside error", () => {
  assert.deepEqual(normalizeApiError({ error: { code: "backend_unavailable", messageId: "edit.backend_unavailable", ref: "x" } }, 503), {
    code: "backend_unavailable", messageId: "edit.backend_unavailable", params: {}, legacyText: null, status: 503,
  });
});

test("a code with a detail passes the detail as params.detail", () => {
  const err = normalizeApiError({ error: "Karakter tidak didukung font", code: "glyph_unsupported:U+1F602", messageId: "edit.glyph_unsupported" }, 422);
  assert.deepEqual(err.params, { detail: "U+1F602" });
  assert.equal(apiErrorCode(err), "glyph_unsupported");
});

test("a string body is legacy text only; no body names the HTTP status", () => {
  assert.deepEqual(normalizeApiError("Job tidak ditemukan", 404), { code: null, messageId: null, params: {}, legacyText: "Job tidak ditemukan", status: 404 });
  assert.equal(normalizeApiError(null, 502).messageId, "http.s502");
  assert.equal(normalizeApiError(undefined, 418).messageId, "http.s400", "an unknown 4xx");
  assert.equal(normalizeApiError({}, 504).messageId, "http.s500", "an unknown 5xx");
});

test("a code without a messageId (an old server) gets the domain's messageId", () => {
  assert.equal(normalizeApiError({ error: "x", code: "not_found" }, 404).messageId, "web.not_found");
  assert.equal(normalizeApiError({ error: "x", code: "not_found" }, 404, { domain: "edit" }).messageId, "edit.not_found");
});

test("params keep primitives only, at most 8 keys", () => {
  const params = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, i]));
  const err = normalizeApiError({ error: "x", code: "c", messageId: "web.c", params: { ...params, bad: { a: 1 }, nan: Number.NaN } }, 400);
  assert.equal(Object.keys(err.params).length, 8);
  assert.ok(Object.values(err.params).every((value) => typeof value === "number"));
});

test("readApiError reads JSON, text and an empty body", async () => {
  assert.equal((await readApiError(Response.json({ error: "x", code: "busy" }, { status: 429 }))).code, "busy");
  assert.equal((await readApiError(new Response("Not found", { status: 404 }))).legacyText, "Not found");
  assert.equal((await readApiError(new Response(null, { status: 503 }))).messageId, "http.s503");
});

// --- apiErrorText -------------------------------------------------------------------------

test("Indonesian shows the server's own sentence; English shows the catalog text", () => {
  const err = normalizeApiError({ error: "Item tren tidak ditemukan.", code: "not_found", messageId: "web.not_found" }, 404);
  assert.equal(apiErrorText(translator("id"), err, { locale: "id-ID" }), "Item tren tidak ditemukan.");
  assert.equal(apiErrorText(translator("en"), err, { locale: "en-US" }), "Not found");
});

test("English falls back to the server's sentence, then to the unknown text", () => {
  const t = translator("en");
  assert.equal(apiErrorText(t, normalizeApiError({ error: "Teks khusus", code: "no_such_code" }, 400), { locale: "en" }), "Teks khusus");
  assert.equal(apiErrorText(t, normalizeApiError(null, 418), { locale: "en" }), "Invalid request");
  assert.equal(apiErrorText(t, normalizeApiError({}, 200), { locale: "en" }), "Something went wrong");
});

test("apiErrorMessage in Indonesian is exactly body.error || fallback", () => {
  const t = translator("id");
  const cases = [
    [{ error: "Pengaturan sudah diubah", code: "conflict" }, 409],
    [{ error: "" , code: "busy" }, 429],
    [null, 500],
    [{ code: "auth" }, 502],
    ["teks", 400],
  ];
  for (const [body, status] of cases) {
    const before = (body && typeof body === "object" ? body.error : null) || "Gagal menyimpan pengaturan.";
    const expected = typeof body === "string" ? "teks" : before;
    assert.equal(apiErrorMessage(t, body, status, { locale: "id-ID", fallback: "Gagal menyimpan pengaturan." }), expected, JSON.stringify(body));
  }
});

test("apiErrorMessage in English shows the catalog text of the code, else the same chain", () => {
  const t = translator("en");
  const options = { locale: "en-US", fallback: "Impor gagal.", domain: "llm" };
  assert.equal(apiErrorMessage(t, { error: "API key ditolak penyedia", code: "auth" }, 502, options), "API key rejected");
  assert.equal(apiErrorMessage(t, { error: "Pengaturan AI sudah ada", code: "exists", messageId: "web.exists" }, 409, options), "Settings already exist");
  assert.equal(apiErrorMessage(t, { error: "Teks khusus", code: "no_such_code" }, 400, options), "Teks khusus");
  assert.equal(apiErrorMessage(t, null, 503, options), "Service temporarily unavailable");
  assert.equal(apiErrorMessage(t, {}, 200, options), "Impor gagal.");
});

// --- the server side ----------------------------------------------------------------------

test("a messageId names the first route domain whose catalog has the code, else web", () => {
  assert.equal(resolveMessageId("revision_conflict", ["edit", "web"]), "edit.revision_conflict");
  assert.equal(resolveMessageId("document_invalid", ["edit", "web"]), "web.document_invalid");
  assert.equal(resolveMessageId("timeout", ["editor_ai", "edit", "web"]), "editor_ai.timeout");
  assert.equal(resolveMessageId("auth", ["llm", "web"]), "llm.auth");
  assert.equal(resolveMessageId("glyph_unsupported:U+1F602", ["edit", "web"]), "edit.glyph_unsupported");
  assert.equal(legacyErrorText("unauthorized"), "Sesi login diperlukan");
});

test("codedErrorBody adds a code and a messageId to a body without a code, and leaves a coded body alone", () => {
  assert.deepEqual(codedErrorBody({ error: "Job tidak ditemukan" }, 404), { error: "Job tidak ditemukan", code: "not_found", messageId: "web.not_found" });
  assert.deepEqual(codedErrorBody({ error: null }, 500), { error: null, code: "internal_error", messageId: "web.internal_error" });
  assert.deepEqual(codedErrorBody({ error: { ref: "x" } }, 409, ["edit", "web"]), { error: { ref: "x", code: "conflict", messageId: "web.conflict" } });
  assert.deepEqual(codedErrorBody({ errors: [{ code: "range_invalid" }] }, 422, ["edit", "web"]), {
    errors: [{ code: "range_invalid" }], code: "invalid_request", messageId: "edit.invalid_request",
  });
  assert.equal(codedErrorBody({ error: "x", code: "busy", retry: 5 }, 429), null, "a coded body keeps its bytes");
  assert.equal(codedErrorBody({ error: { code: "superseded" } }, 409, ["edit", "web"]), null);
  assert.equal(codedErrorBody({ error: "x", code: "peak_reduced:-3", messageId: "edit.peak_reduced" }, 422), null);
});

test("withErrorCode keeps the status, the headers and every old field", async () => {
  const original = Response.json({ error: "Origin permintaan tidak diizinkan", jobId: null }, {
    status: 403, headers: { "Cache-Control": "no-store", "Retry-After": "5", "X-Content-Type-Options": "nosniff" },
  });
  const coded = await withErrorCode(original);
  assert.equal(coded.status, 403);
  assert.equal(coded.headers.get("cache-control"), "no-store");
  assert.equal(coded.headers.get("retry-after"), "5");
  assert.equal(coded.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(await coded.json(), { error: "Origin permintaan tidak diizinkan", jobId: null, code: "forbidden", messageId: "web.forbidden" });
});

test("withErrorCode turns a text error into the flat shape and leaves success, HEAD, empty and coded bodies alone", async () => {
  const text = await withErrorCode(new Response("File not found", { status: 404, headers: { "Cache-Control": "private, no-store" } }));
  assert.match(text.headers.get("content-type"), /application\/json/);
  assert.equal(text.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await text.json(), { error: "File not found", code: "not_found", messageId: "web.not_found" });
  const empty = new Response(null, { status: 416, headers: { "Content-Range": "bytes */10", "Content-Length": "0" } });
  assert.equal(await withErrorCode(empty), empty, "an empty body stays empty (the client reads http.s<status>)");
  const coded = Response.json({ error: "x", code: "busy" }, { status: 429 });
  assert.equal(await withErrorCode(coded), coded);

  const ok = Response.json({ fine: true });
  assert.equal(await withErrorCode(ok), ok);
  const head = new Response(null, { status: 404 });
  assert.equal(await withErrorCode(head, { method: "HEAD" }), head);
  const done = Response.json({ error: "x", code: "busy", messageId: "web.busy" }, { status: 429 });
  assert.equal(await withErrorCode(done), done);
});

test("withErrorCodes wraps a handler and puts web last in its domains", async () => {
  const handler = withErrorCodes(async () => Response.json({ error: "Data tidak ditemukan" }, { status: 404 }), { domains: ["edit"] });
  assert.deepEqual(handler.errorDomains, ["edit", "web"]);
  const answer = await handler(new Request("http://local/x"), {});
  assert.deepEqual(await answer.json(), { error: "Data tidak ditemukan", code: "not_found", messageId: "edit.not_found" });
});
