// QG-SEC over every editor route file (plan §9.1, §10.2; T4.2): the route modules under
// app/api/jobs/[id]/clips/** and app/api/jobs/[id]/assets/** as Next runs them, with a stand-in
// Python that records every spawn. Session first, origin on every mutation, ids by regex,
// path-traversal names, rate limits with Retry-After, body caps, the header set on every answer,
// error answers without a server path, and the AI body with nothing but {task, doc}.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { EDITOR_RATE_LIMITS, TokenBucketLimiter, createEditorRateLimits, sessionRateKey } from "../lib/rate-limit.mjs";
import {
  AUTH,
  CLIP,
  DASHBOARD_SECRETS,
  JOB,
  PLATE16,
  LLM_SECRETS,
  ROUTES,
  SHA,
  STORAGE_ENV,
  WEB,
  context,
  fakePython,
  jobsRoot,
  loadRoute,
  newSession,
  read,
  routeFiles,
  routeRequest,
  withEnv,
} from "./security-support.mjs";

// The process-wide limiters run on a clock this file moves (no wall-clock flakiness). They must
// exist before the route modules are imported: some routes keep the instance they find.
const clock = { now: 1_700_000_000_000 };
const now = () => clock.now;
globalThis[Symbol.for("potongin.editorRateLimits")] = createEditorRateLimits({ now });
globalThis[Symbol.for("potongin.editorAiLimiter")] = new TokenBucketLimiter({
  capacity: EDITOR_RATE_LIMITS.ai.capacity, refillPerSecond: EDITOR_RATE_LIMITS.ai.refillPerSecond, now,
});
const limits = globalThis[Symbol.for("potongin.editorRateLimits")];

// One jobs root for the whole file: route modules keep the JOBS_ROOT they were created with.
let sharedJobs = null;
after(() => sharedJobs?.cleanup());

async function setup(t, answers = {}) {
  const fake = await fakePython(t, answers);
  if (!sharedJobs) {
    const hooks = [];
    sharedJobs = await jobsRoot({ after: (hook) => hooks.push(hook) });
    sharedJobs.cleanup = () => Promise.all(hooks.map((hook) => hook()));
  }
  const jobs = sharedJobs;
  const settings = await mkdtemp(path.join(os.tmpdir(), "potongin-sec-settings-"));
  t.after(() => rm(settings, { recursive: true, force: true }));
  const env = {
    ...AUTH, ...DASHBOARD_SECRETS, ...LLM_SECRETS, ...STORAGE_ENV,
    JOBS_ROOT: jobs.root, PYTHON_BIN: fake.bin, POTONGIN_SETTINGS_DIR: settings,
    POTONGIN_EDITOR_V3: "on", POTONGIN_EDITOR_UPLOADS: "on", POTONGIN_EDITOR_LLM: "off",
    POTONGIN_PREVIEW_SERVER: "off", POTONGIN_LLM_PROVIDER: "openrouter", POTONGIN_LLM: undefined,
  };
  return { fake, jobs, env };
}

function assertHeaderSet(answer, label) {
  assert.equal(answer.headers.get("x-content-type-options"), "nosniff", `${label}: nosniff`);
  assert.equal(answer.headers.get("cross-origin-resource-policy"), "same-origin", `${label}: CORP`);
  assert.ok(answer.headers.get("cache-control"), `${label}: Cache-Control`);
  if (answer.status >= 400) assert.equal(answer.headers.get("cache-control"), "no-store", `${label}: no-store on an error`);
}

function assertNoLeak(answer, jobs, label) {
  for (const needle of [jobs.top, jobs.root, jobs.canary, "Traceback", "/proc/self"]) {
    assert.ok(!answer.text.includes(needle), `${label}: the answer carries ${needle === jobs.canary ? "the canary" : needle}`);
  }
}

