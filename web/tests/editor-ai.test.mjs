// Hook suggestions (plan §7, §7.1, §4.2, §9.1, K13; T3.4): POST /api/jobs/:id/clips/:clipId/ai,
// GET …/ai/:taskId, the LLM decision (flags, saved Pengaturan settings, rate limit), the Node-side
// kill, the child environments, and the Teks panel's suggestions model.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as aiRouteModule from "../app/api/jobs/[id]/clips/[clipId]/ai/route.js";
import * as taskRouteModule from "../app/api/jobs/[id]/clips/[clipId]/ai/[taskId]/route.js";
import {
  COPY,
  SOURCE_LABELS,
  aiView,
  applyCommand,
  contentKey,
  createSuggestions,
  rateLimitedText,
  sameText,
  suggestionsFor,
} from "../components/editor/suggestions/model.mjs";
import { createSessionToken, isAuthorized } from "../lib/auth.mjs";
import {
  AI_MODULE,
  KILL_AFTER_MS,
  MAX_AI_BODY_BYTES,
  SETTINGS_PROBLEM_MESSAGE,
  createAiRoute,
  createAiTaskRoute,
  createTaskRegistry,
  parseAiBody,
} from "../lib/editor-ai.mjs";
import { saveLlmSettings } from "../lib/llm-settings.mjs";
import { PythonCliError, runPythonCli } from "../lib/python-cli.mjs";
import { TokenBucketLimiter } from "../lib/rate-limit.mjs";

const AUTH = Object.freeze({ APP_USERNAME: "admin", APP_PASSWORD: "pw-secret-value", APP_SESSION_SECRET: "session-secret-".padEnd(48, "z") });
const JOB_ID = "8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55";
const CLIP_ID = "clip_62654c2c2fa04f125391464a";
const TASK_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const DOC = Object.freeze({ schema: "clip-edit-v2", clip_id: CLIP_ID, tracks: [] });
const HEURISTIC = [
  { id: "hk_1", text: "Dia ditahan security di film-nya sendiri", source: "ai_selection", kind: "v3_hook", fits: true, style: null, evidence: [], basis: null },
  { id: "hk_2", text: "Jujur gue nggak nyangka dia sutradaranya", source: "heuristic", kind: "hook_unit", fits: false, style: null, evidence: [], basis: null, unit: "S0428" },
];
const LLM_ENV = Object.freeze({ POTONGIN_LLM: "on", POTONGIN_LLM_PROVIDERS: "openrouter", OPENROUTER_API_KEY: "sk-or-sealed-value" });

function authorize(request) {
  return isAuthorized(request, AUTH) ? null
    : Response.json({ error: "Sesi login tidak valid" }, { status: 401, headers: { "Cache-Control": "no-store" } });
}

function env(extra = {}) {
  return { ...AUTH, PATH: process.env.PATH, JOBS_ROOT: "/data/jobs", POTONGIN_EDITOR_V3: "on", ...extra };
}

function request(url, { method = "POST", body, headers = {}, origin = "http://local", cookie = true,
  contentType = "application/json" } = {}) {
  const all = { Host: "local", ...headers };
  if (origin) all.Origin = origin;
  if (cookie) all.Cookie = `potongin_session=${createSessionToken(AUTH)}`;
  if (body !== undefined && contentType) all["Content-Type"] = contentType;
  return new Request(`http://local${url}`, { method, headers: all, body, duplex: "half" });
}

const AI_URL = `/api/jobs/${JOB_ID}/clips/${CLIP_ID}/ai`;
const params = (extra = {}) => ({ params: Promise.resolve({ id: JOB_ID, clipId: CLIP_ID, ...extra }) });
const aiBody = (extra = {}) => JSON.stringify({ task: "hooks", doc: DOC, ...extra });

async function read(response) {
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body, headers: response.headers };
}

function recorder(results = {}) {
  const calls = [];
  const runCli = async (module, op, payload, options) => {
    calls.push({ module, op, payload, options });
    const result = results[op];
    if (result instanceof Error) throw result;
    if (typeof result === "function") return result(payload, options);
    if (!result) throw new Error(`unexpected op ${op}`);
    return result;
  };
  return { calls, runCli };
}

