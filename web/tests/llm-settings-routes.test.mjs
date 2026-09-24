import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLlmStatusHandler } from "../app/api/llm/status/route.js";
import { createLlmImportRoute } from "../app/api/settings/llm/import-env/route.js";
import { createLlmModelsRoute } from "../app/api/settings/llm/models/route.js";
import { GET as defaultGet, PUT as defaultPut, createLlmSettingsRoute } from "../app/api/settings/llm/route.js";
import { POST as defaultImport } from "../app/api/settings/llm/import-env/route.js";
import { POST as defaultModels } from "../app/api/settings/llm/models/route.js";
import { POST as defaultTest, createLlmTestRoute } from "../app/api/settings/llm/test/route.js";
import { createSessionToken, isAuthorized } from "../lib/auth.mjs";
import { saveLlmSettings } from "../lib/llm-settings.mjs";
import { AuthRateLimiter } from "../lib/request-security.mjs";

const AUTH = Object.freeze({ APP_USERNAME: "admin", APP_PASSWORD: "pw-secret-value", APP_SESSION_SECRET: "session-secret-".padEnd(48, "z") });
const KEYS = Object.freeze({ custom: "hermes-route-key-1234abcd", openrouter: "sk-or-route-key-5678efgh", cloud: "ollama-route-key-9012ijkl" });

function authorize(request) {
  return isAuthorized(request, AUTH) ? null : Response.json({ error: "Sesi login tidak valid" }, { status: 401, headers: { "Cache-Control": "no-store" } });
}

async function sandbox(extra = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "llm-routes-"));
  return { root, env: { ...AUTH, JOBS_ROOT: path.join(root, "jobs"), PATH: process.env.PATH, ...extra } };
}

