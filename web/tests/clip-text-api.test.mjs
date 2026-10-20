// A clip's title and description on the project page (plan 2026-10-20 P2): the owner's edit as
// the job serves it (beside the engine's packaging, which stays), its use by downloads, the ZIP,
// Riwayat and the editor's clip listing, the queue's locked update of a finished job,
// PATCH /api/jobs/:id/clip-text and POST /api/jobs/:id/clip-text/rewrite ("Tulis ulang", the free
// LLM chain of Pengaturan through `python -m ai_clipper.post_text`).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PATCH } from "../app/api/jobs/[id]/clip-text/route.js";
import { POST as REWRITE } from "../app/api/jobs/[id]/clip-text/rewrite/route.js";
import { GET as JOB_GET } from "../app/api/jobs/[id]/route.js";
import { createSessionToken } from "../lib/auth.mjs";
import { clipSaveName } from "../lib/clip-download.mjs";
import { libraryItems } from "../lib/clip-library.mjs";
import { createClipsRoute } from "../lib/clip-edit.mjs";
import {
  MAX_RUNNING_REWRITES,
  MAX_TEXT_BODY_BYTES,
  REWRITE_KILL_AFTER_MS,
  REWRITE_MODULE,
  createRewriteRoute,
  parseClipTextBody,
} from "../lib/clip-text-api.mjs";
import { zipEntryNames } from "../lib/clips-zip.mjs";
import { CLIP_TEXT_LIMITS, serializePublicJob, withClipTextEdit } from "../lib/jobs.mjs";
import { saveLlmSettings } from "../lib/llm-settings.mjs";
import { updateCompletedJob } from "../lib/primary-job-queue.mjs";
import { PYTHON_CLI_MODULES, PythonCliError, runPythonCli } from "../lib/python-cli.mjs";
import { TokenBucketLimiter } from "../lib/rate-limit.mjs";
import { fakePython, withEnv } from "./security-support.mjs";

const JOB_ID = "4d2c6b1a-7e3f-4a5b-9c8d-1e2f3a4b5c6d";
const AUTH = Object.freeze({
  APP_USERNAME: "admin",
  APP_PASSWORD: "clip-text-route-password",
  APP_SESSION_SECRET: "clip-text-session-secret-".padEnd(48, "k"),
});
const LLM_ENV = Object.freeze({ POTONGIN_LLM: "on", POTONGIN_LLM_PROVIDERS: "openrouter", OPENROUTER_API_KEY: "planted-or-key-for-tests" });
const TEXT = "Gue tuh dulu kerja jadi security di mall. Jadi gue tahan dia di pintu belakang.";

function packagedClip(index, extra = {}) {
  const base = `/api/jobs/${JOB_ID}/files/output/clip-0${index}`;
  return {
    index, score: 7.4, duration: 31, text: TEXT, selectionSource: "llm",
    title: `Judul mesin ${index}`, hookText: "Hook di video", description: "Cerita mesin.\n\n#fyp #mesin", hashtags: ["#fyp", "#mesin"],
    videoUrl: `${base}.mp4`, downloadUrl: `${base}.mp4?download=1`, subtitleUrl: `${base}.srt?download=1`, ...extra,
  };
}

function job(extra = {}) {
  return {
    id: JOB_ID, status: "completed", progress: 100, createdAt: "2026-10-21T08:00:00.000Z", updatedAt: "2026-10-21T08:30:00.000Z",
    source: { type: "upload", name: "Podcast 12.mp4" }, options: { selectionMode: "v3" },
    clips: [packagedClip(1), packagedClip(2)], ...extra,
  };
}

async function jobsRoot(t, record = job()) {
  const root = await mkdtemp(path.join(os.tmpdir(), "potongin-clip-text-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (record) {
    await mkdir(path.join(root, record.id), { recursive: true });
    await writeFile(path.join(root, record.id, "job.json"), `${JSON.stringify(record, null, 2)}\n`);
  }
  return root;
}

const readJob = async (root, id = JOB_ID) => JSON.parse(await readFile(path.join(root, id, "job.json"), "utf8"));

async function read(response) {
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body, headers: response.headers };
}

