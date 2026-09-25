import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as ingestModule from "../app/api/ingest/trends/route.js";
import * as trendsModule from "../app/api/context/trends/route.js";
import * as trendItemModule from "../app/api/context/trends/[id]/route.js";
import * as settingsModule from "../app/api/context/trends/settings/route.js";
import * as tokensModule from "../app/api/context/tokens/route.js";
import * as tokenItemModule from "../app/api/context/tokens/[id]/route.js";
import { createSessionToken, isAuthorized } from "../lib/auth.mjs";
import { proxy } from "../proxy.js";
import { IngestRateLimiter } from "../lib/ingest-rate-limit.mjs";
import { createIngestToken, revokeIngestToken } from "../lib/ingest-tokens.mjs";
import { readTrendContext } from "../lib/trend-context.mjs";

const { createIngestTrendsRoute } = ingestModule;
const { createContextTrendsRoute } = trendsModule;
const { createContextTrendItemRoute } = trendItemModule;
const { createTrendSettingsRoute } = settingsModule;
const { createIngestTokensRoute } = tokensModule;
const { createIngestTokenItemRoute } = tokenItemModule;

const AUTH = Object.freeze({ APP_USERNAME: "admin", APP_PASSWORD: "pw-secret-value", APP_SESSION_SECRET: "session-secret-".padEnd(48, "z") });
const NOW = new Date("2026-09-25T10:00:00.000Z");
const MISSING_ID = "5b0b8d1e-8a57-4c1f-9a53-3b2d2f7e0a11";

function authorize(request) {
  return isAuthorized(request, AUTH) ? null : Response.json({ error: "Sesi login tidak valid" }, { status: 401, headers: { "Cache-Control": "no-store" } });
}

async function sandbox() {
  const root = await mkdtemp(path.join(os.tmpdir(), "trend-routes-"));
  const dir = path.join(root, "settings");
  return { root, dir, env: { ...AUTH, JOBS_ROOT: path.join(root, "jobs"), POTONGIN_SETTINGS_DIR: dir } };
}

function item(extra = {}) {
  return { kind: "topic", title: "Kabur Aja Dulu", keywords: ["kabur aja dulu"], hashtags: ["#KaburAjaDulu"], ...extra };
}

async function read(response) {
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, text, body, cacheControl: response.headers.get("cache-control"), headers: response.headers };
}

// --- Machine route: /api/ingest/trends ------------------------------------------------------

function ingestRequest({ method = "POST", token, body, contentType = "application/json", cookie = false, query = "", headers = {}, length } = {}) {
  const all = { Host: "local", ...headers };
  if (token !== undefined) all.Authorization = `Bearer ${token}`;
  if (cookie) all.Cookie = `potongin_session=${createSessionToken(AUTH)}`;
  if (body !== undefined && contentType) all["Content-Type"] = contentType;
  if (length !== undefined) all["Content-Length"] = String(length);
  const payload = body === undefined ? undefined : typeof body === "string" || body instanceof ReadableStream ? body : JSON.stringify(body);
  return new Request(`http://local/api/ingest/trends${query}`, {
    method, headers: all, body: payload, ...(payload instanceof ReadableStream ? { duplex: "half" } : {}),
  });
}

async function ingestFixture({ limiter = new IngestRateLimiter() } = {}) {
  const box = await sandbox();
  const { token, record } = await createIngestToken("hermes", { env: box.env, now: NOW });
  const route = createIngestTrendsRoute({ env: box.env, limiter, now: () => NOW });
  return { ...box, token, record, route, limiter };
}

function assertNoLeak(text, { token, dir }) {
  if (token) {
    assert.ok(!text.includes(token), "response must not contain the token");
    assert.ok(!text.includes(token.slice(4)), "response must not contain the token body");
    assert.ok(!text.includes(crypto.createHash("sha256").update(token).digest("hex")), "response must not contain the token hash");
  }
  if (dir) assert.ok(!text.includes(dir), "response must not contain a server path");
  assert.ok(!text.includes(AUTH.APP_SESSION_SECRET));
}