test("the table lists every route file and every method it exports", async (t) => {
  const { env } = await setup(t);
  const files = await routeFiles();
  assert.deepEqual([...new Set(ROUTES.map((route) => route.file))].sort(), files);
  await withEnv(env, async () => {
    for (const file of files) {
      const module = await import(path.join(WEB, "app", "api", "jobs", "[id]", ...file.split("/")));
      const methods = Object.keys(module).filter((name) => /^[A-Z]+$/.test(name)).sort();
      const listed = ROUTES.filter((route) => route.file === file).map((route) => route.method).sort();
      assert.deepEqual(methods, listed, file);
    }
  });
});

test("every route refuses a missing or forged session with 401 and the header set, before any work", async (t) => {
  const { fake, jobs, env } = await setup(t);
  await withEnv(env, async () => {
    for (const route of ROUTES) {
      const handler = await loadRoute(route);
      for (const session of [false, "e30.forged-signature", `${newSession().slice(0, -2)}xx`]) {
        const { request } = routeRequest(route, { session });
        const answer = await read(await handler(request, context(route.params)));
        assert.equal(answer.status, 401, `${route.name} (${session || "no cookie"})`);
        assertHeaderSet(answer, route.name);
        assertNoLeak(answer, jobs, route.name);
      }
    }
  });
  assert.deepEqual(await fake.records(), []);
});

test("every mutation refuses a missing, foreign or cross-site origin with 403 and the header set, before any work", async (t) => {
  const { fake, jobs, env } = await setup(t);
  const cases = [
    { origin: null, site: "same-origin" },
    { origin: "http://evil.example", site: "cross-site" },
    { origin: "http://evil.example", site: null },
    { origin: "http://local", site: "cross-site" },
    { origin: "http://local", site: "same-site" },
    { origin: "null", site: "same-origin" },
    { origin: "http://local:8080", site: "same-origin" },
  ];
  await withEnv(env, async () => {
    for (const route of ROUTES.filter((item) => item.mutation)) {
      const handler = await loadRoute(route);
      for (const item of cases) {
        const { request } = routeRequest(route, item);
        const answer = await read(await handler(request, context(route.params)));
        assert.equal(answer.status, 403, `${route.name} ${JSON.stringify(item)}`);
        assert.equal(answer.body?.code ?? answer.body?.error?.code, "csrf_rejected", route.name);
        assertHeaderSet(answer, route.name);
        assertNoLeak(answer, jobs, route.name);
      }
    }
  });
  assert.deepEqual(await fake.records(), []);
});

// Path traversal and malformed ids: every dynamic segment, before anything runs.
function badValues(valid) {
  const values = [
    "", ".", "..", "../", `../${valid}`, `${valid}/..`, `${valid}/../..`, "../../secret.txt", "../../../secret.txt",
    "..%2F..%2Fsecret.txt", "%2e%2e%2fsecret.txt", "..\\..\\secret.txt", "....//....//secret.txt", `${valid}\u0000`,
    `${valid}%00`, ` ${valid}`, `${valid}\n`, `${valid.slice(0, -1)}`, `${valid}0`, "x".repeat(4096),
    `/etc/passwd`, `${valid}.json`, `${valid};rm -rf /`, `$(id)`, "０".repeat(valid.length),
  ];
  if (valid.toUpperCase() !== valid) values.push(valid.toUpperCase());
  return values;
}
const NAME_VALUES = ["../seed.json", "../../../../secret.txt", "..%2Fseed.json", `${PLATE16}-c0000000.mp4/..`,
  `${PLATE16.toUpperCase()}-c0000000.mp4`, `${PLATE16}-c0000000.mp4\u0000.txt`, `.${PLATE16}-c0000000.mp4`, "", ".", ".."];
const KIND_VALUES = ["../plates", "plates/..", "..", "", "PLATES", "frames", "constructor", "__proto__", "toString"];