function request(url, { method = "PATCH", body, origin = "http://local", site = "same-origin", session = true,
  contentType = "application/json" } = {}) {
  const headers = { Host: "local" };
  if (origin) headers.Origin = origin;
  if (site) headers["Sec-Fetch-Site"] = site;
  if (session) headers.Cookie = `potongin_session=${createSessionToken(AUTH)}`;
  if (body !== undefined && contentType) headers["Content-Type"] = contentType;
  return new Request(`http://local${url}`, { method, headers, body, duplex: "half" });
}

const params = (id = JOB_ID) => ({ params: Promise.resolve({ id }) });
const TEXT_URL = `/api/jobs/${JOB_ID}/clip-text`;
const REWRITE_URL = `${TEXT_URL}/rewrite`;
const edit = (fields = {}) => JSON.stringify({ index: 2, title: "Judul baru dari pemilik", description: "Deskripsi baru.\n\n#podcast #lucu", ...fields });

async function patch(root, options = {}) {
  return withEnv({ ...AUTH, JOBS_ROOT: root }, async () => read(await PATCH(request(TEXT_URL, { body: edit(), ...options }), params(options.id))));
}

// --- the edit as served ----------------------------------------------------------------------------

test("the owner's edit is served in place of the engine's packaging, which stays in the job", () => {
  const edited = packagedClip(1, { textEdit: { title: "  Judul  baru ", description: "Badan teks.\r\n\r\n\r\n#Podcast #lucu #podcast", editedAt: "2026-10-21T09:00:00.000Z" } });
  const served = serializePublicJob(job({ clips: [edited, packagedClip(2)] }));
  assert.equal(served.clips[0].title, "Judul baru");
  assert.equal(served.clips[0].description, "Badan teks.\n\n#Podcast #lucu #podcast");
  assert.deepEqual(served.clips[0].hashtags, ["#Podcast", "#lucu"]);
  assert.equal(served.clips[0].textEdit, undefined, "the stored edit itself is not served");
  assert.equal(served.clips[0].hookText, "Hook di video", "the hook text burned into the video is not part of the edit");
  assert.equal(served.clips[1].title, "Judul mesin 2");
  assert.equal(edited.title, "Judul mesin 1", "the engine's own title is kept");

  // A clip made before Selection V3 gets its text regenerated from the transcript; an edit wins.
  const old = { index: 3, text: TEXT, title: "lama", textEdit: { title: "Judul klip lama", description: "" } };
  const oldServed = serializePublicJob(job({ clips: [old] })).clips[0];
  assert.deepEqual([oldServed.title, oldServed.description, oldServed.hashtags], ["Judul klip lama", "", []]);

  // An edit without a usable title is ignored, so the engine's text shows.
  for (const broken of [{ title: "   ", description: "x" }, { description: "x" }, "judul", null, ["a"]]) {
    const clip = serializePublicJob(job({ clips: [packagedClip(1, { textEdit: broken })] })).clips[0];
    assert.equal(clip.title, "Judul mesin 1", JSON.stringify(broken));
    assert.equal(clip.textEdit, undefined);
  }
  // Served text keeps today's limits.
  const long = withClipTextEdit(packagedClip(1, { textEdit: { title: "a".repeat(300), description: "b".repeat(5000) } }));
  assert.ok(Array.from(long.title).length <= CLIP_TEXT_LIMITS.title);
  assert.ok(Array.from(long.description).length <= CLIP_TEXT_LIMITS.storedDescription);
});