test("ingest: every authentication failure is 401 and the session cookie is never accepted", async () => {
  const fixture = await ingestFixture();
  const { route, token, record, env, dir } = fixture;
  const other = `ptk_${crypto.randomBytes(32).toString("base64url")}`;
  for (const method of ["GET", "POST", "DELETE"]) {
    const body = method === "POST" ? { items: [item()] } : undefined;
    const query = method === "DELETE" ? "?externalId=k1" : "";
    const cases = [
      [ingestRequest({ method, body, query }), "missing_token"],
      [ingestRequest({ method, body, query, cookie: true }), "missing_token"],
      [ingestRequest({ method, body, query, token: other }), "invalid_token"],
      [ingestRequest({ method, body, query, token: "ptk_short" }), "invalid_token"],
      [ingestRequest({ method, body, query, headers: { Authorization: `Basic ${Buffer.from(`admin:${AUTH.APP_PASSWORD}`).toString("base64")}` } }), "invalid_token"],
    ];
    for (const [request, code] of cases) {
      const response = await read(await route[method](request));
      assert.equal(response.status, 401, `${method} ${code}`);
      assert.equal(response.body.code, code, `${method} ${code}`);
      assert.equal(typeof response.body.error, "string");
      assert.equal(response.cacheControl, "no-store");
      assert.match(response.headers.get("www-authenticate") || "", /^Bearer/);
      assertNoLeak(response.text, { token: other, dir });
    }
  }
  await revokeIngestToken(record.id, { env, now: NOW });
  const revoked = await read(await route.POST(ingestRequest({ token, body: { items: [item()] } })));
  assert.equal(revoked.status, 401);
  assert.equal(revoked.body.code, "revoked_token");
  assertNoLeak(revoked.text, { token, dir });
  assert.equal((await readTrendContext({ env })).exists, false, "nothing was written");
});

test("ingest: a token without the write scope gets 403 on writes and may still read", async () => {
  const { route, token, dir, env } = await ingestFixture();
  const file = path.join(dir, "ingest-tokens.json");
  const document = JSON.parse(await readFile(file, "utf8"));
  document.tokens[0].scopes = ["trends:read"];
  await writeFile(file, JSON.stringify(document), { mode: 0o600 });
  for (const [method, extra] of [["POST", { body: { items: [item()] } }], ["DELETE", { query: "?externalId=k1" }]]) {
    const response = await read(await route[method](ingestRequest({ method, token, ...extra })));
    assert.equal(response.status, 403, method);
    assert.equal(response.body.code, "insufficient_scope");
    assert.equal(response.cacheControl, "no-store");
  }
  const listed = await read(await route.GET(ingestRequest({ method: "GET", token })));
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body, { items: [] });
  assert.equal((await readTrendContext({ env })).exists, false);
});

test("ingest: the body must be JSON, at most 256 KiB and 100 items, shaped { items: [...] }", async () => {
  const { route, token, dir, env } = await ingestFixture();
  const post = async (options) => read(await route.POST(ingestRequest({ token, ...options })));
  const cases = [
    [{ body: { items: [item()] }, contentType: "text/plain" }, 415, "unsupported_media_type"],
    [{ body: { items: [item()] }, contentType: "application/x-www-form-urlencoded" }, 415, "unsupported_media_type"],
    [{ body: JSON.stringify({ items: [item()] }), contentType: null }, 415, "unsupported_media_type"],
    [{ body: "{ rusak" }, 400, "invalid_json"],
    [{ body: "" }, 400, "invalid_json"],
    [{ body: Buffer.from([0xff, 0xfe, 0x7b, 0x7d]).toString("latin1") }, 400, "invalid_json"],
    [{ body: [item()] }, 400, "invalid_body"],
    [{ body: { items: item() } }, 400, "invalid_body"],
    [{ body: { items: [item()], extra: true } }, 400, "invalid_body"],
    [{ body: {} }, 400, "invalid_body"],
    [{ body: { items: Array.from({ length: 101 }, (_, index) => item({ title: `Tren ${index}` })) } }, 413, "too_many_items"],
    [{ body: { items: [item({ summary: "x".repeat(300 * 1024) })] } }, 413, "body_too_large"],
  ];
  for (const [options, status, code] of cases) {
    const response = await post(options);
    assert.equal(response.status, status, `${code}: ${response.text}`);
    assert.equal(response.body.code, code);
    assert.equal(response.cacheControl, "no-store");
    assertNoLeak(response.text, { token, dir });
  }
  assert.equal((await post({ body: { items: [item()] }, contentType: "application/json; charset=utf-8" })).status, 200);
  assert.equal((await readTrendContext({ env })).document.items.length, 1);
});