function route(options = {}) {
  const cli = options.cli ?? recorder({ heuristic: { exitCode: 0, json: { heuristic: HEURISTIC } }, "run-task": new Promise(() => {}) });
  const registry = options.registry ?? createTaskRegistry();
  const deps = {
    authorize, env: env(options.env), runCli: cli.runCli, registry,
    limiter: options.limiter ?? new TokenBucketLimiter({ capacity: 30, refillPerSecond: 30 / 3600 }),
    loadLlmEnv: options.loadLlmEnv ?? (async () => ({ env: { ...LLM_ENV }, source: "ui", problem: null })),
    newTaskId: () => TASK_ID, jobsRoot: options.jobsRoot ?? "/data/jobs", ...options.deps,
  };
  return { post: createAiRoute(deps), get: createAiTaskRoute(deps), cli, registry };
}

const LLM_ON = { POTONGIN_EDITOR_LLM: "on" };

// --- body and prologue ---------------------------------------------------------------------------

test("the body is exactly {task: 'hooks', doc}", () => {
  const enc = (value) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
  assert.ok(parseAiBody(enc({ task: "hooks", doc: DOC })));
  for (const bad of [{ doc: DOC }, { task: "hooks" }, { task: "hooks", doc: DOC, provider: "openai" },
    { task: "hooks", doc: DOC, model: "gpt-4o" }, { task: "hooks", doc: DOC, baseUrl: "http://evil" },
    { task: "judul", doc: DOC }, { task: "hooks", doc: [] }, { task: "hooks", doc: "x" }, [1], "nope"]) {
    assert.equal(parseAiBody(enc(bad)), null, JSON.stringify(bad));
  }
  assert.equal(parseAiBody(new Uint8Array([0xff, 0xfe])), null);
});

test("the routes export POST and GET only", () => {
  assert.equal(typeof aiRouteModule.POST, "function");
  assert.equal(typeof taskRouteModule.GET, "function");
  assert.equal(aiRouteModule.GET, undefined);
  assert.equal(taskRouteModule.POST, undefined);
});

test("POST checks the session, the editor flag, the origin, the ids, the type and the size", async () => {
  const { post, cli } = route();
  assert.equal((await post.POST(request(AI_URL, { body: aiBody(), cookie: false }), params())).status, 401);
  const off = route({ env: { POTONGIN_EDITOR_V3: "off" } });
  const disabled = await read(await off.post.POST(request(AI_URL, { body: aiBody() }), params()));
  assert.deepEqual([disabled.status, disabled.body.code], [404, "editor_disabled"]);
  assert.doesNotMatch(disabled.body.error, /V[0-9]/, "no version label in a message");
  const cross = await read(await post.POST(request(AI_URL, { body: aiBody(), origin: "http://evil" }), params()));
  assert.deepEqual([cross.status, cross.body.code], [403, "csrf_rejected"]);
  const badClip = await read(await post.POST(request(AI_URL, { body: aiBody() }), params({ clipId: "clip_x" })));
  assert.deepEqual([badClip.status, badClip.body.code], [400, "invalid_request"]);
  const badJob = await read(await post.POST(request(AI_URL, { body: aiBody() }), params({ id: "../etc" })));
  assert.equal(badJob.status, 400);
  assert.equal((await post.POST(request(AI_URL, { body: aiBody(), contentType: "text/plain" }), params())).status, 415);
  const big = "x".repeat(MAX_AI_BODY_BYTES + 1);
  assert.equal((await post.POST(request(AI_URL, { body: big }), params())).status, 413);
  for (const extra of [{ provider: "openai" }, { model: "gpt" }, { baseUrl: "http://x" }, { url: "http://x" }]) {
    const answer = await read(await post.POST(request(AI_URL, { body: aiBody(extra) }), params()));
    assert.deepEqual([answer.status, answer.body.code], [400, "invalid_request"], JSON.stringify(extra));
  }
  assert.equal(cli.calls.length, 0, "nothing was spawned for a refused request");
});

// --- the instant part and the LLM decision ----------------------------------------------------------

test("with the LLM flag off: the instant variants only, no task and no LLM environment", async () => {
  const { post, cli } = route();
  const answer = await read(await post.POST(request(AI_URL, { body: aiBody() }), params()));
  assert.equal(answer.status, 202);
  assert.deepEqual(answer.body, { taskId: null, heuristic: HEURISTIC, llm: { state: "disabled" } });
  assert.equal(answer.headers.get("cache-control"), "no-store");
  assert.equal(answer.headers.get("x-content-type-options"), "nosniff");
  assert.equal(cli.calls.length, 1);
  const [call] = cli.calls;
  assert.deepEqual([call.module, call.op], [AI_MODULE, "heuristic"]);
  assert.deepEqual(Object.keys(call.payload).sort(), ["clipId", "jobId", "requestRaw"]);
  assert.equal(Buffer.from(call.payload.requestRaw, "base64").toString(), aiBody());
  assert.notEqual(call.options.withLlmEnv, true);
});