test("downloads, the ZIP, Riwayat and the editor's clip listing use the edited title", async (t) => {
  const edited = packagedClip(1, { textEdit: { title: "Sutradara ditahan satpam", description: "Teks.\n\n#a1" } });
  const served = serializePublicJob(job({ clips: [edited] })).clips[0];
  assert.equal(clipSaveName(served), "01-sutradara-ditahan-satpam");
  assert.deepEqual(zipEntryNames([edited, packagedClip(2)]), ["01-sutradara-ditahan-satpam.mp4", "02-judul-mesin-2.mp4"]);
  const items = libraryItems(job({ clips: [edited] }), JOB_ID);
  assert.equal(items[0].title, "Sutradara ditahan satpam");
  assert.match(items[0].haystack, /sutradara ditahan satpam/);

  const root = await jobsRoot(t, job({ clips: [edited, packagedClip(2)] }));
  const listing = [
    { clipId: "clip_0123456789abcdef01234567", index: 1, title: "Judul mesin 1", description: "Cerita mesin.", hashtags: ["#fyp"], openable: true },
    { clipId: "clip_0123456789abcdef01234568", index: 2, title: "Judul mesin 2", description: "Cerita mesin.", hashtags: ["#fyp"], openable: true },
  ];
  const route = createClipsRoute({
    authorize: () => null, env: { POTONGIN_EDITOR_V3: "on", JOBS_ROOT: root }, jobsRoot: root,
    runCli: async () => ({ exitCode: 0, json: { clips: listing } }), latestRenders: async () => new Map(),
  });
  const answer = await read(await route.GET(request(`/api/jobs/${JOB_ID}/clips`, { method: "GET" }), params()));
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body.clips.map((clip) => [clip.title, clip.description, clip.hashtags]), [
    ["Sutradara ditahan satpam", "Teks.\n\n#a1", ["#a1"]],
    ["Judul mesin 2", "Cerita mesin.", ["#fyp"]],
  ]);
});

// --- the queue's update of a finished job -----------------------------------------------------------

test("updateCompletedJob changes a finished job under the queue lock and leaves any other job alone", async (t) => {
  const root = await jobsRoot(t);
  const result = await updateCompletedJob({ jobsRoot: root, id: JOB_ID }, (current) => ({ ...current, note: "x" }));
  assert.equal(result.outcome, "updated");
  assert.equal((await readJob(root)).note, "x");
  assert.equal((await updateCompletedJob({ jobsRoot: root, id: JOB_ID }, () => null)).outcome, "unchanged");

  for (const status of ["processing", "queued", "failed", "cancelled", "deleting"]) {
    const other = job({ id: crypto.randomUUID(), status });
    await mkdir(path.join(root, other.id));
    await writeFile(path.join(root, other.id, "job.json"), JSON.stringify(other));
    let called = false;
    const answer = await updateCompletedJob({ jobsRoot: root, id: other.id }, () => { called = true; return { status: "completed" }; });
    assert.equal(answer.outcome, "not_completed", status);
    assert.equal(called, false);
    assert.equal((await readJob(root, other.id)).status, status);
  }
  assert.equal((await updateCompletedJob({ jobsRoot: root, id: crypto.randomUUID() }, () => ({}))).outcome, "not_found");
  assert.equal((await updateCompletedJob({ jobsRoot: root, id: "../x" }, () => ({}))).outcome, "not_found");
});

// --- PATCH /api/jobs/:id/clip-text ---------------------------------------------------------------------

test("the body is exactly {index, title, description} within today's limits", () => {
  const ok = (fields) => parseClipTextBody(Buffer.from(JSON.stringify({ index: 1, title: "Judul", description: "", ...fields })));
  assert.deepEqual(ok({}), { index: 1, title: "Judul", description: "" });
  assert.deepEqual(ok({ title: "  Judul\tbaru ", description: "Satu.\r\n\r\n\r\nDua.  " }), { index: 1, title: "Judul baru", description: "Satu.\n\nDua." });
  assert.equal(ok({ title: "a".repeat(CLIP_TEXT_LIMITS.title) }).title.length, 100);
  assert.equal(ok({ title: "   " }).code, "title_empty");
  assert.equal(ok({ title: "a".repeat(101) }).code, "title_too_long");
  assert.equal(ok({ title: "😀".repeat(100) }).title, "😀".repeat(100), "limits count characters, not UTF-16 units");
  assert.equal(ok({ description: "b".repeat(CLIP_TEXT_LIMITS.storedDescription + 1) }).code, "description_too_long");
  for (const bad of [
    { index: 0 }, { index: 10000 }, { index: "1" }, { index: 1.5 }, { title: 3 }, { description: null }, { extra: 1 },
  ]) assert.equal(ok(bad).code, "invalid_request", JSON.stringify(bad));
  assert.equal(parseClipTextBody(Buffer.from("[1]")).code, "invalid_request");
  assert.equal(parseClipTextBody(Buffer.from("{")).code, "invalid_request");
  assert.equal(parseClipTextBody(Buffer.from([0xff, 0xfe])).code, "invalid_request");
});