test("ingest: an oversized body is refused from its Content-Length or while streaming, never buffered whole", async () => {
  const { route, token } = await ingestFixture();
  let pulled = 0;
  let cancelled = false;
  const endless = () => new ReadableStream({
    pull(controller) { pulled += 16 * 1024; controller.enqueue(new Uint8Array(16 * 1024).fill(0x20)); },
    cancel() { cancelled = true; },
  });

  const declared = await read(await route.POST(ingestRequest({ token, body: endless(), length: 10 * 1024 * 1024 })));
  assert.equal(declared.status, 413);
  assert.equal(declared.body.code, "body_too_large");
  assert.ok(pulled <= 16 * 1024, `pulled ${pulled} bytes before refusing a declared oversized body`);

  pulled = 0;
  const streamed = await read(await route.POST(ingestRequest({ token, body: endless() })));
  assert.equal(streamed.status, 413);
  assert.equal(streamed.body.code, "body_too_large");
  assert.ok(pulled <= 256 * 1024 + 64 * 1024, `pulled ${pulled} bytes`);
  assert.equal(cancelled, true, "the rest of the stream is cancelled, not drained");
});

test("ingest: 60 requests a minute per token, then 429 with Retry-After", async () => {
  const { route, token } = await ingestFixture({ limiter: new IngestRateLimiter({ perMinute: 2, perHour: 100 }) });
  for (let index = 0; index < 2; index += 1) assert.equal((await route.GET(ingestRequest({ method: "GET", token }))).status, 200);
  const limited = await read(await route.POST(ingestRequest({ token, body: { items: [item()] } })));
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, "rate_limited");
  assert.match(limited.headers.get("retry-after"), /^[1-9]\d*$/);
  assert.equal(limited.cacheControl, "no-store");
  // Failed authentication does not use up a token's allowance.
  const other = await read(await route.GET(ingestRequest({ method: "GET", token: `ptk_${"A".repeat(43)}` })));
  assert.equal(other.status, 401);
});

test("ingest: storage problems are 503 storage_unavailable without paths", async () => {
  const { route, token, dir, root } = await ingestFixture();
  const elsewhere = path.join(root, "elsewhere.json");
  await writeFile(elsewhere, "{}");
  await symlink(elsewhere, path.join(dir, "trend-context.json"));
  for (const [method, extra] of [["POST", { body: { items: [item()] } }], ["GET", {}], ["DELETE", { query: "?externalId=k1" }]]) {
    const response = await read(await route[method](ingestRequest({ method, token, ...extra })));
    assert.equal(response.status, 503, method);
    assert.equal(response.body.code, "storage_unavailable");
    assertNoLeak(response.text, { token, dir });
  }
  await rm(path.join(dir, "ingest-tokens.json"));
  await mkdir(path.join(dir, "ingest-tokens.json"));
  const tokens = await read(await route.GET(ingestRequest({ method: "GET", token })));
  assert.equal(tokens.status, 503);
  assert.equal(tokens.body.code, "storage_unavailable");
});

