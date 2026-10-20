// Cek ejaan in the editor: POST /api/jobs/:id/clips/:clipId/ai with {task: "spelling", doc} (the
// LLM task only, under the hook task's flags and limits), the GET answer of a spelling task file,
// the browser client and the fakes, and the review model: the controller, the rows against the
// current document (open, applied, stale, skipped) and the commands an accept dispatches.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createFakeApiClient, fakeDoc, fakeWords } from "../components/editor/__dev__/fakes.mjs";
import {
  COPY,
  KIND_LABELS,
  acceptCommands,
  createSpellCheck,
  planAccept,
  spellingFor,
  spellingRows,
} from "../components/editor/spelling/model.mjs";
import { rateLimitedText } from "../components/editor/suggestions/model.mjs";
import { buildTranscriptModel } from "../components/editor/transcript/model.mjs";
import { createSessionToken, isAuthorized } from "../lib/auth.mjs";
import { createApiClient } from "../lib/editor/api-client.mjs";
import { applyCommand } from "../lib/editor/commands.mjs";
import { contentJson, createContext } from "../lib/editor/doc-model.mjs";
import { createEditSession } from "../lib/editor/history.mjs";
import {
  AI_MODULE,
  SETTINGS_PROBLEM_MESSAGE,
  createAiRoute,
  createAiTaskRoute,
  createTaskRegistry,
  parseAiBody,
  taskView,
} from "../lib/editor-ai.mjs";
import { TokenBucketLimiter } from "../lib/rate-limit.mjs";

const AUTH = Object.freeze({ APP_USERNAME: "admin", APP_PASSWORD: "pw-secret-value", APP_SESSION_SECRET: "session-secret-".padEnd(48, "z") });
const JOB_ID = "8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55";
const CLIP_ID = "clip_62654c2c2fa04f125391464a";
const TASK_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const DOC = Object.freeze({ schema: "clip-edit-v2", clip_id: CLIP_ID, tracks: [] });
const LLM_ENV = Object.freeze({ POTONGIN_LLM: "on", POTONGIN_LLM_PROVIDERS: "openrouter", OPENROUTER_API_KEY: "sk-or-sealed-value" });
const LLM_ON = Object.freeze({ POTONGIN_EDITOR_LLM: "on" });
const AI_URL = `/api/jobs/${JOB_ID}/clips/${CLIP_ID}/ai`;

const WORDS = fakeWords();
const ID = WORDS.words.map((word) => word.id); // ID[0] "Kenapa" … ID[4] "film" … ID[11] "subuh"
const CTX = createContext({ words: WORDS, seed: fakeDoc() });

function authorize(request) {
  return isAuthorized(request, AUTH) ? null
    : Response.json({ error: "Sesi login tidak valid" }, { status: 401, headers: { "Cache-Control": "no-store" } });
}

function request(url, { method = "POST", body, cookie = true } = {}) {
  const headers = { Host: "local", Origin: "http://local" };
  if (cookie) headers.Cookie = `potongin_session=${createSessionToken(AUTH)}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return new Request(`http://local${url}`, { method, headers, body, duplex: "half" });
}

const params = (extra = {}) => ({ params: Promise.resolve({ id: JOB_ID, clipId: CLIP_ID, ...extra }) });
const spellBody = (extra = {}) => JSON.stringify({ task: "spelling", doc: DOC, ...extra });

async function read(response) {
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}

function recorder(results = {}) {
  const calls = [];
  const runCli = async (module, op, payload, options) => {
    calls.push({ module, op, payload, options });
    const result = results[op];
    if (typeof result === "function") return result(payload, options);
    if (!result) throw new Error(`unexpected op ${op}`);
    return result;
  };
  return { calls, runCli };
}

