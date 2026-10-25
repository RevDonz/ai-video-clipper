// POST /api/locale (rombak 07 §9.2): the public route behind the language picker. Checks run in
// the order method -> same origin -> rate limit -> body; a native form always gets a 303 back to
// a same-site page (with ?bahasa=gagal on a refusal), a JSON client gets the status table.
import assert from "node:assert/strict";
import test from "node:test";

import * as localeModule from "../app/api/locale/route.js";
import { TokenBucketLimiter } from "../lib/rate-limit.mjs";

const { createLocaleRoute } = localeModule;
const ENV = Object.freeze({ POTONGIN_LOCALES: "id,en" });
const ORIGIN = "http://local";

function request({ method = "POST", body, contentType = "application/x-www-form-urlencoded", origin = ORIGIN, referer, headers = {}, length } = {}) {
  const all = { Host: "local", ...headers };
  if (origin) all.Origin = origin;
  if (referer) all.Referer = referer;
  if (body !== undefined && contentType) all["Content-Type"] = contentType;
  if (length !== undefined) all["Content-Length"] = String(length);
  const init = { method, headers: all };
  if (body !== undefined && !["GET", "HEAD"].includes(method)) {
    init.body = body;
    if (body instanceof ReadableStream) init.duplex = "half";
  }
  return new Request(`${ORIGIN}/api/locale`, init);
}

const form = (fields) => new URLSearchParams(fields).toString();

function stream(text) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function read(response) {
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return {
    status: response.status,
    body,
    location: response.headers.get("location"),
    cookie: response.headers.get("set-cookie"),
    cacheControl: response.headers.get("cache-control"),
    headers: response.headers,
  };
}

function fixture({ env = ENV, limiter } = {}) {
  return createLocaleRoute({ env, limiter: limiter ?? new TokenBucketLimiter({ capacity: 20, refillPerSecond: 20 / 60 }) });
}

const post = async (route, options) => read(await route.POST(request(options)));

function assertError(response, status, code) {
  assert.equal(response.status, status, code);
  assert.equal(response.body.code, code);
  assert.equal(response.body.messageId, `web.${code}`);
  assert.equal(typeof response.body.error, "string", "the Indonesian error text stays (07 §10.1)");
  assert.ok(response.body.error.length > 0);
  assert.equal(response.cacheControl, "no-store");
  assert.equal(response.cookie, null, "a refusal writes no cookie");
}

test("a form post sets the language cookie and goes back to next with a 303", async () => {
  const route = fixture();
  const response = await post(route, { body: form({ locale: "en", next: "/projects?filter=done" }) });
  assert.equal(response.status, 303);
  assert.equal(response.location, "/projects?filter=done");
  assert.equal(response.cacheControl, "no-store");
  assert.equal(response.cookie, "potongin_locale=en; Path=/; Max-Age=31536000; SameSite=Lax; Secure");
  assert.doesNotMatch(response.cookie, /HttpOnly/i, "global-error.jsx reads it from document.cookie (07 §5.2)");
  // The login page is a valid destination as it is, not turned into /dashboard.
  const back = await post(route, { body: form({ locale: "id", next: "/login?next=%2Fbantuan" }) });
  assert.equal(back.location, "/login?next=%2Fbantuan");
  assert.equal(back.cookie, "potongin_locale=id; Path=/; Max-Age=31536000; SameSite=Lax; Secure");
});

test("without a usable next the form goes back to the same-origin Referer, else to /", async () => {
  const route = fixture();
  const cases = [
    [{ locale: "en" }, `${ORIGIN}/trends?tab=items`, "/trends?tab=items"],
    [{ locale: "en", next: "//evil.example/x" }, `${ORIGIN}/bantuan#kode`, "/bantuan"],
    [{ locale: "en", next: "https://evil.example/" }, `${ORIGIN}/settings`, "/settings"],
    [{ locale: "en", next: "/a\\b" }, undefined, "/"],
    [{ locale: "en" }, "https://evil.example/dashboard", "/"],
    [{ locale: "en" }, "http://local.evil.example/dashboard", "/"],
    [{ locale: "en" }, "not a url", "/"],
    [{ locale: "en" }, undefined, "/"],
  ];
  for (const [fields, referer, expected] of cases) {
    const response = await post(route, { body: form(fields), referer });
    assert.equal(response.status, 303, JSON.stringify(fields));
    assert.equal(response.location, expected, `${JSON.stringify(fields)} ${referer}`);
    assert.match(response.cookie, /^potongin_locale=en;/);
  }
});