function request(url, { method = "GET", body, origin = "http://local", cookie = true, contentType = "application/json" } = {}) {
  const headers = { Host: "local" };
  if (origin) headers.Origin = origin;
  if (cookie) headers.Cookie = `potongin_session=${createSessionToken(AUTH)}`;
  if (body !== undefined && contentType) headers["Content-Type"] = contentType;
  return new Request(`http://local${url}`, {
    method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function read(response) {
  const text = await response.text();
  return { status: response.status, text, body: text ? JSON.parse(text) : null, cacheControl: response.headers.get("cache-control"), response };
}

function assertNoSecrets(text) {
  for (const key of Object.values(KEYS)) assert.ok(!text.includes(key), "response must not contain an API key");
  assert.ok(!text.includes(AUTH.APP_SESSION_SECRET), "response must not contain the session secret");
}

function hermes(baseUrl = "https://hermes.example/v1", extra = {}) {
  return {
    enabled: true, freeOnly: true,
    providers: [
      { provider: "custom", enabled: true, baseUrl, model: "LJNAI-FAST", reasoningEffort: "none", timeout: 600, apiKey: { action: "replace", value: KEYS.custom } },
      { provider: "openrouter", enabled: true, apiKey: { action: "replace", value: KEYS.openrouter } },
    ],
    ...extra,
  };
}

// --- Auth and origin --------------------------------------------------------------------

test("every settings route needs a session; mutations also need the same origin", async () => {
  for (const [label, handler, method] of [
    ["GET settings", defaultGet, "GET"], ["PUT settings", defaultPut, "PUT"], ["import", defaultImport, "POST"],
    ["test", defaultTest, "POST"], ["models", defaultModels, "POST"],
  ]) {
    const response = await read(await handler(request("/api/settings/llm", { method, cookie: false, body: method === "GET" ? undefined : {} })));
    assert.equal(response.status, 401, label);
    assert.equal(response.cacheControl, "no-store", label);
  }
  const { env } = await sandbox();
  const settings = createLlmSettingsRoute({ authorize, env });
  const importer = createLlmImportRoute({ authorize, env });
  const tester = createLlmTestRoute({ authorize, env });
  const models = createLlmModelsRoute({ authorize, env });
  for (const origin of ["https://evil.example", null]) {
    for (const [label, call] of [
      ["PUT", () => settings.PUT(request("/api/settings/llm", { method: "PUT", body: hermes(), origin }))],
      ["import", () => importer.POST(request("/api/settings/llm/import-env", { method: "POST", body: {}, origin }))],
      ["test", () => tester.POST(request("/api/settings/llm/test", { method: "POST", body: { provider: "custom" }, origin }))],
      ["models", () => models.POST(request("/api/settings/llm/models", { method: "POST", body: { provider: "custom" }, origin }))],
    ]) {
      const response = await read(await call());
      assert.equal(response.status, 403, `${label} from ${origin}`);
      assert.equal(response.cacheControl, "no-store");
    }
  }
});

// --- GET / PUT ----------------------------------------------------------------------------

test("PUT validates and saves; no response ever contains a key", async () => {
  const { env } = await sandbox({ POTONGIN_LLM_PROVIDERS: "ollama-cloud", OLLAMA_API_KEY: KEYS.cloud });
  const route = createLlmSettingsRoute({ authorize, env });

  const initial = await read(await route.GET(request("/api/settings/llm")));
  assert.equal(initial.status, 200);
  assert.equal(initial.cacheControl, "no-store");
  assert.equal(initial.body.settings.source, "env");
  assert.equal(initial.body.envImportAvailable, true);
  assert.deepEqual(initial.body.settings.providers.map((item) => [item.provider, item.apiKeySet]), [["ollama-cloud", true]]);
  assertNoSecrets(initial.text);

  const bad = hermes("http://remote-host-secret.example/v1");
  const rejected = await read(await route.PUT(request("/api/settings/llm", { method: "PUT", body: bad })));
  assert.equal(rejected.status, 422);
  assert.ok(rejected.body.issues.some((issue) => issue.field === "providers[0].baseUrl"));
  assert.doesNotMatch(rejected.text, /remote-host-secret/);
  assertNoSecrets(rejected.text);

  assert.equal((await read(await route.PUT(request("/api/settings/llm", { method: "PUT", body: "{", contentType: "application/json" })))).status, 400);
  assert.equal((await read(await route.PUT(request("/api/settings/llm", { method: "PUT", body: hermes(), contentType: "text/plain" })))).status, 415);
  assert.equal((await read(await route.PUT(request("/api/settings/llm", { method: "PUT", body: JSON.stringify({ pad: "x".repeat(200_000) }) })))).status, 413);

  const saved = await read(await route.PUT(request("/api/settings/llm", { method: "PUT", body: hermes("https://hermes.example/v1", { baseUpdatedAt: null }) })));
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.body.settings.source, "ui");
  assert.deepEqual(saved.body.settings.providers.map((item) => [item.provider, item.apiKeySet, item.apiKeyUnreadable]), [["custom", true, false], ["openrouter", true, false]]);
  assert.equal(saved.body.status.source, "ui");
  assert.deepEqual(saved.body.status.order, ["custom", "openrouter"]);
  assertNoSecrets(saved.text);

  const after = await read(await route.GET(request("/api/settings/llm")));
  assert.equal(after.body.settings.updatedAt, saved.body.settings.updatedAt);
  assert.equal(after.body.envImportAvailable, false);
  assertNoSecrets(after.text);

  const stale = await read(await route.PUT(request("/api/settings/llm", { method: "PUT", body: hermes("https://hermes.example/v1", { baseUpdatedAt: null }) })));
  assert.equal(stale.status, 409);

  const noSecret = await sandbox({ APP_SESSION_SECRET: "" });
  const unsealed = await read(await createLlmSettingsRoute({ authorize, env: noSecret.env }).PUT(request("/api/settings/llm", { method: "PUT", body: hermes() })));
  assert.equal(unsealed.status, 503);
  assert.match(unsealed.body.error, /APP_SESSION_SECRET/);
});

test("import-env copies the server configuration once and refuses to overwrite", async () => {
  const { env } = await sandbox({ POTONGIN_LLM_PROVIDERS: "ollama-cloud,openrouter", OLLAMA_API_KEY: KEYS.cloud, OPENROUTER_API_KEY: KEYS.openrouter, POTONGIN_LLM_FREE_ONLY: "1" });
  const route = createLlmImportRoute({ authorize, env });
  const first = await read(await route.POST(request("/api/settings/llm/import-env", { method: "POST" })));
  assert.equal(first.status, 200, first.text);
  assert.equal(first.body.settings.source, "ui");
  assert.equal(first.body.settings.freeOnly, true);
  assert.deepEqual(first.body.settings.providers.map((item) => [item.provider, item.apiKeySet]), [["ollama-cloud", true], ["openrouter", true]]);
  assertNoSecrets(first.text);
  const again = await read(await route.POST(request("/api/settings/llm/import-env", { method: "POST", body: {} })));
  assert.equal(again.status, 409);
  const forced = await read(await route.POST(request("/api/settings/llm/import-env", { method: "POST", body: { force: true } })));
  assert.equal(forced.status, 200);
  assert.equal((await read(await route.POST(request("/api/settings/llm/import-env", { method: "POST", body: { force: "yes" } })))).status, 400);

  const empty = await sandbox();
  const nothing = await read(await createLlmImportRoute({ authorize, env: empty.env }).POST(request("/api/settings/llm/import-env", { method: "POST" })));
  assert.equal(nothing.status, 422);
});

// --- Connection test ----------------------------------------------------------------------

const FAKE_PYTHON = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /POTONGIN|API_KEY|^APP_/.test(name)));
writeFileSync(process.env.FAKE_PY_LOG, JSON.stringify({ argv: process.argv.slice(2), env }));
const mode = process.env.FAKE_PY_MODE;
const key = process.env.POTONGIN_LLM_CUSTOM_API_KEY;
if (mode === "sleep") setTimeout(() => {}, 60_000);
else if (mode === "ok") console.log(JSON.stringify({ ok: true, model: "LJNAI-FAST", latency_s: 0.4123, providers: [{ provider: "custom", status: "ok", model: "LJNAI-FAST", latency_s: 0.4123, usage: null, error: null }] }));
else if (mode === "leak") {
  console.log(JSON.stringify({ ok: false, error: { code: "auth", message: "key " + key }, providers: [{ provider: "custom", status: "failed", model: "evil model " + key, latency_s: null, error: { code: "auth", message: "Bearer " + key } }] }));
  process.exit(1);
} else if (mode === "config") {
  console.log(JSON.stringify({ ok: false, error: { code: "missing_api_key", message: "x" }, providers: [] }));
  process.exit(1);
} else { console.log("not json " + key); process.exit(1); }
`;

async function fakePython(mode) {
  const bin = await mkdtemp(path.join(os.tmpdir(), "llm-fake-python-"));
  const python = path.join(bin, "python");
  await writeFile(python, FAKE_PYTHON);
  await chmod(python, 0o755);
  return { python, log: path.join(bin, "log.json"), mode };
}

test("the connection test runs the engine check for one provider with only its key", async () => {
  const fake = await fakePython();
  const { env } = await sandbox({ FAKE_PY_LOG: fake.log, POTONGIN_SETTINGS_SECRET: "", OPENROUTER_API_KEY: "inherited-openrouter" });
  await saveLlmSettings(hermes(), { env });
  const limiter = new AuthRateLimiter({ attempts: 100, windowMs: 60_000 });
  const call = async (mode, body = { provider: "custom" }, options = {}) => {
    const route = createLlmTestRoute({ authorize, env: { ...env, FAKE_PY_MODE: mode }, pythonBin: fake.python, limiter, ...options });
    return read(await route.POST(request("/api/settings/llm/test", { method: "POST", body })));
  };

  const ok = await call("ok");
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.body.result, { provider: "custom", status: "ok", model: "LJNAI-FAST", latencyS: 0.412, code: null, message: "Terhubung: model menjawab JSON dengan benar." });
  const seen = JSON.parse(await readFile(fake.log, "utf8"));
  assert.deepEqual(seen.argv, ["-m", "ai_clipper.llm", "--check", "--json"]);
  assert.equal(seen.env.POTONGIN_LLM_PROVIDERS, "custom");
  assert.equal(seen.env.POTONGIN_LLM_CUSTOM_API_KEY, KEYS.custom);
  assert.equal(seen.env.POTONGIN_LLM_CUSTOM_MAX_RETRIES, "0");
  assert.ok(Number(seen.env.POTONGIN_LLM_CUSTOM_TIMEOUT) <= 45);
  assert.equal(seen.env.POTONGIN_LLM_OPENROUTER_API_KEY, undefined, "other providers' keys stay out");
  assert.equal(seen.env.OPENROUTER_API_KEY, undefined, "inherited keys are stripped");
  assert.equal(seen.env.APP_SESSION_SECRET, undefined, "the sealing secret never reaches the engine");
  assert.equal(seen.env.APP_PASSWORD, undefined);

  const leak = await call("leak");
  assert.equal(leak.status, 200);
  assert.equal(leak.body.result.status, "failed");
  assert.equal(leak.body.result.code, "auth");
  assert.equal(leak.body.result.model, null);
  assert.match(leak.body.result.message, /API key ditolak/);
  assertNoSecrets(leak.text);

  const config = await call("config");
  assert.equal(config.body.result.code, "missing_api_key");

  const garbage = await call("garbage");
  assert.equal(garbage.status, 502);
  assertNoSecrets(garbage.text);

  const slow = await call("sleep", { provider: "custom" }, { timeoutMs: 400 });
  assert.equal(slow.status, 200);
  assert.equal(slow.body.result.code, "timeout");

  assert.equal((await call("ok", { provider: "nope" })).status, 422);
  assert.equal((await call("ok", { provider: "groq" })).status, 422, "only providers in the saved list can be tested");
  assert.equal((await call("ok", { provider: "custom", extra: 1 })).status, 400);
  assert.equal((await call("ok", { provider: "custom" }, { pythonBin: path.join(os.tmpdir(), "no-such-python-here") })).status, 503);

  const limited = new AuthRateLimiter({ attempts: 1, windowMs: 60_000 });
  assert.equal((await call("ok", { provider: "custom" }, { limiter: limited })).status, 200);
  const blocked = await call("ok", { provider: "custom" }, { limiter: limited });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.response.headers.get("retry-after")) >= 1);
});

test("a key the current secret cannot open is reported without running the engine", async () => {
  const fake = await fakePython();
  const { env } = await sandbox({ FAKE_PY_LOG: fake.log });
  await saveLlmSettings(hermes(), { env });
  const route = createLlmTestRoute({ authorize, env: { ...env, POTONGIN_SETTINGS_SECRET: "rotated-".padEnd(40, "r"), FAKE_PY_MODE: "ok" }, pythonBin: fake.python });
  const result = await read(await route.POST(request("/api/settings/llm/test", { method: "POST", body: { provider: "custom" } })));
  assert.equal(result.status, 200);
  assert.equal(result.body.result.code, "key_unreadable");
  assert.match(result.body.result.message, /isi ulang/);
  await assert.rejects(readFile(fake.log), { code: "ENOENT" });
});

// --- Model list ---------------------------------------------------------------------------

async function modelServer() {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization || null });
    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "zeta" }, { id: "alpha" }, { id: "bad model" }, { id: "alpha" }, { id: 7 }] }));
    } else if (req.url === "/moved/models") {
      res.writeHead(302, { Location: "/v1/models" });
      res.end();
    } else if (req.url === "/denied/models") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `bad key ${req.headers.authorization}` }));
    } else if (req.url === "/big/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: Array.from({ length: 50_000 }, (_, index) => ({ id: `model-${index}-${"x".repeat(40)}` })) }));
    } else if (req.url === "/slow/models") {
      // never answers
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, seen, base: `http://127.0.0.1:${server.address().port}` };
}