test("ingest: POST reports per-item results, GET lists active items for dedupe, DELETE removes the agent's own item", async () => {
  const { route, token, dir, env } = await ingestFixture();
  const posted = await read(await route.POST(ingestRequest({ token, body: { items: [
    item({ externalId: "tiktok:tag:kabur" }),
    item({ title: "Rusak", examples: [{ url: "javascript:alert(document.cookie)" }] }),
    { ...item({ title: "Server", keywords: ["server server"] }), id: "abc", source: "palsu", createdAt: "x", updatedAt: "y" },
  ] } })));
  assert.equal(posted.status, 200, posted.text);
  assert.deepEqual(posted.body, { accepted: 2, created: 2, updated: 0, rejected: [{ index: 1, code: "invalid_value", field: "examples[0].url" }] });
  assert.equal(posted.cacheControl, "no-store");
  assertNoLeak(posted.text, { token, dir });
  assert.doesNotMatch(posted.text, /javascript|cookie/);
  const stored = (await readTrendContext({ env })).document.items;
  assert.deepEqual(stored.map((entry) => entry.source), ["hermes", "hermes"]);
  assert.notEqual(stored[1].id, "abc");

  const again = await read(await route.POST(ingestRequest({ token, body: { items: [item({ externalId: "tiktok:tag:kabur", score: 90 })] } })));
  assert.deepEqual(again.body, { accepted: 1, created: 0, updated: 1, rejected: [] });

  const listed = await read(await route.GET(ingestRequest({ method: "GET", token })));
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.items.map((entry) => Object.keys(entry)), [
    ["id", "externalId", "kind", "title", "expiresAt", "updatedAt"], ["id", "externalId", "kind", "title", "expiresAt", "updatedAt"],
  ]);
  assert.deepEqual(listed.body.items.map((entry) => entry.externalId), ["tiktok:tag:kabur", null]);

  const removed = await route.DELETE(ingestRequest({ method: "DELETE", token, query: "?externalId=tiktok%3Atag%3Akabur" }));
  assert.equal(removed.status, 204);
  assert.equal(removed.headers.get("cache-control"), "no-store");
  assert.equal(await removed.text(), "");
  const gone = await read(await route.DELETE(ingestRequest({ method: "DELETE", token, query: "?externalId=tiktok%3Atag%3Akabur" })));
  assert.equal(gone.status, 404);
  assert.equal(gone.body.code, "not_found");
  for (const query of ["", "?externalId=", "?externalId=ada%20spasi", `?externalId=${"x".repeat(121)}`, "?externalId=a&externalId=b"]) {
    const bad = await read(await route.DELETE(ingestRequest({ method: "DELETE", token, query })));
    assert.equal(bad.status, 400, query);
    assert.equal(bad.body.code, "invalid_body");
  }
});

test("ingest: the default route export uses the real environment and refuses cookie sessions", async () => {
  const response = await read(await ingestModule.POST(ingestRequest({ body: { items: [item()] }, cookie: true })));
  assert.equal(response.status, 401);
  assert.equal(response.body.code, "missing_token");
  assert.equal(typeof ingestModule.GET, "function");
  assert.equal(typeof ingestModule.DELETE, "function");
  assert.equal(ingestModule.dynamic, "force-dynamic");
  assert.equal(ingestModule.runtime, "nodejs");
});

test("ingest: other methods get 405 with Allow, a stable code and no-store", async () => {
  for (const method of ["PUT", "PATCH"]) {
    const response = await read(await ingestModule[method](ingestRequest({ method, token: "x", body: { items: [] } })));
    assert.equal(response.status, 405, method);
    assert.deepEqual(Object.keys(response.body), ["error", "code"]);
    assert.equal(response.body.code, "method_not_allowed");
    assert.equal(response.headers.get("allow"), "GET, POST, DELETE");
    assert.equal(response.cacheControl, "no-store");
  }
});