function route(options = {}) {
  const cli = options.cli ?? recorder({ "run-task": () => new Promise(() => {}) });
  const registry = options.registry ?? createTaskRegistry();
  const deps = {
    authorize, env: { ...AUTH, JOBS_ROOT: "/data/jobs", POTONGIN_EDITOR_V3: "on", ...options.env }, runCli: cli.runCli, registry,
    limiter: options.limiter ?? new TokenBucketLimiter({ capacity: 30, refillPerSecond: 30 / 3600 }),
    loadLlmEnv: options.loadLlmEnv ?? (async () => ({ env: { ...LLM_ENV }, source: "ui", problem: null })),
    newTaskId: () => TASK_ID, jobsRoot: options.jobsRoot ?? "/data/jobs",
  };
  return { post: createAiRoute(deps), get: createAiTaskRoute(deps), cli, registry };
}

// --- POST {task: "spelling"} ------------------------------------------------------------------------

test("the body may name the spelling task, still with nothing but task and doc", () => {
  const enc = (value) => new TextEncoder().encode(JSON.stringify(value));
  assert.ok(parseAiBody(enc({ task: "spelling", doc: DOC })));
  assert.ok(parseAiBody(enc({ task: "hooks", doc: DOC })));
  for (const bad of [{ task: "spelling", doc: DOC, model: "gpt" }, { task: "spelling", doc: DOC, provider: "x" },
    { task: "Spelling", doc: DOC }, { task: "spelling", doc: [] }, { task: "spelling" }]) {
    assert.equal(parseAiBody(enc(bad)), null, JSON.stringify(bad));
  }
});

test("with the LLM flag off a spelling request answers disabled and spawns nothing", async () => {
  const { post, cli } = route();
  const answer = await read(await post.POST(request(AI_URL, { body: spellBody() }), params()));
  assert.equal(answer.status, 202);
  assert.deepEqual(answer.body, { taskId: null, llm: { state: "disabled" } });
  assert.equal(answer.headers.get("cache-control"), "no-store");
  assert.equal(cli.calls.length, 0);
});

test("with the LLM on, a spelling request starts the task alone, with the LLM environment and the kill", async () => {
  const { post, cli, registry } = route({ env: LLM_ON });
  const answer = await read(await post.POST(request(AI_URL, { body: spellBody() }), params()));
  assert.deepEqual(answer.body, { taskId: TASK_ID, llm: { state: "pending" } });
  assert.deepEqual(cli.calls.map((call) => [call.module, call.op]), [[AI_MODULE, "run-task"]], "no instant op");
  const [task] = cli.calls;
  assert.deepEqual(task.payload, { jobId: JOB_ID, clipId: CLIP_ID, taskId: TASK_ID, requestRaw: Buffer.from(spellBody()).toString("base64") });
  assert.equal(task.options.withLlmEnv, true);
  assert.equal(task.options.timeoutMs, 25_000);
  assert.equal((await task.options.loadLlmEnvImpl()).env.OPENROUTER_API_KEY, "sk-or-sealed-value");
  assert.equal(registry.get(TASK_ID).state, "running");
});

test("spelling shares the job's hourly AI limit and explains unreadable settings", async () => {
  let clock = 0;
  const limiter = new TokenBucketLimiter({ capacity: 30, refillPerSecond: 30 / 3600, now: () => clock });
  while (limiter.take(`job:${JOB_ID}`).allowed) { /* the hook task used the hour */ }
  const limited = route({ env: LLM_ON, limiter });
  const answer = await read(await limited.post.POST(request(AI_URL, { body: spellBody() }), params()));
  assert.equal(answer.body.taskId, null);
  assert.equal(answer.body.llm.state, "rate_limited");
  assert.ok(answer.body.llm.retryAfterMs >= 1000);
  assert.equal(limited.cli.calls.length, 0);
  const unreadable = route({ env: LLM_ON, loadLlmEnv: async () => { throw new Error("broken"); } });
  const notice = await read(await unreadable.post.POST(request(AI_URL, { body: spellBody() }), params()));
  assert.deepEqual(notice.body, { taskId: null, llm: { state: "disabled", message: SETTINGS_PROBLEM_MESSAGE } });
});

