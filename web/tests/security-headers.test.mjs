// The shared route guard and header set (web/lib/security-headers.mjs; plan §9.1; T4.2).
import assert from "node:assert/strict";
import test from "node:test";

import nextConfig, { EDITOR_PAGE_HEADERS as NEXT_EDITOR_HEADERS } from "../next.config.mjs";
import { createEditorRateLimits } from "../lib/rate-limit.mjs";
import {
  API_HEADERS,
  EDITOR_PAGE_HEADERS,
  ROUTE_PARAMS,
  redactServerPaths,
  secureRoute,
  withSecurityHeaders,
} from "../lib/security-headers.mjs";
import { AUTH, CLIP, JOB, newSession, withEnv } from "./security-support.mjs";

const allow = () => null;
const deny = () => Response.json({ error: "Sesi login tidak valid atau sudah berakhir" }, { status: 401 });
const context = (params) => ({ params: Promise.resolve(params) });
const defined = (headers) => Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined));
const get = (headers = {}) => new Request("http://local/api/x", { headers: defined({ Host: "local", ...headers }) });
const post = (headers = {}) => new Request("http://local/api/x", {
  method: "POST", headers: defined({ Host: "local", Origin: "http://local", "Sec-Fetch-Site": "same-origin", ...headers }), body: "{}",
});

test("the API header set: nosniff, same-origin resources, no-store unless the handler chose a cache policy", async () => {
  assert.deepEqual(API_HEADERS, { "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin" });
  const plain = withSecurityHeaders(new Response("x"));
  assert.equal(plain.headers.get("x-content-type-options"), "nosniff");
  assert.equal(plain.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(plain.headers.get("cache-control"), "no-store");
  const cached = withSecurityHeaders(new Response("x", { headers: { "Cache-Control": "private, max-age=31536000, immutable" } }));
  assert.equal(cached.headers.get("cache-control"), "private, max-age=31536000, immutable");
  // a Response whose headers cannot change is copied
  const redirect = withSecurityHeaders(Response.redirect("http://local/login", 307));
  assert.equal(redirect.status, 307);
  assert.equal(redirect.headers.get("location"), "http://local/login");
  assert.equal(redirect.headers.get("x-content-type-options"), "nosniff");
});

test("the editor page headers are the ones next.config.mjs sends on the editor route", async () => {
  assert.deepEqual(EDITOR_PAGE_HEADERS, NEXT_EDITOR_HEADERS);
  const byKey = Object.fromEntries(EDITOR_PAGE_HEADERS.map(({ key, value }) => [key, value]));
  assert.equal(byKey["Cross-Origin-Opener-Policy"], "same-origin");
  assert.equal(byKey["Cross-Origin-Embedder-Policy"], "require-corp");
  assert.equal(byKey["X-Content-Type-Options"], "nosniff");
  assert.match(byKey["Content-Security-Policy"], /frame-ancestors 'none'/);
  assert.equal(byKey["X-Frame-Options"], "DENY");
  const rules = await nextConfig.headers();
  const editor = rules.find((rule) => rule.source === "/projects/:id/clips/:clipId/edit");
  assert.deepEqual(editor?.headers, [...NEXT_EDITOR_HEADERS]);
});

test("secureRoute: the session first, then the origin of a mutation, then ids, then the rate limit", async () => {
  let calls = 0;
  const handler = async () => { calls += 1; return Response.json({ ok: true }); };
  const limits = createEditorRateLimits({ now: () => 0 });
  const route = (authorize) => secureRoute(handler, { params: ["id", "clipId"], limit: "api", authorize, limits: () => limits });
  const params = { id: JOB, clipId: CLIP };
  assert.equal((await route(deny)(get(), context(params))).status, 401);
  assert.equal((await route(deny)(post({ Origin: "http://evil.example" }), context({ id: "../x" }))).status, 401);
  assert.equal((await route(allow)(post({ Origin: "http://evil.example" }), context(params))).status, 403);
  assert.equal((await route(allow)(post({ Origin: undefined }), context(params))).status, 403);
  const bad = await route(allow)(get(), context({ id: JOB.toUpperCase(), clipId: CLIP }));
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: "Permintaan tidak valid", code: "invalid_request", messageId: "edit.invalid_request" });
  assert.equal(calls, 0);
  const ok = await route(allow)(get({ Cookie: `potongin_session=${newSession()}` }), context(params));
  assert.equal(ok.status, 200);
  assert.equal(calls, 1);
});