test("instant variants are sanitised to the DTO fields", async () => {
  const noisy = [{ ...HEURISTIC[0], extra: "x", path: "/data/jobs" }, { id: "bad id", text: "x", source: "heuristic", fits: true },
    { id: "hk_9", text: "a".repeat(91), source: "heuristic", fits: true }, { id: "hk_8", text: "ok hook", source: "llm", fits: true },
    { ...HEURISTIC[1], unit: "../x", style: "evil" }];
  const { post } = route({ cli: recorder({ heuristic: { exitCode: 0, json: { heuristic: noisy } } }) });
  const answer = await read(await post.POST(request(AI_URL, { body: aiBody() }), params()));
  assert.deepEqual(answer.body.heuristic, [HEURISTIC[0], { ...HEURISTIC[1], unit: undefined }].map((item) => {
    const copy = { ...item };
    if (copy.unit === undefined) delete copy.unit;
    return copy;
  }));
});

test("a document the validator refuses is a 422, a broken backend a 503", async () => {
  const invalid = route({ cli: recorder({ heuristic: { exitCode: 6, json: { error: { code: "outside_window", path: "/main" }, errors: [{ code: "outside_window", path: "/main" }] } } }) });
  const refused = await read(await invalid.post.POST(request(AI_URL, { body: aiBody() }), params()));
  assert.deepEqual([refused.status, refused.body.code], [422, "outside_window"]);
  const broken = route({ cli: recorder({ heuristic: new PythonCliError("backend_failed") }) });
  assert.equal((await broken.post.POST(request(AI_URL, { body: aiBody() }), params())).status, 503);
  const missing = route({ cli: recorder({ heuristic: { exitCode: 4, json: { error: { code: "not_found" } } } }) });
  assert.equal((await missing.post.POST(request(AI_URL, { body: aiBody() }), params())).status, 404);
});

test("with the LLM on, the task starts with the loaded settings, a 25 s kill and no grace", async () => {
  let loadedFor = null;
  const loadLlmEnv = async (base) => { loadedFor = base; return { env: { ...LLM_ENV }, source: "ui", problem: null }; };
  const { post, cli, registry } = route({ env: { ...LLM_ON, POTONGIN_LLM_EDITOR_MODELS: "openrouter/fast:free" }, loadLlmEnv });
  const answer = await read(await post.POST(request(AI_URL, { body: aiBody() }), params()));
  assert.deepEqual(answer.body, { taskId: TASK_ID, heuristic: HEURISTIC, llm: { state: "pending" } });
  assert.equal(loadedFor.POTONGIN_EDITOR_LLM, "on", "loadLlmEnv reads the process environment");
  const task = cli.calls.find((call) => call.op === "run-task");
  assert.deepEqual(task.payload, { jobId: JOB_ID, clipId: CLIP_ID, taskId: TASK_ID, requestRaw: Buffer.from(aiBody()).toString("base64") });
  assert.equal(task.options.withLlmEnv, true);
  assert.equal(task.options.timeoutMs, KILL_AFTER_MS);
  assert.equal(KILL_AFTER_MS, 25_000);
  assert.equal(task.options.killGraceMs, 0);
  const loaded = await task.options.loadLlmEnvImpl();
  assert.equal(loaded.env.OPENROUTER_API_KEY, "sk-or-sealed-value");
  assert.equal(loaded.env.POTONGIN_LLM_EDITOR_MODELS, "openrouter/fast:free");
  assert.equal(registry.get(TASK_ID).state, "running");
  const heuristic = cli.calls.find((call) => call.op === "heuristic");
  assert.notEqual(heuristic.options.withLlmEnv, true, "the heuristic child never gets LLM variables");
});