test("a spelling request is refused before anything runs: session, flag, origin, body", async () => {
  const { post, cli } = route({ env: LLM_ON });
  assert.equal((await post.POST(request(AI_URL, { body: spellBody(), cookie: false }), params())).status, 401);
  assert.equal((await post.POST(request(AI_URL, { body: spellBody({ model: "gpt" }) }), params())).status, 400);
  const off = route({ env: { ...LLM_ON, POTONGIN_EDITOR_V3: "off" } });
  assert.equal((await off.post.POST(request(AI_URL, { body: spellBody() }), params())).status, 404);
  assert.equal(cli.calls.length, 0);
});

// --- GET a spelling task --------------------------------------------------------------------------

const SUGGESTION = Object.freeze({ id: "sp_7c9e66790", wordIds: ["w048125"], from: "flim", to: "film", kind: "spelling" });

function spellRecord(fields = {}) {
  return {
    schema: "potongin.editor-ai-task/1", taskId: TASK_ID, task: "spelling", clipId: CLIP_ID, state: "done",
    suggestions: [{ ...SUGGESTION }], dropped: [{ index: 1, code: "too_different", text: "nggak → tidak" }],
    error: null, truncated: false, linesSent: 4, linesTotal: 4, ...fields,
  };
}

test("a spelling task file becomes {state, suggestions, error, truncated} with clean suggestions only", () => {
  const raw = spellRecord({ truncated: true });
  raw.suggestions.push(
    { ...SUGGESTION, id: "sp_x1", extra: "/data/jobs" },
    { ...SUGGESTION, id: "../x" },
    { ...SUGGESTION, id: "sp_x2", wordIds: ["w1", "w048126"] },
    { ...SUGGESTION, id: "sp_x3", wordIds: ["w048121", "w048122", "w048123", "w048124"] },
    { ...SUGGESTION, id: "sp_x4", wordIds: ["w048125", "w048125"] },
    { ...SUGGESTION, id: "sp_x5", to: "flim" },
    { ...SUGGESTION, id: "sp_x6", to: "x".repeat(41) },
    { ...SUGGESTION, id: "sp_x7", kind: "grammar" },
    { ...SUGGESTION, id: "sp_x8", from: "" },
    { ...SUGGESTION, id: "sp_7c9e66790" },
  );
  const view = taskView(raw, { taskId: TASK_ID, clipId: CLIP_ID });
  assert.deepEqual(view, { state: "done", suggestions: [SUGGESTION, { ...SUGGESTION, id: "sp_x1" }], error: null, truncated: true });
  assert.ok(!JSON.stringify(view).includes("tidak"), "dropped items stay in the task file");
  const failed = taskView(spellRecord({ state: "failed", suggestions: [], error: { code: "invalid_output" } }), { taskId: TASK_ID, clipId: CLIP_ID });
  assert.deepEqual(failed, { state: "failed", suggestions: [], error: { code: "invalid_output", messageId: "editor_ai.invalid_output" } });
  const many = spellRecord({ suggestions: Array.from({ length: 70 }, (_, n) => ({ ...SUGGESTION, id: `sp_a${n}` })) });
  assert.equal(taskView(many, { taskId: TASK_ID, clipId: CLIP_ID }).suggestions.length, 60);
  assert.equal(taskView({ ...spellRecord(), task: "judul" }, { taskId: TASK_ID, clipId: CLIP_ID }), null);
});

test("GET serves a spelling task file through the route", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "editor-spelling-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = path.join(root, JOB_ID, "analysis", "clips", CLIP_ID, "suggestions");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await writeFile(path.join(folder, `${TASK_ID}.json`), JSON.stringify(spellRecord()), { mode: 0o600 });
  const { get } = route({ jobsRoot: root });
  const answer = await read(await get.GET(request(`${AI_URL}/${TASK_ID}`, { method: "GET" }), params({ taskId: TASK_ID })));
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, { state: "done", suggestions: [SUGGESTION], error: null, truncated: false });
});

// --- the browser client and the fakes ------------------------------------------------------------------