test("the model list is fetched server-side with the stored key, without following redirects", async (t) => {
  const upstream = await modelServer();
  t.after(() => upstream.server.close());
  const { env } = await sandbox();
  const limiter = new AuthRateLimiter({ attempts: 100, windowMs: 60_000 });
  const call = async (prefix, options = {}) => {
    await saveLlmSettings(hermes(`${upstream.base}${prefix}`), { env });
    const route = createLlmModelsRoute({ authorize, env, limiter, timeoutMs: 1_000, ...options });
    return read(await route.POST(request("/api/settings/llm/models", { method: "POST", body: { provider: "custom" } })));
  };

  const ok = await call("/v1");
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.body, { provider: "custom", models: ["alpha", "zeta"], total: 2, truncated: false });
  assert.deepEqual(upstream.seen.at(-1), { url: "/v1/models", authorization: `Bearer ${KEYS.custom}` });

  const before = upstream.seen.length;
  const moved = await call("/moved");
  assert.equal(moved.status, 502);
  assert.equal(moved.body.code, "redirect");
  assert.equal(upstream.seen.length, before + 1, "the redirect is not followed");

  const denied = await call("/denied");
  assert.equal(denied.status, 502);
  assert.equal(denied.body.code, "auth");
  assertNoSecrets(denied.text);

  const big = await call("/big", { maxBytes: 64 * 1024 });
  assert.equal(big.body.code, "too_large");
  const slow = await call("/slow", { timeoutMs: 300 });
  assert.equal(slow.body.code, "timeout");
  const missing = await call("/nowhere");
  assert.equal(missing.body.code, "not_found");

  for (const response of [ok, moved, denied, big, slow, missing]) assertNoSecrets(response.text);
  const unknown = await read(await createLlmModelsRoute({ authorize, env, limiter }).POST(request("/api/settings/llm/models", { method: "POST", body: { provider: "groq" } })));
  assert.equal(unknown.status, 422);
});