test("the session proxy's API 401 carries a stable code like every Konteks Tren error", async () => {
  const response = await read(proxy({ headers: new Headers(), nextUrl: new URL("http://local/api/context/tokens") }));
  assert.equal(response.status, 401);
  assert.deepEqual(Object.keys(response.body), ["error", "code"]);
  assert.equal(response.body.code, "unauthorized");
  assert.equal(response.cacheControl, "no-store");
});

// --- Dashboard routes: /api/context/* -------------------------------------------------------

function uiRequest(url, { method = "GET", body, origin = "http://local", cookie = true, contentType = "application/json" } = {}) {
  const headers = { Host: "local" };
  if (origin) headers.Origin = origin;
  if (cookie) headers.Cookie = `potongin_session=${createSessionToken(AUTH)}`;
  if (body !== undefined && contentType) headers["Content-Type"] = contentType;
  return new Request(`http://local${url}`, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
}

const params = (id) => ({ params: Promise.resolve({ id }) });

function uiRoutes(env) {
  const options = { authorize, env, now: () => NOW };
  return {
    trends: createContextTrendsRoute(options),
    item: createContextTrendItemRoute(options),
    settings: createTrendSettingsRoute(options),
    tokens: createIngestTokensRoute(options),
    token: createIngestTokenItemRoute(options),
  };
}

test("dashboard routes need a session (401) and mutations need the same origin (403)", async () => {
  const defaults = [
    ["GET trends", () => trendsModule.GET(uiRequest("/api/context/trends", { cookie: false }))],
    ["POST trends", () => trendsModule.POST(uiRequest("/api/context/trends", { method: "POST", body: item(), cookie: false }))],
    ["PATCH item", () => trendItemModule.PATCH(uiRequest(`/api/context/trends/${MISSING_ID}`, { method: "PATCH", body: {}, cookie: false }), params(MISSING_ID))],
    ["DELETE item", () => trendItemModule.DELETE(uiRequest(`/api/context/trends/${MISSING_ID}`, { method: "DELETE", cookie: false }), params(MISSING_ID))],
    ["PUT settings", () => settingsModule.PUT(uiRequest("/api/context/trends/settings", { method: "PUT", body: { enabled: false }, cookie: false }))],
    ["GET tokens", () => tokensModule.GET(uiRequest("/api/context/tokens", { cookie: false }))],
    ["POST tokens", () => tokensModule.POST(uiRequest("/api/context/tokens", { method: "POST", body: { label: "x" }, cookie: false }))],
    ["DELETE token", () => tokenItemModule.DELETE(uiRequest(`/api/context/tokens/${MISSING_ID}`, { method: "DELETE", cookie: false }), params(MISSING_ID))],
  ];
  for (const [label, call] of defaults) {
    const response = await read(await call());
    assert.equal(response.status, 401, label);
    assert.equal(response.cacheControl, "no-store", label);
  }

  const { env } = await sandbox();
  const routes = uiRoutes(env);
  for (const origin of ["https://evil.example", null]) {
    for (const [label, call] of [
      ["POST trends", () => routes.trends.POST(uiRequest("/api/context/trends", { method: "POST", body: item(), origin }))],
      ["PATCH item", () => routes.item.PATCH(uiRequest(`/api/context/trends/${MISSING_ID}`, { method: "PATCH", body: { enabled: false }, origin }), params(MISSING_ID))],
      ["DELETE item", () => routes.item.DELETE(uiRequest(`/api/context/trends/${MISSING_ID}`, { method: "DELETE", origin }), params(MISSING_ID))],
      ["PUT settings", () => routes.settings.PUT(uiRequest("/api/context/trends/settings", { method: "PUT", body: { enabled: false }, origin }))],
      ["POST tokens", () => routes.tokens.POST(uiRequest("/api/context/tokens", { method: "POST", body: { label: "Hermes" }, origin }))],
      ["DELETE token", () => routes.token.DELETE(uiRequest(`/api/context/tokens/${MISSING_ID}`, { method: "DELETE", origin }), params(MISSING_ID))],
    ]) {
      const response = await read(await call());
      assert.equal(response.status, 403, `${label} from ${origin}`);
      assert.equal(response.body.code, "csrf_rejected");
      assert.equal(response.cacheControl, "no-store");
    }
  }
  assert.equal((await readTrendContext({ env })).exists, false, "no rejected mutation wrote anything");
});

test("dashboard: list, add, edit, delete and switch trend context", async () => {
  const { env } = await sandbox();
  const routes = uiRoutes(env);
  const empty = await read(await routes.trends.GET(uiRequest("/api/context/trends")));
  assert.equal(empty.status, 200);
  assert.equal(empty.cacheControl, "no-store");
  assert.deepEqual(empty.body, { enabled: true, updatedAt: null, lastIngestAt: null, items: [], counts: { active: 0, expired: 0 } });

  const created = await read(await routes.trends.POST(uiRequest("/api/context/trends", { method: "POST", body: item({ summary: "<img src=x onerror=alert(1)>" }) })));
  assert.equal(created.status, 201, created.text);
  assert.equal(created.body.item.source, "manual");
  assert.equal(created.body.item.summary, "<img src=x onerror=alert(1)>", "stored as text; the page renders it as text");
  const id = created.body.item.id;

  const duplicate = await read(await routes.trends.POST(uiRequest("/api/context/trends", { method: "POST", body: item({ title: "KABUR aja dulu" }) })));
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.code, "duplicate");
  const invalid = await read(await routes.trends.POST(uiRequest("/api/context/trends", { method: "POST", body: item({ kind: "rumor" }) })));
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.code, "invalid_item");
  assert.deepEqual(invalid.body.issues, [{ field: "kind", code: "invalid_value" }]);
  assert.equal((await read(await routes.trends.POST(uiRequest("/api/context/trends", { method: "POST", body: "{", contentType: "application/json" })))).body.code, "invalid_json");
  assert.equal((await read(await routes.trends.POST(uiRequest("/api/context/trends", { method: "POST", body: item(), contentType: "text/plain" })))).status, 415);
  assert.equal((await read(await routes.trends.POST(uiRequest("/api/context/trends", { method: "POST", body: item({ summary: "x".repeat(40 * 1024) }) })))).status, 413);

  const patched = await read(await routes.item.PATCH(uiRequest(`/api/context/trends/${id}`, { method: "PATCH", body: { enabled: false, sensitivity: "sensitive" } }), params(id)));
  assert.equal(patched.status, 200, patched.text);
  assert.equal(patched.body.item.enabled, false);
  assert.equal(patched.body.item.sensitivity, "sensitive");
  const locked = await read(await routes.item.PATCH(uiRequest(`/api/context/trends/${id}`, { method: "PATCH", body: { source: "hermes" } }), params(id)));
  assert.equal(locked.status, 422);
  assert.deepEqual(locked.body.issues, [{ field: "source", code: "unknown_field" }]);
  assert.equal((await read(await routes.item.PATCH(uiRequest(`/api/context/trends/${MISSING_ID}`, { method: "PATCH", body: { enabled: true } }), params(MISSING_ID)))).status, 404);
  assert.equal((await read(await routes.item.PATCH(uiRequest("/api/context/trends/bukan-id", { method: "PATCH", body: { enabled: true } }), params("bukan-id")))).status, 404);

  const switched = await read(await routes.settings.PUT(uiRequest("/api/context/trends/settings", { method: "PUT", body: { enabled: false } })));
  assert.deepEqual(switched.body, { enabled: false, updatedAt: NOW.toISOString() });
  for (const body of [{ enabled: "false" }, { enabled: false, extra: 1 }, {}, [], "x"]) {
    const bad = await read(await routes.settings.PUT(uiRequest("/api/context/trends/settings", { method: "PUT", body })));
    assert.ok(bad.status === 400 || bad.status === 422, JSON.stringify(body));
  }

  const view = await read(await routes.trends.GET(uiRequest("/api/context/trends")));
  assert.equal(view.body.enabled, false);
  assert.deepEqual(view.body.items.map((entry) => [entry.id, entry.enabled, entry.expired]), [[id, false, false]]);

  const deleted = await routes.item.DELETE(uiRequest(`/api/context/trends/${id}`, { method: "DELETE" }), params(id));
  assert.equal(deleted.status, 204);
  assert.equal(deleted.headers.get("cache-control"), "no-store");
  assert.equal((await read(await routes.item.DELETE(uiRequest(`/api/context/trends/${id}`, { method: "DELETE" }), params(id)))).status, 404);
});