test("the API client posts {task: 'spelling', doc} to the clip's AI route", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ taskId: null, llm: { state: "disabled" } }), { status: 202, headers: { "Content-Type": "application/json" } });
  };
  const api = createApiClient({ jobId: JOB_ID, clipId: CLIP_ID, fetchImpl });
  assert.deepEqual(await api.aiSpelling({ revision: 3 }), { taskId: null, llm: { state: "disabled" } });
  assert.equal(calls[0].url, `/api/jobs/${JOB_ID}/clips/${CLIP_ID}/ai`);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { task: "spelling", doc: { revision: 3 } });
});

test("the fake API answers a spelling check with a task whose suggestions fit the fake words", async () => {
  const api = createFakeApiClient();
  const started = await api.aiSpelling(fakeDoc());
  assert.equal(started.llm.state, "pending");
  const answer = await api.aiTask(started.taskId);
  assert.equal(answer.state, "done");
  const rows = spellingRows({ suggestions: answer.suggestions, model: buildTranscriptModel(WORDS, fakeDoc()) });
  assert.ok(rows.rows.length >= 1 && rows.stale === 0, "every fake suggestion is open on the fake clip");
  const hooks = await api.aiTask("00000000-0000-4000-8000-000000000001");
  assert.ok(hooks.suggestions.every((item) => typeof item.text === "string"), "the hook task keeps its answer");
});

// --- the controller ------------------------------------------------------------------------------------------

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
    async aiSpelling(doc) { calls.push(["aiSpelling", doc]); return script.start(doc); },
    async aiTask(taskId) { calls.push(["aiTask", taskId]); return script.task(taskId); },
  };
}

test("the controller checks once on ensure, polls every second and lands on the suggestions", async () => {
  const timers = manualTimers();
  let polls = 0;
  const api = fakeApi({
    start: () => ({ taskId: TASK_ID, llm: { state: "pending" } }),
    task: () => (++polls < 3 ? { state: "pending", suggestions: [], error: null }
      : { state: "done", suggestions: [SUGGESTION, { id: 7 }], error: null, truncated: true }),
  });
  const check = createSpellCheck({ api, ...timers });
  check.ensure(fakeDoc());
  check.ensure(fakeDoc());
  await flush();
  assert.equal(api.calls.filter(([name]) => name === "aiSpelling").length, 1);
  assert.equal(check.getState().phase, "checking");
  for (let index = 0; index < 3; index += 1) await timers.advance(1000);
  assert.equal(polls, 3);
  assert.deepEqual(check.getState().suggestions, [SUGGESTION], "malformed items are dropped");
  assert.equal(check.getState().phase, "done");
  assert.equal(check.getState().truncated, true);
  await timers.advance(5000);
  assert.equal(polls, 3, "no polling after done");
});

test("the controller reports the LLM off, the limit, failures, a timeout and a network error", async () => {
  const off = createSpellCheck({ api: fakeApi({ start: () => ({ taskId: null, llm: { state: "disabled" } }) }) });
  await off.check(fakeDoc());
  assert.deepEqual([off.getState().phase, off.getState().message], ["off", null]);
  const notice = createSpellCheck({ api: fakeApi({ start: () => ({ taskId: null, llm: { state: "disabled", message: SETTINGS_PROBLEM_MESSAGE } }) }) });
  await notice.check(fakeDoc());
  assert.deepEqual([notice.getState().phase, notice.getState().message], ["off", SETTINGS_PROBLEM_MESSAGE]);
  const limited = createSpellCheck({ api: fakeApi({ start: () => ({ taskId: null, llm: { state: "rate_limited", retryAfterMs: 125_000 } }) }) });
  await limited.check(fakeDoc());
  assert.deepEqual([limited.getState().phase, limited.getState().retryAfterMs], ["rate_limited", 125_000]);

  const timers = manualTimers();
  const failing = createSpellCheck({ api: fakeApi({ start: () => ({ taskId: TASK_ID, llm: { state: "pending" } }),
    task: () => ({ state: "failed", suggestions: [], error: { code: "llm_unavailable" } }) }), ...timers });
  await failing.check(fakeDoc());
  await timers.advance(1000);
  assert.deepEqual([failing.getState().phase, failing.getState().code], ["failed", "llm_unavailable"]);

  const slow = manualTimers();
  const stuck = createSpellCheck({ api: fakeApi({ start: () => ({ taskId: TASK_ID, llm: { state: "pending" } }), task: () => ({ state: "pending" }) }), ...slow });
  await stuck.check(fakeDoc());
  for (let index = 0; index < 32; index += 1) await slow.advance(1000);
  assert.deepEqual([stuck.getState().phase, stuck.getState().code], ["failed", "timeout"]);

  const broken = createSpellCheck({ api: fakeApi({ start: () => { throw Object.assign(new Error("x"), { status: 0, code: "network_error" }); } }) });
  await broken.check(fakeDoc());
  assert.deepEqual([broken.getState().phase, broken.getState().code], ["error", "network_error"]);
});