test("every id, sha, kind and name segment refuses path traversal and malformed values, before any work", async (t) => {
  const { fake, jobs, env } = await setup(t);
  await withEnv(env, async () => {
    for (const route of ROUTES) {
      const handler = await loadRoute(route);
      for (const [name, valid] of Object.entries(route.params)) {
        const values = name === "name" ? NAME_VALUES : name === "kind" ? KIND_VALUES : badValues(valid);
        for (const value of values) {
          const params = { ...route.params, [name]: value };
          const { request } = routeRequest(route, { params, url: "http://local/api/jobs/x" });
          const answer = await read(await handler(request, context(params)));
          const label = `${route.name} ${name}=${JSON.stringify(value).slice(0, 40)}`;
          if (["name", "kind"].includes(name)) assert.equal(answer.status, 404, label);
          else assert.equal(answer.status, 400, label);
          assertHeaderSet(answer, label);
          assertNoLeak(answer, jobs, label);
        }
      }
    }
  });
  assert.deepEqual(await fake.records(), [], "nothing was spawned for a bad id");
});

test("every limited route answers 429 with Retry-After when its bucket is empty, before any work", async (t) => {
  const { fake, env } = await setup(t);
  await withEnv(env, async () => {
    for (const route of ROUTES.filter((item) => item.limit)) {
      const handler = await loadRoute(route);
      const session = newSession();
      const limit = EDITOR_RATE_LIMITS[route.limit];
      assert.ok(limit, `${route.name}: the ${route.limit} limit exists`);
      for (let i = 0; i < limit.capacity; i += 1) {
        assert.equal(limits.check(route.limit, { sessionToken: session, jobId: JOB }).allowed, true, route.name);
      }
      const { request } = routeRequest(route, { session });
      const answer = await read(await handler(request, context(route.params)));
      assert.equal(answer.status, 429, route.name);
      assert.equal(answer.body?.code ?? answer.body?.error?.code, "rate_limited", route.name);
      const retry = answer.headers.get("retry-after");
      assert.match(retry ?? "", /^[1-9][0-9]*$/, `${route.name}: Retry-After in whole seconds`);
      assertHeaderSet(answer, route.name);
      clock.now += Number(retry) * 1000;
      const again = await read(await handler(routeRequest(route, { session }).request, context(route.params)));
      assert.notEqual(again.status, 429, `${route.name}: allowed again after Retry-After`);
    }
  });
  const spawned = await fake.records();
  const limitedRoutes = ROUTES.filter((item) => item.limit).length;
  assert.ok(spawned.length <= limitedRoutes, "a refused request spawns nothing (only the retries may)");
});

test("the limits follow plan §9.1, and every other spawning route has a session limit", () => {
  assert.deepEqual(EDITOR_RATE_LIMITS.plan, { capacity: 10, refillPerSecond: 10, scope: "session" });
  assert.deepEqual(EDITOR_RATE_LIMITS.frame, { capacity: 4, refillPerSecond: 4, scope: "session" });
  assert.deepEqual(EDITOR_RATE_LIMITS.ai, { capacity: 30, refillPerSecond: 30 / 3600, scope: "job" });
  assert.deepEqual(EDITOR_RATE_LIMITS.upload, { capacity: 30, refillPerSecond: 30 / 60, scope: "session" });
  assert.equal(EDITOR_RATE_LIMITS.api.scope, "session");
  // generous enough for the editor's own bursts (opening a clip: about ten requests at once)
  assert.ok(EDITOR_RATE_LIMITS.api.capacity >= 40 && EDITOR_RATE_LIMITS.api.refillPerSecond >= 10);
  // and bounded: a flood cannot start more than a few dozen Python processes a second
  assert.ok(EDITOR_RATE_LIMITS.api.refillPerSecond <= 30);
  const unlimited = ROUTES.filter((route) => !route.limit).map((route) => route.name).sort();
  assert.deepEqual(unlimited, ["GET asset", "GET media", "HEAD asset", "HEAD media"], "only file reads are unlimited");
});