test("the Location header never leaves the origin", async () => {
  const route = fixture();
  const hostile = ["//evil.example", "///evil.example", "/\\evil.example", "\\\\evil.example", "https:evil.example",
    "javascript:alert(1)", "/..//evil.example", "/%0d%0aSet-Cookie:x=1", "/ok\r\nx", " /dashboard", "evil.example", ""];
  for (const next of hostile) {
    for (const locale of ["en", "fr"]) {
      const response = await post(route, { body: form({ locale, next }), referer: "https://evil.example/" });
      assert.equal(response.status, 303, next);
      assert.ok(response.location.startsWith("/") && !response.location.startsWith("//"), `${next} -> ${response.location}`);
      assert.ok(!response.location.includes("\\") && !/[\r\n]/.test(response.location), next);
      assert.doesNotMatch(response.location, /evil/, next);
    }
  }
});

test("a JSON client gets 200 { locale } and the same cookie", async () => {
  const route = fixture();
  const response = await post(route, { body: JSON.stringify({ locale: "en" }), contentType: "application/json" });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { locale: "en" });
  assert.equal(response.cacheControl, "no-store");
  assert.equal(response.cookie, "potongin_locale=en; Path=/; Max-Age=31536000; SameSite=Lax; Secure");
  const charset = await post(route, { body: JSON.stringify({ locale: "id" }), contentType: "application/json; charset=utf-8" });
  assert.equal(charset.status, 200);
});

test("a language that is not enabled is locale_unsupported: 400 for JSON, 303 with ?bahasa=gagal for a form", async () => {
  const idOnly = fixture({ env: {} });
  for (const locale of ["en", "fr", "EN", "", "id-ID", "__proto__", "toString"]) {
    const json = await post(idOnly, { body: JSON.stringify({ locale }), contentType: "application/json" });
    assertError(json, 400, "locale_unsupported");
  }
  // Only id on: English is a known code but switched off.
  const formResponse = await post(idOnly, { body: form({ locale: "en", next: "/login?next=%2Fprojects" }) });
  assert.equal(formResponse.status, 303);
  assert.equal(formResponse.location, "/login?next=%2Fprojects&bahasa=gagal");
  assert.equal(formResponse.cookie, null);
  // A failure already in next is not doubled.
  const again = await post(idOnly, { body: form({ locale: "fr", next: "/login?bahasa=gagal" }) });
  assert.equal(again.location, "/login?bahasa=gagal");
  const enabled = fixture();
  assert.equal((await post(enabled, { body: form({ locale: "en" }) })).status, 303);
  assertError(await post(enabled, { body: JSON.stringify({ locale: 7 }), contentType: "application/json" }), 400, "locale_unsupported");
});

test("a broken or unknown body is invalid_request: 400 for JSON and other types, 303 with ?bahasa=gagal for a form", async () => {
  const route = fixture();
  for (const [body, contentType] of [
    ["{ rusak", "application/json"],
    ["[]", "application/json"],
    ["null", "application/json"],
    ['"en"', "application/json"],
    ["locale=en", "text/plain"],
    ["locale=en", null],
    ["locale=en", "multipart/form-data; boundary=x"],
  ]) {
    assertError(await post(route, { body, contentType }), 400, "invalid_request");
  }
  for (const body of ["locale=%E0%A4%A", "locale=%ZZ", ""]) {
    const response = await post(route, { body, referer: `${ORIGIN}/login` });
    assert.equal(response.status, 303, body);
    assert.equal(response.location, "/login?bahasa=gagal", body);
    assert.equal(response.cookie, null);
  }
  // A form without the locale field is refused the same way.
  const missing = await post(route, { body: form({ next: "/dashboard" }) });
  assert.equal(missing.location, "/dashboard?bahasa=gagal");
});