test("the LLM part stays off for POTONGIN_LLM=off, disabled settings, no provider or unreadable settings", async () => {
  const cases = [
    [{ ...LLM_ON, POTONGIN_LLM: "off" }, async () => ({ env: { ...LLM_ENV }, problem: null }), { state: "disabled" }],
    [LLM_ON, async () => ({ env: { POTONGIN_LLM: "off" }, source: "ui", problem: null }), { state: "disabled" }],
    [LLM_ON, async () => ({ env: { POTONGIN_LLM: "on" }, source: "ui", problem: null }), { state: "disabled" }],
    [LLM_ON, async () => ({ env: { POTONGIN_LLM: "off" }, source: "ui", problem: "unreadable" }), { state: "disabled", message: SETTINGS_PROBLEM_MESSAGE }],
    [LLM_ON, async () => { throw new Error("boom"); }, { state: "disabled", message: SETTINGS_PROBLEM_MESSAGE }],
  ];
  for (const [flags, loadLlmEnv, expected] of cases) {
    const { post, cli } = route({ env: flags, loadLlmEnv });
    const answer = await read(await post.POST(request(AI_URL, { body: aiBody() }), params()));
    assert.deepEqual(answer.body.llm, expected);
    assert.equal(answer.body.taskId, null);
    assert.ok(!cli.calls.some((call) => call.op === "run-task"));
  }
});