test("skipping hides a suggestion until 'Tampilkan lagi'; a new check starts clean; one controller per clip", async () => {
  const api = fakeApi({ start: () => ({ taskId: TASK_ID, llm: { state: "pending" } }), task: () => ({ state: "done", suggestions: [SUGGESTION], error: null }) });
  const timers = manualTimers();
  const check = createSpellCheck({ api, ...timers });
  await check.check(fakeDoc());
  await timers.advance(1000);
  check.skip(SUGGESTION.id);
  assert.deepEqual(check.getState().skipped, [SUGGESTION.id]);
  check.restoreSkipped();
  assert.deepEqual(check.getState().skipped, []);
  check.skip(SUGGESTION.id);
  const again = check.check(fakeDoc());
  assert.deepEqual([check.getState().phase, check.getState().skipped, check.getState().suggestions], ["checking", [], []]);
  await again;
  const made = [];
  const factory = (options) => { made.push(options); return { id: made.length }; };
  const first = spellingFor(api, CLIP_ID, factory);
  assert.equal(spellingFor(api, CLIP_ID, factory), first);
  assert.notEqual(spellingFor(api, "clip_000000000000000000000000", factory), first);
  assert.equal(spellingFor(null, CLIP_ID, factory), null);
});

// --- rows and commands ----------------------------------------------------------------------------------------

// The fake clip with a typo written into it: "film" reads "flim".
function typoDoc() {
  const doc = fakeDoc();
  doc.captions.word_edits = { [ID[4]]: { text: "flim" } };
  return doc;
}

const FLIM = Object.freeze({ id: "sp_a0", wordIds: [ID[4]], from: "flim", to: "film", kind: "spelling" });
const MERGE = Object.freeze({ id: "sp_a1", wordIds: [ID[3], ID[4]], from: "di flim", to: "diflim", kind: "spacing" });
const CASE = Object.freeze({ id: "sp_a2", wordIds: [ID[11]], from: "subuh", to: "Subuh", kind: "case" });

test("rows are the open suggestions with their context; applied, stale and skipped ones are counted", () => {
  const doc = typoDoc();
  const model = buildTranscriptModel(WORDS, doc);
  const view = spellingRows({ suggestions: [FLIM, CASE, { ...CASE, id: "sp_a3", wordIds: ["w999999"] }], model, skipped: [CASE.id] });
  assert.deepEqual(view.rows.map((row) => row.id), [FLIM.id]);
  const [row] = view.rows;
  assert.deepEqual([row.before, row.after], [["sutradara", "ditahan", "di"], ["sendiri?"]], "context stays in the sentence");
  assert.equal(row.kindLabel, KIND_LABELS.spelling);
  assert.deepEqual([row.s, row.e], [WORDS.words[4].s, WORDS.words[4].e]);
  assert.deepEqual([view.applied, view.stale, view.skipped], [0, 1, 1]);

  const accepted = applyCommand(doc, "EditWordText", { wordId: ID[4], text: "film" }, CTX).doc;
  const after = spellingRows({ suggestions: [FLIM], model: buildTranscriptModel(WORDS, accepted) });
  assert.deepEqual([after.rows.length, after.applied, after.stale], [0, 1, 0]);
  const retyped = applyCommand(doc, "EditWordText", { wordId: ID[4], text: "filem" }, CTX).doc;
  assert.deepEqual(spellingRows({ suggestions: [FLIM], model: buildTranscriptModel(WORDS, retyped) }).stale, 1);
  const hidden = applyCommand(doc, "SetWordHidden", { wordId: ID[4], on: true }, CTX).doc;
  assert.deepEqual(spellingRows({ suggestions: [FLIM], model: buildTranscriptModel(WORDS, hidden) }).stale, 1);
});