test("a body over 1 KiB is request_too_large when declared, before it is read", async () => {
  const route = fixture();
  const big = JSON.stringify({ locale: "en", pad: "x".repeat(2000) });
  assertError(await post(route, { body: big, contentType: "application/json", length: Buffer.byteLength(big) }), 413, "request_too_large");
  // Undeclared JSON over the cap is read only up to it, then refused with 413.
  assertError(await post(route, { body: stream(big), contentType: "application/json" }), 413, "request_too_large");
  // A form over the cap: declared -> the 413 path, undeclared -> the form reader's refusal; a
  // native form gets its 303 either way.
  const bigForm = form({ locale: "en", next: `/${"a".repeat(2000)}` });
  for (const options of [{ length: Buffer.byteLength(bigForm), body: bigForm }, { body: stream(bigForm) }]) {
    const response = await post(route, { ...options, referer: `${ORIGIN}/login` });
    assert.equal(response.status, 303);
    assert.equal(response.location, "/login?bahasa=gagal");
    assert.equal(response.cookie, null);
  }
  // Exactly 1 KiB is fine.
  const exact = form({ locale: "en", next: `/${"a".repeat(1024 - "locale=en&next=%2F".length)}` });
  assert.equal(Buffer.byteLength(exact), 1024);
  assert.equal((await post(route, { body: exact })).status, 303);
});

test("a cross-site post is csrf_rejected with 403, for a form too, and writes nothing", async () => {
  const route = fixture();
  const body = form({ locale: "en", next: "/dashboard" });
  for (const options of [
    { origin: null },
    { origin: "https://evil.example" },
    { origin: "http://local.evil.example" },
    { headers: { "Sec-Fetch-Site": "cross-site" } },
  ]) {
    assertError(await post(route, { body, ...options }), 403, "csrf_rejected");
  }
});

test("every other method is 405 with Allow: POST", async () => {
  for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    assert.equal(typeof localeModule[method], "function", method);
    const response = await read(await localeModule[method](request({ method, origin: null })));
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("allow"), "POST", method);
    assert.equal(response.cacheControl, "no-store");
    if (method !== "HEAD") assert.equal(response.body.code, "method_not_allowed", method);
  }
  assert.equal(localeModule.runtime, "nodejs");
});

test("20 posts a minute per client, then rate_limited with Retry-After; the check runs before the body", async () => {
  let now = 1_000_000;
  const limiter = new TokenBucketLimiter({ capacity: 20, refillPerSecond: 20 / 60, now: () => now });
  const route = fixture({ limiter });
  const ok = { body: JSON.stringify({ locale: "en" }), contentType: "application/json" };
  // Cross-site posts are refused before they reach the bucket.
  for (let i = 0; i < 30; i += 1) assert.equal((await post(route, { ...ok, origin: "https://evil.example" })).status, 403);
  for (let i = 0; i < 20; i += 1) assert.equal((await post(route, ok)).status, 200, `post ${i + 1}`);
  const limited = await post(route, ok);
  assertError(limited, 429, "rate_limited");
  assert.equal(limited.headers.get("retry-after"), "3");
  // A broken body is still counted: the limit comes first.
  assertError(await post(route, { body: "{", contentType: "application/json" }), 429, "rate_limited");
  // The body is not read once the bucket is empty, so the form goes back to its Referer.
  const formLimited = await post(route, { body: form({ locale: "en", next: "/dashboard" }), referer: `${ORIGIN}/login` });
  assert.equal(formLimited.status, 303);
  assert.equal(formLimited.location, "/login?bahasa=gagal");
  assert.equal(formLimited.headers.get("retry-after"), "3");
  now += 3000;
  assert.equal((await post(route, ok)).status, 200, "a token comes back every 3 s");
});

test("the bucket is per client IP hash behind a trusted proxy header", async () => {
  const limiter = new TokenBucketLimiter({ capacity: 20, refillPerSecond: 20 / 60, now: () => 5 });
  const route = fixture({ env: { ...ENV, AUTH_TRUSTED_CLIENT_IP_HEADER: "nginx" }, limiter });
  const ok = (ip) => ({ body: JSON.stringify({ locale: "en" }), contentType: "application/json", headers: { "X-Real-IP": ip } });
  for (let i = 0; i < 20; i += 1) assert.equal((await post(route, ok("203.0.113.7"))).status, 200);
  assert.equal((await post(route, ok("203.0.113.7"))).status, 429);
  assert.equal((await post(route, ok("203.0.113.8"))).status, 200, "another client has its own bucket");
  // Keys are hashes, never the address itself.
  assert.ok([...limiter.buckets.keys()].every((key) => /^locale:[0-9a-f]{64}$/.test(key)));
});