test("the LLM quota of a job answers 202 with the instant suggestions and a Retry-After", async (t) => {
  const { fake, env } = await setup(t, {
    "ai_clipper.editor_ai heuristic": { exit: 0, json: { heuristic: [] } },
    "ai_clipper.editor_ai run-task": { exit: 0, json: {} },
  });
  const jobLimiter = globalThis[Symbol.for("potongin.editorAiLimiter")];
  await withEnv({ ...env, POTONGIN_EDITOR_LLM: "on" }, async () => {
    const route = ROUTES.find((item) => item.name === "POST ai");
    const handler = await loadRoute(route);
    while (jobLimiter.take(`job:${JOB}`).allowed) { /* empty the job's hour */ }
    const answer = await read(await handler(routeRequest(route).request, context(route.params)));
    assert.equal(answer.status, 202);
    assert.equal(answer.body.llm.state, "rate_limited");
    assert.equal(answer.headers.get("retry-after"), String(Math.ceil(answer.body.llm.retryAfterMs / 1000)));
    assertHeaderSet(answer, "POST ai");
  });
  assert.deepEqual((await fake.records()).map((record) => record.op), ["heuristic"], "no LLM task was started");
});

test("every route's answer to a well-formed request carries the header set and no server path", async (t) => {
  const { fake, jobs, env } = await setup(t, {
    "ai_clipper.edit_v2.api clips": { exit: 0, json: { clips: [] } },
    "ai_clipper.edit_v2.coldopen list": { exit: 0, json: { wordsSha256: SHA, candidates: [] } },
  });
  await writeFile(path.join(jobs.clip, "preview", "plates", `${PLATE16}-c0000000.mp4`), Buffer.alloc(64, 7));
  const store = path.join(jobs.root, JOB, "analysis", "assets");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(store, { recursive: true, mode: 0o700 }));
  await writeFile(path.join(store, `${SHA}.json`), JSON.stringify({ kind: "image", mime: "image/png", w: 1, h: 1, name: null }));
  await writeFile(path.join(store, `${SHA}.png`), Buffer.alloc(32, 1));
  await withEnv(env, async () => {
    for (const route of ROUTES) {
      const handler = await loadRoute(route);
      const answer = await read(await handler(routeRequest(route).request, context(route.params)));
      assert.ok(answer.status < 500 || answer.status === 503, `${route.name}: ${answer.status}`);
      assertHeaderSet(answer, `${route.name} (${answer.status})`);
      assertNoLeak(answer, jobs, route.name);
      if (["GET clips", "GET media", "HEAD media", "GET asset", "HEAD asset", "GET coldopen"].includes(route.name)) {
        assert.ok(answer.status === 200, `${route.name}: ${answer.status}`);
      }
    }
  });
  assert.ok((await fake.records()).length > 0);
});

test("error answers never carry a server path, a traceback or the backend's text", async (t) => {
  const { fake, jobs, env } = await setup(t);
  const leaky = (code) => ({
    error: { code, path: `${jobs.root}/${JOB}/analysis/clips/${CLIP}/seed.json`, ref: "Traceback (most recent call last)",
      messageId: `edit.${code}`, detail: `${jobs.top}/secret.txt` },
    errors: [{ code: "range_invalid", path: `${jobs.root}/x`, ref: `${jobs.root}/y`, f: 3 }],
    stderr: `File "${jobs.root}/x.py", line 1`,
  });
  for (const [exit, code] of [[1, "internal_error"], [3, "invalid_json"], [4, "not_found"], [5, "revision_conflict"],
    [6, "range_invalid"], [8, "analysis_missing"], [9, "idempotency_conflict"], [10, "render_failed"]]) {
    await fake.answer({ "*": { exit, json: leaky(code) } });
    await withEnv(env, async () => {
      for (const route of ROUTES) {
        const handler = await loadRoute(route);
        const answer = await read(await handler(routeRequest(route).request, context(route.params)));
        assertNoLeak(answer, jobs, `${route.name} exit ${exit}`);
        assertHeaderSet(answer, `${route.name} exit ${exit}`);
      }
    });
  }
});