// --- Status -------------------------------------------------------------------------------

test("the LLM status route reports the configuration jobs will use", async () => {
  const { env } = await sandbox({ POTONGIN_LLM_PROVIDERS: "groq", GROQ_API_KEY: "inherited" });
  const route = createLlmStatusHandler({ authorize, env });
  const before = await read(await route(request("/api/llm/status")));
  assert.equal(before.body.llm.source, "env");
  assert.deepEqual(before.body.llm.order, ["groq"]);
  await saveLlmSettings(hermes(), { env });
  const after = await read(await route(request("/api/llm/status")));
  assert.equal(after.body.llm.source, "ui");
  assert.deepEqual(after.body.llm.order, ["custom", "openrouter"]);
  assertNoSecrets(after.text);
});

test("the model-list DNS guard refuses link-local and metadata answers", async () => {
  const { createGuardedLookup } = await import("../lib/llm-settings-actions.mjs");
  const lookup = (answers) => createGuardedLookup((hostname, options, callback) => callback(null, answers));
  const call = (fn, options) => new Promise((resolve) => fn("provider.example", options, (error, address, family) => resolve({ error, address, family })));
  const blocked = await call(lookup([{ address: "93.184.216.34", family: 4 }, { address: "169.254.169.254", family: 4 }]), {});
  assert.equal(blocked.error.code, "EBLOCKED");
  assert.equal((await call(lookup([{ address: "fd00:ec2::254", family: 6 }]), { all: true })).error.code, "EBLOCKED");
  assert.equal((await call(lookup([]), {})).error.code, "EBLOCKED");
  assert.deepEqual(await call(lookup([{ address: "93.184.216.34", family: 4 }]), {}), { error: null, address: "93.184.216.34", family: 4 });
  const all = await call(lookup([{ address: "2606:2800::1", family: 6 }]), { all: true });
  assert.deepEqual(all.address, [{ address: "2606:2800::1", family: 6 }]);
});