test("saving needs a session and a same-origin request, and changes nothing otherwise", async (t) => {
  const root = await jobsRoot(t);
  const before = await readFile(path.join(root, JOB_ID, "job.json"), "utf8");
  assert.equal((await patch(root, { session: false })).status, 401);
  for (const refused of [{ origin: "http://evil.example" }, { origin: null }, { site: "cross-site" }]) {
    const answer = await patch(root, refused);
    assert.equal(answer.status, 403, JSON.stringify(refused));
    assert.equal(answer.body.code, "csrf_rejected");
  }
  assert.equal((await patch(root, { id: "not-a-job" })).status, 400);
  assert.equal((await patch(root, { contentType: "text/plain" })).status, 415);
  assert.equal((await patch(root, { body: "x".repeat(MAX_TEXT_BODY_BYTES + 1) })).status, 413);
  const empty = await patch(root, { body: edit({ title: " " }) });
  assert.deepEqual([empty.status, empty.body.code, empty.body.error], [400, "title_empty", "Judul tidak boleh kosong."]);
  const long = await patch(root, { body: edit({ description: "d".repeat(1201) }) });
  assert.deepEqual([long.status, long.body.code, long.body.error], [400, "description_too_long", "Deskripsi paling banyak 1.200 karakter."]);
  assert.equal(await readFile(path.join(root, JOB_ID, "job.json"), "utf8"), before);
});

test("a saved edit lands in job.json beside the engine's text and survives a reload", async (t) => {
  const root = await jobsRoot(t);
  const answer = await patch(root);
  assert.equal(answer.status, 200);
  assert.equal(answer.headers.get("cache-control"), "no-store");
  assert.equal(answer.body.clip.index, 2);
  assert.equal(answer.body.clip.title, "Judul baru dari pemilik");
  assert.equal(answer.body.clip.description, "Deskripsi baru.\n\n#podcast #lucu");
  assert.deepEqual(answer.body.clip.hashtags, ["#podcast", "#lucu"]);
  assert.equal(answer.body.clip.textEdit, undefined);

  const stored = await readJob(root);
  const clip = stored.clips[1];
  assert.equal(clip.title, "Judul mesin 2", "the engine's packaging stays");
  assert.deepEqual(Object.keys(clip.textEdit).sort(), ["description", "editedAt", "title"]);
  assert.equal(clip.textEdit.title, "Judul baru dari pemilik");
  assert.ok(!Number.isNaN(Date.parse(clip.textEdit.editedAt)));
  assert.equal(stored.updatedAt, job().updatedAt, "editing text is not a run of the job");
  assert.deepEqual(stored.clips[0], packagedClip(1));

  const reloaded = await withEnv({ ...AUTH, JOBS_ROOT: root }, async () => read(await JOB_GET(request(`/api/jobs/${JOB_ID}`, { method: "GET" }), params())));
  assert.equal(reloaded.body.job.clips[1].title, "Judul baru dari pemilik");
  assert.equal(reloaded.body.job.clips[0].title, "Judul mesin 1");

  const again = await patch(root, { body: edit({ title: "Judul kedua", description: "" }) });
  assert.equal(again.status, 200);
  assert.equal(again.body.clip.description, "");
  assert.deepEqual(again.body.clip.hashtags, []);
  assert.equal((await readJob(root)).clips[1].textEdit.title, "Judul kedua");
});

test("only a finished job's own clips can be edited", async (t) => {
  const root = await jobsRoot(t, job({ status: "processing" }));
  const running = await patch(root);
  assert.deepEqual([running.status, running.body.code], [409, "not_ready"]);
  assert.equal((await readJob(root)).clips[1].textEdit, undefined);

  const done = await jobsRoot(t);
  const missingClip = await patch(done, { body: edit({ index: 7 }) });
  assert.deepEqual([missingClip.status, missingClip.body.code], [404, "clip_not_found"]);
  const missingJob = await patch(done, { id: crypto.randomUUID() });
  assert.deepEqual([missingJob.status, missingJob.body.code], [404, "not_found"]);
});