test("accepting writes the word's text and hides the merged words, under one merge key", () => {
  assert.deepEqual(acceptCommands(MERGE, "tx:spelling:1"), [
    { type: "EditWordText", args: { wordId: ID[3], text: "diflim" }, mergeKey: "tx:spelling:1" },
    { type: "SetWordHidden", args: { wordId: ID[4], on: true }, mergeKey: "tx:spelling:1" },
  ]);
  const doc = typoDoc();
  const view = spellingRows({ suggestions: [MERGE], model: buildTranscriptModel(WORDS, doc) });
  const plan = planAccept({ rows: view.rows, doc, ctx: CTX, mergeKey: "tx:spelling:2" });
  assert.equal(plan.accepted, 1);
  let next = doc;
  for (const { type, args } of plan.commands) next = applyCommand(next, type, args, CTX).doc;
  assert.deepEqual(next.captions.word_edits[ID[3]], { text: "diflim" });
  assert.deepEqual(next.captions.word_edits[ID[4]], { text: "flim", hidden: true });
  assert.deepEqual(spellingRows({ suggestions: [MERGE], model: buildTranscriptModel(WORDS, next) }).applied, 1);
});

test("'Terima semua' is one undo step and skips a row the document refuses", () => {
  let t = 0;
  const doc = typoDoc();
  const session = createEditSession({ doc, ctx: CTX, now: () => (t += 1) });
  const tooLong = { id: "sp_a4", wordIds: [ID[1]], from: "sutradara", to: "s".repeat(41), kind: "spelling" };
  const view = spellingRows({ suggestions: [FLIM, tooLong, CASE], model: buildTranscriptModel(WORDS, doc) });
  assert.equal(view.rows.length, 3);
  const plan = planAccept({ rows: view.rows, doc, ctx: CTX, mergeKey: "tx:spelling:3" });
  assert.equal(plan.accepted, 2);
  assert.deepEqual(plan.skipped.map((entry) => entry.row.id), [tooLong.id]);
  assert.match(plan.skipped[0].message, /\S/);
  for (const { type, args, mergeKey } of plan.commands) session.dispatch(type, args, { mergeKey });
  assert.equal(session.doc.captions.word_edits[ID[4]], undefined, "the ASR text again: no edit left");
  assert.deepEqual(session.doc.captions.word_edits[ID[11]], { text: "Subuh" });
  assert.equal(session.history.size, 1);
  session.undo();
  assert.equal(contentJson(session.doc), contentJson(doc));
});

test("the page passes the LLM flag, and both views show Cek ejaan only with it", async () => {
  const read = (rel) => readFile(new URL(`../${rel}`, import.meta.url), "utf8");
  assert.match(await read("app/projects/[id]/clips/[clipId]/edit/page.jsx"), /features=\{\{ uploads: flags\.uploads, llm: flags\.llm \}\}/);
  for (const file of ["components/editor/transcript/TranscriptPanel.jsx", "components/editor/quick/CaptionLinesCard.jsx"]) {
    const source = await read(file);
    assert.match(source, /\{llmEnabled \? \(\s*<\w+[^>]*data-spelling-toggle=""/, `${file}: the toggle waits for llmEnabled`);
    assert.match(source, /\{spellingOpen && llmEnabled \?/, `${file}: so does the review`);
  }
});

test("copy: short Indonesian, no version wording, the shared limit text", () => {
  for (const text of [...Object.values(KIND_LABELS), ...Object.values(COPY).filter((value) => typeof value === "string")]) {
    assert.doesNotMatch(text, /\bV[0-9]\b|mesin (?:lama|baru)|—|\bbaru\b/i, text);
  }
  assert.equal(COPY.acceptAll(3), "Terima semua (3)");
  assert.match(rateLimitedText(90_000), /2 menit/);
});