test("secureRoute: a handler that throws answers 503 with a fixed code and the header set", async () => {
  const route = secureRoute(async () => { throw new Error("/data/jobs/x exploded"); }, { authorize: allow });
  const answer = await route(get(), context({}));
  assert.equal(answer.status, 503);
  assert.equal(answer.headers.get("x-content-type-options"), "nosniff");
  const text = await answer.text();
  assert.doesNotMatch(text, /exploded|\/data\/jobs/);
  assert.equal(JSON.parse(text).code, "backend_unavailable");
});

test("secureRoute: a refused rate limit is a 429 with Retry-After in whole seconds", async () => {
  const clock = { now: 0 };
  const limits = createEditorRateLimits({ now: () => clock.now });
  const session = newSession();
  const route = secureRoute(async () => new Response(null, { status: 204 }), { limit: "frame", authorize: allow, limits: () => limits });
  const request = () => get({ Cookie: `potongin_session=${session}` });
  for (let i = 0; i < 4; i += 1) assert.equal((await route(request(), context({}))).status, 204);
  const refused = await route(request(), context({}));
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get("retry-after"), "1");
  assert.equal((await refused.json()).code, "rate_limited");
  clock.now += 250;
  assert.equal((await route(request(), context({}))).status, 204);
});

test("error bodies lose any string that names a server path or carries a traceback", async () => {
  const roots = ["/data/jobs", "/srv/real/jobs"];
  const { value, redacted } = redactServerPaths({
    error: { code: "range_invalid", path: "/data/jobs/x/seed.json", ref: "w000123", messageId: "edit.range_invalid" },
    errors: [{ code: "range_invalid", path: "/tracks/0/items/1", ref: "Traceback (most recent call last)" }],
    detail: "open /srv/real/jobs/a failed",
  }, roots);
  assert.equal(redacted, 3);
  assert.deepEqual(value, {
    error: { code: "range_invalid", path: null, ref: "w000123", messageId: "edit.range_invalid" },
    errors: [{ code: "range_invalid", path: "/tracks/0/items/1", ref: null }],
    detail: null,
  });
  // JSON pointers into the document stay, even when a key looks like a directory name
  assert.equal(redactServerPaths({ path: "/data" }, roots).redacted, 0);
  await withEnv({ ...AUTH, JOBS_ROOT: "/data/jobs" }, async () => {
    const route = secureRoute(async () => Response.json({ error: { code: "x", path: "/data/jobs/j/k" } }, { status: 422 }), { authorize: allow });
    const answer = await route(get(), context({}));
    assert.equal(answer.status, 422);
    assert.deepEqual(await answer.json(), { error: { code: "x", path: null } });
  });
});

test("the route parameters each have one exact shape", () => {
  assert.deepEqual(Object.keys(ROUTE_PARAMS).sort(), ["clipId", "id", "idempotencyKey", "renderId", "sha", "taskId"]);
  assert.ok(ROUTE_PARAMS.id.test(JOB) && !ROUTE_PARAMS.id.test(JOB.toUpperCase()) && !ROUTE_PARAMS.id.test(`${JOB}\n`));
  assert.ok(ROUTE_PARAMS.clipId.test(CLIP) && !ROUTE_PARAMS.clipId.test(`${CLIP}/..`));
  assert.ok(ROUTE_PARAMS.sha.test("a".repeat(64)) && !ROUTE_PARAMS.sha.test("a".repeat(63)));
});