test("at most 30 LLM tasks per job per hour, and at most 3 at once", async () => {
  let clock = 0;
  const limiter = new TokenBucketLimiter({ capacity: 30, refillPerSecond: 30 / 3600, now: () => clock });
  const registry = createTaskRegistry({ now: () => clock });
  let next = 0;
  const ids = () => `7c9e6679-7425-40de-944b-${String(next++).padStart(12, "0")}`;
  const cli = recorder({ heuristic: { exitCode: 0, json: { heuristic: HEURISTIC } }, "run-task": () => ({ exitCode: 0, json: {} }) });
  const { post } = route({ env: LLM_ON, limiter, registry, cli, deps: { newTaskId: ids } });
  const states = [];
  for (let index = 0; index < 31; index += 1) {
    const answer = await read(await post.POST(request(AI_URL, { body: aiBody() }), params()));
    states.push(answer.body.llm.state);
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(states.slice(0, 30), Array(30).fill("pending"));
  const last = await read(await post.POST(request(AI_URL, { body: aiBody() }), params()));
  assert.equal(last.body.llm.state, "rate_limited");
  assert.ok(last.body.llm.retryAfterMs >= 60_000 && last.body.llm.retryAfterMs <= 120_000);
  assert.equal(last.body.heuristic.length, 2, "the instant variants still come");
  const otherJob = await read(await post.POST(request(`/api/jobs/2b7d4c1a-9e0f-4a6b-8c3d-5e7f9a1b2c3d/clips/${CLIP_ID}/ai`, { body: aiBody() }),
    { params: Promise.resolve({ id: "2b7d4c1a-9e0f-4a6b-8c3d-5e7f9a1b2c3d", clipId: CLIP_ID }) }));
  assert.equal(otherJob.body.llm.state, "pending");

  const busy = route({ env: LLM_ON, cli: recorder({ heuristic: { exitCode: 0, json: { heuristic: HEURISTIC } }, "run-task": () => new Promise(() => {}) }),
    deps: { newTaskId: ids } });
  const seen = [];
  for (let index = 0; index < 4; index += 1) {
    seen.push((await read(await busy.post.POST(request(AI_URL, { body: aiBody() }), params()))).body.llm.state);
  }
  assert.deepEqual(seen, ["pending", "pending", "pending", "rate_limited"]);
});

// --- GET /ai/:taskId -----------------------------------------------------------------------------------

async function jobTree() {
  const root = await mkdtemp(path.join(os.tmpdir(), "editor-ai-"));
  const folder = path.join(root, JOB_ID, "analysis", "clips", CLIP_ID, "suggestions");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  return { root, folder };
}

function record(fields = {}) {
  return {
    schema: "potongin.editor-ai-task/1", taskId: TASK_ID, task: "hooks", clipId: CLIP_ID, state: "done",
    suggestions: [{ id: "ai_7c9e66790", text: "Kenapa sutradara ini nggak boleh masuk?", source: "llm", kind: "llm", fits: true,
      style: "pertanyaan", evidence: ["L0003"], basis: "Kenapa dia nggak boleh masuk?" }],
    dropped: [{ index: 1, code: "ungrounded_name", text: "Kata Deddy" }], error: null, llm: { provider: "openrouter", model: "m" },
    ...fields,
  };
}

const taskParams = (taskId = TASK_ID, extra = {}) => ({ params: Promise.resolve({ id: JOB_ID, clipId: CLIP_ID, taskId, ...extra }) });
const TASK_URL = `${AI_URL}/${TASK_ID}`;

test("GET answers pending while the child runs, then the task file, sanitised", async (t) => {
  const { root, folder } = await jobTree();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { get, registry } = route({ jobsRoot: root });
  registry.start(TASK_ID, { jobId: JOB_ID, clipId: CLIP_ID });
  const pending = await read(await get.GET(request(TASK_URL, { method: "GET" }), taskParams()));
  assert.deepEqual(pending.body, { state: "pending", suggestions: [], error: null });
  registry.finish(TASK_ID);
  const raw = record();
  raw.suggestions.push({ id: "../x", text: "bad", source: "llm", fits: true }, { ...raw.suggestions[0], id: "ai_x1", source: "heuristic" });
  await writeFile(path.join(folder, `${TASK_ID}.json`), JSON.stringify(raw), { mode: 0o600 });
  const done = await read(await get.GET(request(TASK_URL, { method: "GET" }), taskParams()));
  assert.equal(done.status, 200);
  assert.deepEqual(done.body, { state: "done", suggestions: [record().suggestions[0]], error: null });
  assert.ok(!JSON.stringify(done.body).includes("Deddy"), "dropped items stay in the task file");
});

test("GET reports a failed task file with its code, and a killed child as failed/timeout", async (t) => {
  const { root, folder } = await jobTree();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { get, registry } = route({ jobsRoot: root });
  await writeFile(path.join(folder, `${TASK_ID}.json`), JSON.stringify(record({ state: "failed", suggestions: [], error: { code: "llm_unavailable", messageId: "editor_ai.llm_unavailable" } })));
  const failed = await read(await get.GET(request(TASK_URL, { method: "GET" }), taskParams()));
  assert.deepEqual(failed.body, { state: "failed", suggestions: [], error: { code: "llm_unavailable", messageId: "editor_ai.llm_unavailable" } });
  const other = "11111111-2222-4333-8444-555555555555";
  registry.start(other, { jobId: JOB_ID, clipId: CLIP_ID });
  registry.finish(other, "timeout");
  const killed = await read(await get.GET(request(`${AI_URL}/${other}`, { method: "GET" }), taskParams(other)));
  assert.deepEqual(killed.body, { state: "failed", suggestions: [], error: { code: "timeout", messageId: "editor_ai.timeout" } });
});

test("GET refuses bad ids, other clips, unknown tasks and symlinked files", async (t) => {
  const { root, folder } = await jobTree();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { get, registry } = route({ jobsRoot: root });
  assert.equal((await get.GET(request(`${AI_URL}/nope`, { method: "GET" }), taskParams("nope"))).status, 400);
  assert.equal((await get.GET(request(TASK_URL, { method: "GET" }), taskParams())).status, 404);
  registry.start(TASK_ID, { jobId: JOB_ID, clipId: "clip_000000000000000000000000" });
  assert.equal((await get.GET(request(TASK_URL, { method: "GET" }), taskParams())).status, 404);
  const outside = path.join(root, "outside.json");
  await writeFile(outside, JSON.stringify(record()));
  const linked = "22222222-3333-4444-8555-666666666666";
  await symlink(outside, path.join(folder, `${linked}.json`));
  assert.equal((await get.GET(request(`${AI_URL}/${linked}`, { method: "GET" }), taskParams(linked))).status, 404);
  await writeFile(path.join(folder, "33333333-4444-4555-8666-777777777777.json"), JSON.stringify(record()));
  assert.equal((await get.GET(request(`${AI_URL}/33333333-4444-4555-8666-777777777777`, { method: "GET" }),
    taskParams("33333333-4444-4555-8666-777777777777"))).status, 404, "a file of another task id is not served");
  assert.equal((await get.GET(request(TASK_URL, { method: "GET", cookie: false }), taskParams())).status, 401);
});

// --- real children: environments, the saved settings and the kill ------------------------------------

// A stand-in "python" that records its environment and envelope, or sleeps.
const FAKE = String.raw`
import { readFileSync, writeFileSync } from "node:fs";
const envelope = JSON.parse(readFileSync(0, "utf8"));
const environ = {};
for (const entry of readFileSync("/proc/self/environ", "utf8").split("\0")) {
  if (!entry) continue;
  const at = entry.indexOf("=");
  environ[entry.slice(0, at)] = entry.slice(at + 1);
}
writeFileSync(process.env.JOBS_ROOT + "/" + envelope.op + ".env.json", JSON.stringify({ environ, envelope }));
if (envelope.op === "heuristic") {
  process.stdout.write(JSON.stringify({ heuristic: [] }));
} else if (process.env.JOBS_ROOT.endsWith("sleep")) {
  setTimeout(() => {}, 60_000);
} else {
  process.stdout.write(JSON.stringify({ taskId: envelope.taskId, state: "done", suggestions: [], error: null }));
}
`;

async function fakePython(dir) {
  const python = path.join(dir, "python.mjs");
  await writeFile(python, `#!${process.execPath}\n${FAKE}`);
  await chmod(python, 0o755);
  return python;
}

async function settle(registry, taskId, limitMs = 5000) {
  const started = Date.now();
  while (registry.get(taskId)?.state === "running" && Date.now() - started < limitMs) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const SECRET = "settings-secret-".padEnd(48, "q");

test("saved Pengaturan settings win over .env; only the AI child holds LLM keys; no dashboard secret leaks", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "editor-ai-env-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const jobs = path.join(root, "jobs");
  await mkdir(jobs);
  const settingsDir = path.join(root, "settings");
  const base = {
    ...AUTH, APP_SESSION_SECRET: SECRET, PATH: process.env.PATH, HOME: os.homedir(), JOBS_ROOT: jobs,
    POTONGIN_SETTINGS_DIR: settingsDir, POTONGIN_EDITOR_V3: "on", POTONGIN_EDITOR_LLM: "on",
    POTONGIN_LLM_PROVIDERS: "groq", GROQ_API_KEY: "gsk_env_key_value_123", OPENROUTER_API_KEY: "sk-or-env-key-value",
  };
  await saveLlmSettings({ enabled: true, freeOnly: true, providers: [
    { provider: "openrouter", enabled: true, apiKey: { action: "replace", value: "sk-or-v1-SAVEDsettingsKey99" } },
  ] }, { env: base });
  const python = await fakePython(root);
  const registry = createTaskRegistry();
  const deps = { authorize, env: base, registry, newTaskId: () => TASK_ID, pythonBin: python,
    runCli: (module, op, payload, options) => runPythonCli(module, op, payload, { ...options, env: base, pythonBin: python }) };
  const answer = await read(await createAiRoute(deps).POST(request(AI_URL, { body: aiBody() }), params()));
  assert.equal(answer.status, 202);
  assert.equal(answer.body.llm.state, "pending");
  await settle(registry, TASK_ID);
  const heuristic = JSON.parse(await readFile(path.join(jobs, "heuristic.env.json"), "utf8")).environ;
  const task = JSON.parse(await readFile(path.join(jobs, "run-task.env.json"), "utf8")).environ;
  for (const [name, value] of Object.entries(heuristic)) {
    assert.doesNotMatch(name, /^(?:APP_|POTONGIN_SETTINGS_|POTONGIN_LLM)|_API_KEY$/, `heuristic child got ${name}`);
    assert.ok(![SECRET, "gsk_env_key_value_123", "sk-or-v1-SAVEDsettingsKey99"].includes(value));
  }
  assert.equal(task.POTONGIN_LLM_PROVIDERS, "openrouter", "the saved settings name the chain");
  assert.equal(task.POTONGIN_LLM_OPENROUTER_API_KEY, "sk-or-v1-SAVEDsettingsKey99");
  assert.equal(task.POTONGIN_LLM_FREE_ONLY, "1");
  assert.ok(!Object.values(task).includes("gsk_env_key_value_123"), "the .env key is not used when settings exist");
  assert.ok(!Object.values(task).includes("sk-or-env-key-value"));
  for (const name of ["APP_PASSWORD", "APP_SESSION_SECRET", "APP_USERNAME", "POTONGIN_SETTINGS_DIR", "POTONGIN_SETTINGS_SECRET"]) {
    assert.equal(task[name], undefined, name);
  }
});

test("the Node side kills a task that outlives its deadline and reports failed/timeout", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "editor-ai-kill-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const jobs = path.join(root, "sleep");
  await mkdir(path.join(jobs, JOB_ID, "analysis", "clips", CLIP_ID), { recursive: true });
  const python = await fakePython(root);
  const registry = createTaskRegistry();
  const base = { ...AUTH, PATH: process.env.PATH, JOBS_ROOT: jobs, POTONGIN_EDITOR_V3: "on", POTONGIN_EDITOR_LLM: "on" };
  const deps = { authorize, env: base, registry, newTaskId: () => TASK_ID, killAfterMs: 300, jobsRoot: jobs,
    loadLlmEnv: async () => ({ env: { ...LLM_ENV }, source: "env", problem: null }),
    runCli: (module, op, payload, options) => runPythonCli(module, op, payload, { ...options, env: base, pythonBin: python }) };
  const started = Date.now();
  await createAiRoute(deps).POST(request(AI_URL, { body: aiBody() }), params());
  await settle(registry, TASK_ID);
  assert.ok(Date.now() - started < 4000);
  const answer = await read(await createAiTaskRoute(deps).GET(request(TASK_URL, { method: "GET" }), taskParams()));
  assert.deepEqual(answer.body, { state: "failed", suggestions: [], error: { code: "timeout", messageId: "editor_ai.timeout" } });
});