// --- POST /api/jobs/:id/clip-text/rewrite ----------------------------------------------------------------

function recorder(answer = { exitCode: 0, json: { state: "done", suggestion: { title: "Judul AI", description: "Deskripsi AI. Kamu pernah?\n\n#fyp" }, error: null } }) {
  const calls = [];
  const runCli = async (module, op, payload, options) => {
    calls.push({ module, op, payload, options });
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? answer(payload, options) : answer;
  };
  return { calls, runCli };
}

function rewriteRoute(root, { cli = recorder(), loadLlmEnv, env = {}, limiter, running } = {}) {
  return createRewriteRoute({
    env: { ...AUTH, JOBS_ROOT: root, ...env }, jobsRoot: root, runCli: cli.runCli,
    loadLlmEnv: loadLlmEnv ?? (async () => ({ env: { ...LLM_ENV }, source: "ui", problem: null })),
    limiter: limiter ?? new TokenBucketLimiter({ capacity: 30, refillPerSecond: 30 / 3600 }),
    running: running ?? { count: 0 },
  });
}

const rewriteBody = (index = 2) => JSON.stringify({ index });
const ask = async (route, body = rewriteBody(), id = JOB_ID) => read(await route.POST(request(REWRITE_URL, { method: "POST", body }), params(id)));

test("Tulis ulang asks the post_text CLI with the saved LLM settings, a 25 s kill and nothing else", async (t) => {
  const root = await jobsRoot(t);
  let loadedFor = null;
  const cli = recorder();
  const route = rewriteRoute(root, {
    cli, env: { POTONGIN_LLM_EDITOR_MODELS: "openrouter/fast:free" },
    loadLlmEnv: async (base) => { loadedFor = base; return { env: { ...LLM_ENV }, source: "ui", problem: null }; },
  });
  const answer = await ask(route);
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, { suggestion: { title: "Judul AI", description: "Deskripsi AI. Kamu pernah?\n\n#fyp" } });
  assert.equal(loadedFor.JOBS_ROOT, root, "the settings are read with the process environment");
  assert.equal(cli.calls.length, 1);
  const [call] = cli.calls;
  assert.equal(call.module, REWRITE_MODULE);
  assert.equal(REWRITE_MODULE, "ai_clipper.post_text");
  assert.ok(PYTHON_CLI_MODULES.includes(REWRITE_MODULE));
  assert.equal(call.op, "rewrite");
  assert.deepEqual(call.payload, { jobId: JOB_ID, index: 2 });
  assert.equal(call.options.withLlmEnv, true);
  assert.equal(call.options.timeoutMs, REWRITE_KILL_AFTER_MS);
  assert.equal(REWRITE_KILL_AFTER_MS, 25_000);
  assert.equal(call.options.killGraceMs, 0);
  const loaded = await call.options.loadLlmEnvImpl();
  assert.equal(loaded.env.OPENROUTER_API_KEY, LLM_ENV.OPENROUTER_API_KEY);
  assert.equal(loaded.env.POTONGIN_LLM_EDITOR_MODELS, "openrouter/fast:free");
  assert.equal((await readJob(root)).clips[1].textEdit, undefined, "a suggestion is not saved");
});

test("the rewrite body is exactly {index}; no field can name a provider, a model or a URL", async (t) => {
  const root = await jobsRoot(t);
  const cli = recorder();
  const route = rewriteRoute(root, { cli });
  for (const body of ['{"index":2,"model":"paid/x"}', '{"index":2,"provider":"openai"}', '{"index":"2"}', '{"index":0}', "[2]", "{", ""]) {
    const answer = await ask(route, body);
    assert.equal(answer.status, 400, body);
  }
  assert.equal(cli.calls.length, 0);
});