test("dashboard: a token is shown once at creation; lists never carry the token or its hash", async () => {
  const { env, dir } = await sandbox();
  const routes = uiRoutes(env);
  const created = await read(await routes.tokens.POST(uiRequest("/api/context/tokens", { method: "POST", body: { label: "Hermes" } })));
  assert.equal(created.status, 201, created.text);
  assert.equal(created.cacheControl, "no-store");
  assert.match(created.body.token, /^ptk_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(Object.keys(created.body).sort(), ["createdAt", "id", "label", "lastUsedAt", "prefix", "revokedAt", "token"]);
  const { token } = created.body;
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  assert.ok(!created.text.includes(hash));

  const listed = await read(await routes.tokens.GET(uiRequest("/api/context/tokens")));
  assert.equal(listed.status, 200);
  assert.equal(listed.cacheControl, "no-store");
  assert.deepEqual(listed.body.tokens.map((entry) => Object.keys(entry)), [["id", "label", "prefix", "createdAt", "lastUsedAt", "revokedAt"]]);
  assertNoLeak(listed.text, { token, dir });
  assert.equal(listed.body.maxActive, 10);

  for (const [body, status, code] of [
    [{ label: "hermes" }, 409, "label_taken"],
    [{ label: "" }, 422, "invalid_label"],
    [{ label: "manual" }, 422, "invalid_label"],
    [{ label: "x".repeat(41) }, 422, "invalid_label"],
    [{ label: "ok", scopes: ["admin"] }, 400, "invalid_body"],
    [["Hermes"], 400, "invalid_body"],
  ]) {
    const response = await read(await routes.tokens.POST(uiRequest("/api/context/tokens", { method: "POST", body })));
    assert.equal(response.status, status, JSON.stringify(body));
    assert.equal(response.body.code, code);
  }

  const revoked = await read(await routes.token.DELETE(uiRequest(`/api/context/tokens/${created.body.id}`, { method: "DELETE" }), params(created.body.id)));
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.token.revokedAt, NOW.toISOString());
  assertNoLeak(revoked.text, { token, dir });
  assert.equal((await read(await routes.token.DELETE(uiRequest(`/api/context/tokens/${MISSING_ID}`, { method: "DELETE" }), params(MISSING_ID)))).status, 404);

  const ingest = createIngestTrendsRoute({ env, limiter: new IngestRateLimiter(), now: () => NOW });
  const refused = await read(await ingest.POST(ingestRequest({ token, body: { items: [item()] } })));
  assert.equal(refused.body.code, "revoked_token");
});

test("dashboard: the trend view shows the last agent ingest and nothing about tokens", async () => {
  const { env, dir } = await sandbox();
  const { token } = await createIngestToken("hermes", { env, now: NOW });
  const ingest = createIngestTrendsRoute({ env, limiter: new IngestRateLimiter(), now: () => NOW });
  assert.equal((await ingest.POST(ingestRequest({ token, body: { items: [item()] } }))).status, 200);
  const view = await read(await uiRoutes(env).trends.GET(uiRequest("/api/context/trends")));
  assert.equal(view.body.lastIngestAt, NOW.toISOString());
  assert.equal(view.body.items[0].source, "hermes");
  assertNoLeak(view.text, { token, dir });
});