// --- the suggestions model (Teks panel) -------------------------------------------------------------------

function manualTimers() {
  const queue = [];
  let clock = 0;
  return {
    now: () => clock,
    setTimer: (fn, ms) => { const id = queue.length + 1; queue.push({ id, fn, at: clock + ms, done: false }); return id; },
    clearTimer: (id) => { const item = queue.find((entry) => entry.id === id); if (item) item.done = true; },
    async advance(ms) {
      clock += ms;
      for (const item of queue) {
        if (!item.done && item.at <= clock) { item.done = true; item.fn(); }
      }
      for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

const flush = async () => { for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve)); };

function fakeApi(script) {
  const calls = [];
  return {
    calls,
    async aiHooks(doc) { calls.push(["aiHooks", doc]); return script.hooks(doc); },
    async aiTask(taskId) { calls.push(["aiTask", taskId]); return script.task(taskId); },
  };
}

const docWithHook = (text = "Hook lama") => ({ main: { segments: [{ id: "seg_b1" }], removals: [] }, captions: { word_edits: {} },
  tracks: [{ kind: "hook", items: [{ id: "it_hook", payload: { text } }] }] });

test("labels, the apply command and the content key", () => {
  assert.deepEqual(SOURCE_LABELS, { ai_selection: "AI seleksi", heuristic: "Heuristik", llm: "AI" });
  for (const text of [...Object.values(SOURCE_LABELS), ...Object.values(COPY)]) {
    assert.doesNotMatch(text, /\bV[0-9]\b|mesin (?:lama|baru)|—/, text);
  }
  const suggestion = { id: "ai_7c9e66790", text: "Kenapa dia nggak boleh masuk?" };
  assert.deepEqual(applyCommand(docWithHook(), suggestion), { type: "SetHookText", args: { text: suggestion.text, origin: "suggestion:ai_7c9e66790" } });
  assert.deepEqual(applyCommand({ ...docWithHook(), tracks: [] }, suggestion),
    { type: "SetHookEnabled", args: { on: true, text: suggestion.text, origin: "suggestion:ai_7c9e66790" } });
  assert.ok(sameText(" Kenapa  dia ", "Kenapa dia"));
  assert.ok(!sameText("", ""));
  const doc = docWithHook();
  assert.equal(contentKey(doc), contentKey(docWithHook("Hook lain")), "the hook text does not make suggestions stale");
  assert.notEqual(contentKey(doc), contentKey({ ...doc, main: { ...doc.main, removals: [{ id: "rm_1" }] } }));
  assert.match(rateLimitedText(90_000), /2 menit/);
});

test("the controller shows the instant cards, then polls the task every second until done", async () => {
  const timers = manualTimers();
  let polls = 0;
  const api = fakeApi({
    hooks: () => ({ taskId: TASK_ID, heuristic: HEURISTIC, llm: { state: "pending" } }),
    task: () => (++polls < 3 ? { state: "pending", suggestions: [], error: null }
      : { state: "done", suggestions: [record().suggestions[0]], error: null }),
  });
  const controller = createSuggestions({ api, ...timers });
  const seen = [];
  controller.subscribe((state) => seen.push(state.phase));
  controller.ensure(docWithHook());
  controller.ensure(docWithHook());
  await flush();
  assert.equal(api.calls.filter(([name]) => name === "aiHooks").length, 1, "ensure asks once");
  assert.equal(controller.getState().phase, "ready");
  assert.deepEqual(controller.getState().heuristic, HEURISTIC);
  assert.equal(aiView(controller.getState().llm).status, "pending");
  await timers.advance(999);
  assert.equal(polls, 0);
  await timers.advance(1);
  await timers.advance(1000);
  await timers.advance(1000);
  assert.equal(polls, 3);
  assert.equal(controller.getState().llm.state, "done");
  assert.deepEqual(controller.getState().llm.suggestions.map((item) => item.id), ["ai_7c9e66790"]);
  await timers.advance(5000);
  assert.equal(polls, 3, "no polling after done");
  assert.deepEqual(seen.slice(0, 2), ["loading", "ready"]);
});

test("the controller gives up after 30 s, and shows failures, rate limits and notices", async () => {
  const timers = manualTimers();
  const api = fakeApi({ hooks: () => ({ taskId: TASK_ID, heuristic: [], llm: { state: "pending" } }), task: () => ({ state: "pending" }) });
  const controller = createSuggestions({ api, ...timers });
  await controller.request(docWithHook());
  for (let index = 0; index < 32; index += 1) await timers.advance(1000);
  assert.deepEqual([controller.getState().llm.state, controller.getState().llm.code], ["failed", "timeout"]);
  assert.equal(aiView(controller.getState().llm).text, COPY.failed);

  const failTimers = manualTimers();
  const failingApi = fakeApi({ hooks: () => ({ taskId: TASK_ID, heuristic: [], llm: { state: "pending" } }),
    task: () => ({ state: "failed", suggestions: [], error: { code: "llm_unavailable" } }) });
  const failed = createSuggestions({ api: failingApi, ...failTimers });
  await failed.request(docWithHook());
  await failTimers.advance(1000);
  assert.equal(failed.getState().llm.state, "failed");

  const limited = createSuggestions({ api: fakeApi({ hooks: () => ({ taskId: null, heuristic: HEURISTIC, llm: { state: "rate_limited", retryAfterMs: 125_000 } }) }) });
  await limited.request(docWithHook());
  assert.deepEqual(aiView(limited.getState().llm), { visible: true, status: "rate_limited", text: rateLimitedText(125_000) });
  const off = createSuggestions({ api: fakeApi({ hooks: () => ({ taskId: null, heuristic: HEURISTIC, llm: { state: "disabled" } }) }) });
  await off.request(docWithHook());
  assert.equal(aiView(off.getState().llm).visible, false, "the LLM off hides every AI line");
  const notice = createSuggestions({ api: fakeApi({ hooks: () => ({ taskId: null, heuristic: HEURISTIC, llm: { state: "disabled", message: SETTINGS_PROBLEM_MESSAGE } }) }) });
  await notice.request(docWithHook());
  assert.deepEqual(aiView(notice.getState().llm), { visible: true, status: "notice", text: SETTINGS_PROBLEM_MESSAGE });
  const broken = createSuggestions({ api: fakeApi({ hooks: () => { throw Object.assign(new Error("x"), { code: "network_error", status: 0 }); } }) });
  await broken.request(docWithHook());
  assert.deepEqual([broken.getState().phase, broken.getState().error.code], ["error", "network_error"]);
});

test("a newer request wins; one controller per clip and API client for the page", async () => {
  let resolveFirst;
  const api = fakeApi({
    hooks: (doc) => (doc.tag === "first" ? new Promise((resolve) => { resolveFirst = resolve; })
      : { taskId: null, heuristic: [HEURISTIC[1]], llm: { state: "disabled" } }),
  });
  const controller = createSuggestions({ api });
  const first = controller.request({ ...docWithHook(), tag: "first" });
  await controller.request({ ...docWithHook(), tag: "second" });
  resolveFirst({ taskId: null, heuristic: HEURISTIC, llm: { state: "disabled" } });
  await first;
  assert.deepEqual(controller.getState().heuristic, [HEURISTIC[1]]);
  const made = [];
  const factory = (options) => { made.push(options); return { id: made.length }; };
  const a = suggestionsFor(api, CLIP_ID, factory);
  assert.equal(suggestionsFor(api, CLIP_ID, factory), a);
  assert.notEqual(suggestionsFor(api, "clip_000000000000000000000000", factory), a);
  assert.notEqual(suggestionsFor(fakeApi({}), CLIP_ID, factory), a);
  assert.equal(suggestionsFor(null, CLIP_ID, factory), null);
});