test("Tulis ulang refuses an unfinished job, a missing clip and a clip without transcript before asking", async (t) => {
  const cli = recorder();
  const running = rewriteRoute(await jobsRoot(t, job({ status: "processing" })), { cli });
  assert.deepEqual(await ask(running).then((answer) => [answer.status, answer.body.code]), [409, "not_ready"]);
  const root = await jobsRoot(t, job({ clips: [packagedClip(1), packagedClip(2, { text: "  " })] }));
  const route = rewriteRoute(root, { cli });
  assert.deepEqual(await ask(route, rewriteBody(9)).then((answer) => [answer.status, answer.body.code]), [404, "clip_not_found"]);
  const silent = await ask(route, rewriteBody(2));
  assert.deepEqual([silent.status, silent.body.code], [409, "no_transcript"]);
  assert.match(silent.body.error, /transkrip/);
  assert.deepEqual(await ask(route, rewriteBody(1), crypto.randomUUID()).then((answer) => answer.status), 404);
  assert.equal(cli.calls.length, 0);
});

test("with AI off, no provider or unreadable settings, Tulis ulang says so and starts nothing", async (t) => {
  const root = await jobsRoot(t);
  const cases = [
    [{ POTONGIN_LLM: "off" }, async () => ({ env: { ...LLM_ENV }, problem: null }), "llm_disabled"],
    [{}, async () => ({ env: { POTONGIN_LLM: "off" }, source: "ui", problem: null }), "llm_disabled"],
    [{}, async () => ({ env: { POTONGIN_LLM: "on" }, source: "ui", problem: null }), "llm_disabled"],
    [{}, async () => ({ env: { POTONGIN_LLM: "off" }, source: "ui", problem: "unreadable" }), "llm_settings"],
    [{}, async () => { throw new Error("boom"); }, "llm_settings"],
  ];
  for (const [env, loadLlmEnv, code] of cases) {
    const cli = recorder();
    const answer = await ask(rewriteRoute(root, { cli, env, loadLlmEnv }));
    assert.deepEqual([answer.status, answer.body.code], [409, code]);
    assert.equal(cli.calls.length, 0);
  }
});

test("LLM failures keep the LLM's code for the help page; a broken child is a 503", async (t) => {
  const root = await jobsRoot(t);
  const failed = (code, llmCode = null) => ({ exitCode: 0, json: { state: "failed", suggestion: null, error: { code, llmCode } } });
  const cases = [
    [failed("llm_unavailable", "quota_exhausted"), 502, "llm_unavailable", "quota_exhausted"],
    [failed("llm_unavailable", "Bad Code!"), 502, "llm_unavailable", null],
    [failed("invalid_output"), 502, "invalid_output", null],
    [failed("timeout"), 504, "timeout", null],
    [failed("llm_disabled"), 409, "llm_disabled", null],
    [failed("no_transcript"), 409, "no_transcript", null],
    [failed("surprise"), 502, "llm_unavailable", null],
    [new PythonCliError("timeout"), 504, "timeout", null],
    [new PythonCliError("spawn_failed"), 503, "backend_unavailable", null],
    [{ exitCode: 4, json: { error: { code: "not_found" } } }, 404, "clip_not_found", null],
    [{ exitCode: 0, json: { state: "done", suggestion: { title: " ", description: "x" }, error: null } }, 502, "invalid_output", null],
    [{ exitCode: 0, json: { state: "done", suggestion: { title: "a".repeat(101), description: "x" }, error: null } }, 502, "invalid_output", null],
  ];
  for (const [result, status, code, llmCode] of cases) {
    const answer = await ask(rewriteRoute(root, { cli: recorder(result) }));
    assert.equal(answer.status, status, `${code} ${JSON.stringify(result)}`);
    assert.equal(answer.body.code, code);
    assert.equal(answer.body.llmCode ?? null, llmCode);
    assert.equal(typeof answer.body.error, "string");
    assert.ok(answer.body.error.length > 0 && !answer.body.error.includes(root));
  }
});