test("the AI route takes exactly {task: \"hooks\", doc} and nothing else, before any work", async (t) => {
  const { fake, env } = await setup(t);
  const route = ROUTES.find((item) => item.name === "POST ai");
  const doc = { schema: "clip-edit-v2", clip_id: CLIP };
  const extras = ["provider", "model", "models", "baseUrl", "base_url", "url", "endpoint", "apiKey", "api_key", "key",
    "headers", "temperature", "system", "prompt", "messages", "task2", "llm", "options", "constructor", "toString"];
  const bodies = [
    ...extras.map((name) => JSON.stringify({ task: "hooks", doc, [name]: "http://127.0.0.1:9/v1" })),
    '{"task":"hooks","doc":{},"__proto__":{"provider":"x"}}',
    JSON.stringify({ task: "hooks" }), JSON.stringify({ doc }), JSON.stringify({ task: "titles", doc }),
    JSON.stringify({ task: "hooks", doc: [] }), JSON.stringify({ task: "hooks", doc: "x" }), JSON.stringify([{ task: "hooks", doc }]),
    "null", "", "{", JSON.stringify({ task: ["hooks"], doc }),
  ];
  await withEnv({ ...env, POTONGIN_EDITOR_LLM: "on" }, async () => {
    const handler = await loadRoute(route);
    for (const text of bodies) {
      const answer = await read(await handler(routeRequest(route, { body: { text, type: "application/json" } }).request,
        context(route.params)));
      assert.equal(answer.status, 400, text.slice(0, 80));
      assert.equal(answer.body.code, "invalid_request");
      assertHeaderSet(answer, "POST ai");
    }
  });
  assert.deepEqual(await fake.records(), [], "no heuristic and no LLM child for a refused body");
});

test("every mutation refuses a body over its cap, and a body longer than its declared length, before any work", async (t) => {
  const { fake, env } = await setup(t);
  await withEnv(env, async () => {
    for (const route of ROUTES.filter((item) => item.cap)) {
      const handler = await loadRoute(route);
      const valid = route.body();
      const big = Buffer.alloc(route.cap + 1, 0x20);
      if (valid.bytes) valid.bytes.copy(big);
      else big.write(valid.text);
      const over = await read(await handler(routeRequest(route, { body: { ...valid, bytes: big } }).request, context(route.params)));
      assert.equal(over.status, 413, `${route.name}: one byte over the cap`);
      assertHeaderSet(over, route.name);
      const lying = await read(await handler(routeRequest(route, {
        body: { ...valid, bytes: big, length: Math.min(64, route.cap) },
      }).request, context(route.params)));
      assert.ok([400, 413, 415].includes(lying.status), `${route.name}: a body longer than declared (${lying.status})`);
      assertHeaderSet(lying, route.name);
    }
  });
  assert.deepEqual(await fake.records(), []);
});

test("session buckets never hold the token itself", () => {
  const token = newSession();
  assert.notEqual(sessionRateKey(token), token);
  assert.match(sessionRateKey(token), /^[0-9a-f]{64}$/);
});

test("the route files hold no logic of their own beyond the shared guard", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const file of await routeFiles()) {
    const source = await readFile(path.join(WEB, "app", "api", "jobs", "[id]", ...file.split("/")), "utf8");
    assert.match(source, /secureRoute\(/, `${file} goes through secureRoute`);
    assert.doesNotMatch(source, /process\.env/, `${file} reads no environment itself`);
  }
});

test("a fixed clip id and job id keep their shape", () => {
  assert.match(JOB, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(CLIP, /^clip_[0-9a-f]{24}$/);
});