test("at most 30 rewrites per job per hour, and at most 3 at once", async (t) => {
  const root = await jobsRoot(t);
  let clock = 0;
  const limiter = new TokenBucketLimiter({ capacity: 30, refillPerSecond: 30 / 3600, now: () => clock });
  const route = rewriteRoute(root, { limiter });
  for (let index = 0; index < 30; index += 1) assert.equal((await ask(route)).status, 200, `request ${index + 1}`);
  const limited = await ask(route);
  assert.deepEqual([limited.status, limited.body.code], [429, "rate_limited"]);
  assert.match(limited.body.error, /30 per jam/);
  assert.ok(Number(limited.headers.get("retry-after")) >= 60);

  const done = { exitCode: 0, json: { state: "done", suggestion: { title: "T", description: "D" }, error: null } };
  const pending = [];
  let hold = true;
  const busy = rewriteRoute(root, { cli: recorder(() => (hold ? new Promise((resolve) => pending.push(resolve)) : done)) });
  const started = [ask(busy), ask(busy), ask(busy)];
  while (pending.length < 3) await new Promise((resolve) => setImmediate(resolve));
  const fourth = await ask(busy);
  assert.deepEqual([fourth.status, fourth.body.code], [429, "rate_limited"]);
  assert.equal(MAX_RUNNING_REWRITES, 3);
  hold = false;
  for (const resolve of pending) resolve(done);
  assert.deepEqual((await Promise.all(started)).map((answer) => answer.status), [200, 200, 200]);
  assert.equal((await ask(busy)).status, 200, "a finished rewrite frees its slot");
});

test("the rewrite route needs a session and a same-origin request", async (t) => {
  const root = await jobsRoot(t);
  const call = (options) => withEnv({ ...AUTH, JOBS_ROOT: root }, async () => read(await REWRITE(request(REWRITE_URL, { method: "POST", body: rewriteBody(), ...options }), params())));
  assert.equal((await call({ session: false })).status, 401);
  assert.equal((await call({ origin: "http://evil.example" })).status, 403);
  assert.equal((await call({ site: "cross-site" })).status, 403);
});

test("only the rewrite child holds the saved LLM keys; no dashboard secret reaches it", async (t) => {
  const root = await jobsRoot(t);
  const settingsDir = await mkdtemp(path.join(os.tmpdir(), "potongin-clip-text-settings-"));
  t.after(() => rm(settingsDir, { recursive: true, force: true }));
  const fake = await fakePython(t, { "ai_clipper.post_text rewrite": { exit: 0, json: { state: "done", suggestion: { title: "Judul AI", description: "D" }, error: null } } });
  const base = {
    ...AUTH, PATH: process.env.PATH, HOME: os.homedir(), JOBS_ROOT: root, POTONGIN_SETTINGS_DIR: settingsDir,
    POTONGIN_SETTINGS_SECRET: "planted-settings-secret-for-tests", OPENROUTER_API_KEY: "planted-env-key-not-used",
  };
  await saveLlmSettings({ enabled: true, freeOnly: true, providers: [
    { provider: "openrouter", enabled: true, apiKey: { action: "replace", value: "planted-saved-openrouter-key" } },
  ] }, { env: base });
  const route = createRewriteRoute({
    env: base, jobsRoot: root, running: { count: 0 },
    runCli: (module, op, payload, options) => runPythonCli(module, op, payload, { ...options, env: base, pythonBin: fake.bin }),
  });
  const answer = await ask(route);
  assert.equal(answer.status, 200);
  const [record] = await fake.records();
  assert.equal(record.module, "ai_clipper.post_text");
  assert.deepEqual(record.envelope, { op: "rewrite", jobId: JOB_ID, index: 2 });
  assert.equal(record.environ.POTONGIN_LLM_PROVIDERS, "openrouter");
  assert.equal(record.environ.POTONGIN_LLM_OPENROUTER_API_KEY, "planted-saved-openrouter-key");
  assert.equal(record.environ.POTONGIN_LLM_FREE_ONLY, "1", "the free-only switch reaches the chain");
  assert.ok(!Object.values(record.environ).includes("planted-env-key-not-used"));
  for (const name of ["APP_PASSWORD", "APP_SESSION_SECRET", "APP_USERNAME", "POTONGIN_SETTINGS_DIR", "POTONGIN_SETTINGS_SECRET"]) {
    assert.equal(record.environ[name], undefined, name);
  }
});
