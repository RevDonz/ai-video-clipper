// Editor V3 routes for clips, the edit document and the words artifact (plan §4.2, §9.1; T2.2):
// GET/POST /api/jobs/:id/clips, GET/PUT /api/jobs/:id/clips/:clipId/edit and
// GET /api/jobs/:id/clips/:clipId/words. Unit cases use a recording CLI runner; the integration
// cases run the real `python -m ai_clipper.edit_v2.api` through web/lib/python-cli.mjs.
// Every path is resolved from import.meta.url (plan §8, D11).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as clipsRouteModule from "../app/api/jobs/[id]/clips/route.js";
import * as editRouteModule from "../app/api/jobs/[id]/clips/[clipId]/edit/route.js";
import * as wordsRouteModule from "../app/api/jobs/[id]/clips/[clipId]/words/route.js";
import { createSessionToken, isAuthorized } from "../lib/auth.mjs";
import {
  EDIT_API_MODULE,
  MAX_DOC_BODY_BYTES,
  PREPARE_RATE,
  createClipsRoute,
  createEditRoute,
  createWordsRoute,
  isEditorEnabled,
  sanitizeClip,
} from "../lib/clip-edit.mjs";
import { PythonCliError } from "../lib/python-cli.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const AUTH = Object.freeze({ APP_USERNAME: "admin", APP_PASSWORD: "pw-secret-value", APP_SESSION_SECRET: "session-secret-".padEnd(48, "z") });
const JOB_ID = "8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55";
const CLIP_ID = "clip_62654c2c2fa04f125391464a";
const ETAG = "a".repeat(64);
const KEY = "323e4567-e89b-42d3-a456-426614174000";
const SECRETS = Object.freeze({
  APP_PASSWORD: AUTH.APP_PASSWORD, APP_SESSION_SECRET: AUTH.APP_SESSION_SECRET,
  POTONGIN_SETTINGS_SECRET: "settings-secret-value", OPENROUTER_API_KEY: "sk-or-secret-value",
  POTONGIN_LLM_CUSTOM_API_KEY: "custom-secret-value",
});

function python() {
  const configured = process.env.PYTHON_BIN;
  if (configured) return configured.includes(path.sep) ? path.resolve(configured) : configured;
  return path.join(REPO, ".venv", "bin", "python");
}

function authorize(request) {
  return isAuthorized(request, AUTH) ? null
    : Response.json({ error: "Sesi login tidak valid" }, { status: 401, headers: { "Cache-Control": "no-store" } });
}

function env(extra = {}) {
  return { ...AUTH, PATH: process.env.PATH, JOBS_ROOT: "/data/jobs", POTONGIN_EDITOR_V3: "on", ...extra };
}

function request(url, { method = "GET", body, headers = {}, origin = "http://local", cookie = true,
  contentType = "application/json", fetchSite } = {}) {
  const all = { Host: "local", ...headers };
  if (origin) all.Origin = origin;
  if (fetchSite) all["Sec-Fetch-Site"] = fetchSite;
  if (cookie) all.Cookie = `potongin_session=${createSessionToken(AUTH)}`;
  if (body !== undefined && contentType) all["Content-Type"] = contentType;
  return new Request(`http://local${url}`, { method, headers: all, body, duplex: "half" });
}

function context(params) {
  return { params: Promise.resolve(params) };
}

async function read(response) {
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body, text, headers: response.headers };
}

// A recording runner: `results` maps op → {exitCode, json} | Error | function(payload).
function recorder(results = {}) {
  const calls = [];
  const runCli = async (module, op, payload, options) => {
    calls.push({ module, op, payload, options });
    const result = results[op];
    if (result instanceof Error) throw result;
    if (typeof result === "function") return result(payload);
    if (!result) throw new Error(`unexpected op ${op}`);
    return result;
  };
  return { calls, runCli };
}

function editResult(overrides = {}) {
  return {
    exitCode: 0,
    json: {
      doc: { schema: "clip-edit-v2", revision: 0, clip_id: CLIP_ID }, etag: ETAG, isSeed: true,
      seed: { schema: "clip-edit-v2", revision: 0 }, seedEtag: ETAG, engine: "edit-v2/1", notices: [],
      words: { sha256: "b".repeat(64), url: `/api/jobs/${JOB_ID}/clips/${CLIP_ID}/words` },
      readOnly: false, readOnlyReason: null, ...overrides,
    },
  };
}

const EDIT_URL = `/api/jobs/${JOB_ID}/clips/${CLIP_ID}/edit`;
const CLIPS_URL = `/api/jobs/${JOB_ID}/clips`;
const WORDS_URL = `/api/jobs/${JOB_ID}/clips/${CLIP_ID}/words`;
const IDS = { id: JOB_ID, clipId: CLIP_ID };

// --- the flag, auth, CSRF and ids -------------------------------------------------------------

test("the editor flag is off unless POTONGIN_EDITOR_V3 is exactly on", () => {
  assert.equal(isEditorEnabled({}), false);
  assert.equal(isEditorEnabled({ POTONGIN_EDITOR_V3: "off" }), false);
  assert.equal(isEditorEnabled({ POTONGIN_EDITOR_V3: "ON" }), false);
  assert.equal(isEditorEnabled({ POTONGIN_EDITOR_V3: "on" }), true);
});

test("route modules export their handlers and run on node", () => {
  assert.equal(typeof clipsRouteModule.GET, "function");
  assert.equal(typeof clipsRouteModule.POST, "function");
  assert.equal(typeof editRouteModule.GET, "function");
  assert.equal(typeof editRouteModule.PUT, "function");
  assert.equal(typeof wordsRouteModule.GET, "function");
  for (const module of [clipsRouteModule, editRouteModule, wordsRouteModule]) {
    assert.equal(module.runtime, "nodejs");
    assert.equal(module.dynamic, "force-dynamic");
  }
});

test("every route needs a session, then the flag; nothing is spawned before", async () => {
  const { calls, runCli } = recorder();
  const deps = { authorize, env: env(), runCli };
  const cases = [
    () => createClipsRoute(deps).GET(request(CLIPS_URL, { cookie: false }), context({ id: JOB_ID })),
    () => createClipsRoute(deps).POST(request(CLIPS_URL, { method: "POST", body: "{}", cookie: false }), context({ id: JOB_ID })),
    () => createEditRoute(deps).GET(request(EDIT_URL, { cookie: false }), context(IDS)),
    () => createEditRoute(deps).PUT(request(EDIT_URL, { method: "PUT", body: "{}", cookie: false }), context(IDS)),
    () => createWordsRoute(deps).GET(request(WORDS_URL, { cookie: false }), context(IDS)),
  ];
  for (const call of cases) assert.equal((await read(await call())).status, 401);
  const off = { authorize, env: env({ POTONGIN_EDITOR_V3: "off" }), runCli };
  for (const response of [
    await createClipsRoute(off).GET(request(CLIPS_URL), context({ id: JOB_ID })),
    await createEditRoute(off).GET(request(EDIT_URL), context(IDS)),
    await createEditRoute(off).PUT(request(EDIT_URL, { method: "PUT", body: "{}" }), context(IDS)),
    await createWordsRoute(off).GET(request(WORDS_URL), context(IDS)),
  ]) {
    const result = await read(response);
    assert.equal(result.status, 404);
    assert.equal(result.body.code, "editor_disabled");
    assert.equal(result.headers.get("x-content-type-options"), "nosniff");
  }
  assert.equal(calls.length, 0);
});

test("mutations are same-origin only (403) and ids are checked before any spawn (400)", async () => {
  const { calls, runCli } = recorder();
  const deps = { authorize, env: env(), runCli };
  for (const options of [{ origin: "https://evil.example" }, { origin: null }, { fetchSite: "cross-site" }]) {
    const put = await read(await createEditRoute(deps).PUT(request(EDIT_URL, {
      method: "PUT", body: "{}", headers: { "If-Match": `"${ETAG}"`, "Idempotency-Key": KEY }, ...options,
    }), context(IDS)));
    assert.equal(put.status, 403);
    assert.equal(put.body.code, "csrf_rejected");
    const prepare = await read(await createClipsRoute(deps).POST(request(CLIPS_URL, { method: "POST", body: "{}", ...options }), context({ id: JOB_ID })));
    assert.equal(prepare.status, 403);
  }
  for (const [id, clipId] of [["../etc", CLIP_ID], [JOB_ID.toUpperCase(), CLIP_ID], [JOB_ID, "clip_x"],
    [JOB_ID, `${CLIP_ID}/..`], [JOB_ID, CLIP_ID.toUpperCase()]]) {
    const get = await read(await createEditRoute(deps).GET(request(EDIT_URL), context({ id, clipId })));
    assert.equal(get.status, 400, `${id} ${clipId}`);
    assert.equal(get.body.code, "invalid_request");
    const words = await read(await createWordsRoute(deps).GET(request(WORDS_URL), context({ id, clipId })));
    assert.equal(words.status, 400);
  }
  assert.equal((await read(await createClipsRoute(deps).GET(request(CLIPS_URL), context({ id: "x" })))).status, 400);
  assert.equal(calls.length, 0);
});

// --- GET /clips and POST /clips (prepare) ---------------------------------------------------------

test("GET clips passes the listing through a whitelist and adds the latest export", async () => {
  const entry = {
    clipId: CLIP_ID, index: 3, title: "Judul", hookText: "Hook", description: "Desc", hashtags: ["#a"],
    durationMs: 72000, engine: "edit-v2/1", edit: { state: "edited", revision: 2, etag: ETAG, updatedAtMs: 5 },
    latestRender: null, openable: true, reason: null, sourcePath: "/data/jobs/secret.mp4",
  };
  const pending = { ...entry, clipId: null, index: 1, engine: null, edit: null, openable: false, reason: "needs_prepare" };
  const { calls, runCli } = recorder({ clips: { exitCode: 0, json: { clips: [entry, pending] } } });
  const latest = new Map([[CLIP_ID, { renderId: "r1", state: "completed", url: "/u.mp4", srtUrl: "/u.srt", revision: 2 }]]);
  const route = createClipsRoute({ authorize, env: env(), runCli, latestRenders: async (jobId) => {
    assert.equal(jobId, JOB_ID);
    return latest;
  } });
  const result = await read(await route.GET(request(CLIPS_URL), context({ id: JOB_ID })));
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.deepEqual(calls.map(({ module, op, payload }) => [module, op, payload]),
    [[EDIT_API_MODULE, "clips", { jobId: JOB_ID }]]);
  const { sourcePath: _dropped, ...contract } = entry;
  assert.deepEqual(result.body.clips[0], { ...contract, latestRender: latest.get(CLIP_ID) });
  assert.equal("sourcePath" in result.body.clips[0], false);
  assert.equal(result.body.clips[1].latestRender, null);
  assert.equal(result.body.clips[1].reason, "needs_prepare");
  assert.ok(!result.text.includes("/data/jobs"));
});

test("sanitizeClip keeps only the contract fields with their types", () => {
  const clean = sanitizeClip({ clipId: CLIP_ID, index: 1, title: 7, hookText: null, description: "d",
    hashtags: ["#a", 3], durationMs: -1, engine: "legacy", edit: { state: "seed", revision: 0, etag: ETAG, updatedAtMs: 1, x: 1 },
    openable: "yes", reason: "not_a_reason", extra: "/path" });
  assert.deepEqual(clean, { clipId: CLIP_ID, index: 1, title: null, hookText: null, description: "d",
    hashtags: ["#a"], durationMs: null, engine: "legacy", edit: { state: "seed", revision: 0, etag: ETAG, updatedAtMs: 1 },
    latestRender: null, openable: false, reason: null });
});

test("GET clips maps backend failures to fixed codes", async () => {
  for (const [result, status, code] of [
    [{ exitCode: 4, json: { error: { code: "not_found" } } }, 404, "not_found"],
    [new PythonCliError("spawn_failed"), 503, "backend_unavailable"],
    [new PythonCliError("backend_failed"), 503, "backend_unavailable"],
  ]) {
    const { runCli } = recorder({ clips: result });
    const response = await read(await createClipsRoute({ authorize, env: env(), runCli, latestRenders: async () => new Map() })
      .GET(request(CLIPS_URL), context({ id: JOB_ID })));
    assert.equal(response.status, status);
    assert.equal(response.body.code, code);
    assert.ok(!response.text.includes("spawn_failed"));
  }
});

test("POST clips prepares the job (202) with an empty or {} body only", async () => {
  const prepared = { state: "done", clips: [{ clipId: CLIP_ID, index: 1, openable: true, reason: null }] };
  const { calls, runCli } = recorder({ prepare_job: { exitCode: 0, json: prepared } });
  const route = createClipsRoute({ authorize, env: env(), runCli });
  for (const body of ["{}", " { } ", undefined]) {
    const result = await read(await route.POST(request(CLIPS_URL, { method: "POST", body }), context({ id: JOB_ID })));
    assert.equal(result.status, 202, String(body));
    assert.deepEqual(result.body, prepared);
  }
  assert.ok(calls.every((call) => call.op === "prepare_job" && call.options.timeoutMs >= 60_000));
  for (const body of ['{"layout":"camera"}', "[]", "nope"]) {
    const result = await read(await route.POST(request(CLIPS_URL, { method: "POST", body }), context({ id: JOB_ID })));
    assert.equal(result.status, 400, body);
  }
  const big = await read(await route.POST(request(CLIPS_URL, { method: "POST", body: " ".repeat(2048) }), context({ id: JOB_ID })));
  assert.equal(big.status, 413);
});

test("job prepares share one run per job, run one at a time and are rate limited (W2 verifier)", async () => {
  // The camera plans of a face-track job take ~50 s: two clicks share one run, two jobs do not
  // prepare at the same time (the preview lane keeps its CPU), and a job is prepared at most
  // PREPARE_RATE times in a burst.
  const OTHER_JOB = "5b7c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d";
  const prepared = { state: "done", clips: [] };
  const log = [];
  let release = null;
  const runCli = async (_module, op, payload) => {
    log.push(["start", payload.jobId]);
    await new Promise((resolve) => { release = resolve; setTimeout(resolve, 150); });
    log.push(["end", payload.jobId]);
    return { exitCode: 0, json: prepared };
  };
  const route = createClipsRoute({ authorize, env: env(), runCli });
  const post = (id) => route.POST(request(`/api/jobs/${id}/clips`, { method: "POST", body: "{}" }), context({ id }));
  const [a, b, c] = await Promise.all([post(JOB_ID), post(JOB_ID), post(OTHER_JOB)]);
  assert.deepEqual([a.status, b.status, c.status], [202, 202, 202]);
  assert.deepEqual(log, [["start", JOB_ID], ["end", JOB_ID], ["start", OTHER_JOB], ["end", OTHER_JOB]]);
  const statuses = [];
  for (let i = 0; i < PREPARE_RATE.capacity + 1; i += 1) statuses.push((await post(OTHER_JOB)).status);
  // the burst above already used one token of OTHER_JOB
  assert.deepEqual(statuses, [...Array(PREPARE_RATE.capacity - 1).fill(202), 429, 429]);
  const limited = await read(await post(OTHER_JOB));
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, "rate_limited");
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  assert.equal(typeof release, "function");
});

// --- GET/PUT edit -----------------------------------------------------------------------------------

test("GET edit returns the document with its ETag and marks the seed", async () => {
  const { calls, runCli } = recorder({ get: editResult(), seed: editResult() });
  const route = createEditRoute({ authorize, env: env(), runCli });
  const seed = await read(await route.GET(request(EDIT_URL), context(IDS)));
  assert.equal(seed.status, 200);
  assert.equal(seed.headers.get("etag"), `"${ETAG}"`);
  assert.equal(seed.headers.get("x-edit-seed"), "1");
  assert.equal(seed.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Object.keys(seed.body).sort(), ["doc", "engine", "etag", "notices", "readOnly", "readOnlyReason",
    "seed", "seedEtag", "words"].sort());
  assert.equal(seed.body.seed, true);
  assert.equal(seed.body.words.url, `${WORDS_URL}?sha=${"b".repeat(64)}`);
  const explicit = await read(await route.GET(request(`${EDIT_URL}?seed=1`), context(IDS)));
  assert.equal(explicit.status, 200);
  assert.deepEqual(calls.map((call) => call.op), ["get", "seed"]);
  assert.deepEqual(calls[1].payload, { jobId: JOB_ID, clipId: CLIP_ID });
  for (const query of ["?seed=0", "?seed=true", "?other=1", "?seed=1&seed=1"]) {
    assert.equal((await read(await route.GET(request(`${EDIT_URL}${query}`), context(IDS)))).status, 400, query);
  }
  const edited = recorder({ get: editResult({ isSeed: false, doc: { revision: 3 } }) });
  const response = await read(await createEditRoute({ authorize, env: env(), runCli: edited.runCli }).GET(request(EDIT_URL), context(IDS)));
  assert.equal(response.headers.get("x-edit-seed"), null);
  assert.equal(response.body.seed, false);
});

test("GET edit maps analysis_missing and not_found", async () => {
  for (const [exitCode, status, code] of [[8, 409, "analysis_missing"], [4, 404, "not_found"]]) {
    const { runCli } = recorder({ get: { exitCode, json: { error: { code, path: null, ref: null, messageId: `edit.${code}` } } } });
    const result = await read(await createEditRoute({ authorize, env: env(), runCli }).GET(request(EDIT_URL), context(IDS)));
    assert.equal(result.status, status);
    assert.equal(result.body.code, code);
  }
});

function put(route, { body = '{"revision":1}', match = `"${ETAG}"`, key = KEY, contentType = "application/json", headers = {} } = {}) {
  const all = { ...headers };
  if (match !== null) all["If-Match"] = match;
  if (key !== null) all["Idempotency-Key"] = key;
  return route.PUT(request(EDIT_URL, { method: "PUT", body, headers: all, contentType }), context(IDS)).then(read);
}

test("PUT edit requires If-Match (428), an Idempotency-Key and a JSON body within 1 MiB", async () => {
  const { calls, runCli } = recorder({ put: { exitCode: 0, json: { doc: { revision: 1 }, etag: "c".repeat(64), warnings: [] } } });
  const route = createEditRoute({ authorize, env: env(), runCli });
  assert.equal((await put(route, { match: null })).status, 428);
  assert.equal((await put(route, { match: null })).body.code, "precondition_required");
  for (const match of [`W/"${ETAG}"`, '"abc"', "*", `"${ETAG.toUpperCase()}"`]) {
    assert.equal((await put(route, { match })).status, 400, match);
  }
  for (const key of [null, "not-a-uuid", KEY.toUpperCase()]) assert.equal((await put(route, { key })).status, 400, String(key));
  assert.equal((await put(route, { contentType: "text/plain" })).status, 400);
  assert.equal((await put(route, { body: "" })).status, 400);
  const tooBig = await put(route, { body: " ".repeat(MAX_DOC_BODY_BYTES + 1) });
  assert.equal(tooBig.status, 413);
  assert.equal(tooBig.body.code, "payload_too_large");
  const declared = await put(route, { headers: { "Content-Length": String(MAX_DOC_BODY_BYTES + 10) } });
  assert.equal(declared.status, 413);
  assert.equal(calls.length, 0);
  const ok = await put(route, { match: ETAG });  // a bare etag is accepted too
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("etag"), `"${"c".repeat(64)}"`);
  assert.deepEqual(ok.body, { doc: { revision: 1 }, etag: "c".repeat(64), warnings: [] });
  const { payload } = calls[0];
  assert.deepEqual(Object.keys(payload).sort(), ["clipId", "docRaw", "expectedEtag", "idempotencyKey", "jobId"]);
  assert.equal(Buffer.from(payload.docRaw, "base64").toString("utf8"), '{"revision":1}');
  assert.equal(payload.expectedEtag, ETAG);
  assert.equal(payload.idempotencyKey, KEY);
});

test("PUT edit maps every backend outcome to its status", async () => {
  const current = { revision: 4 };
  const cases = [
    [{ exitCode: 5, json: { error: { code: "revision_conflict" }, current, etag: "d".repeat(64) } }, 409, "revision_conflict"],
    [{ exitCode: 9, json: { error: { code: "idempotency_conflict" } } }, 409, "idempotency_conflict"],
    [{ exitCode: 3, json: { error: { code: "float_not_allowed", path: "/main/cut_fade_ms" }, errors: [{ code: "float_not_allowed", path: "/main/cut_fade_ms" }] } }, 422, "float_not_allowed"],
    [{ exitCode: 6, json: { error: { code: "outside_window" }, errors: [{ code: "outside_window", path: "/main/segments/0" }, { code: "outside_window", path: "/main/segments/1" }] } }, 422, "outside_window"],
    [{ exitCode: 7, json: { error: { code: "schema_too_new" } } }, 426, "schema_too_new"],
    [{ exitCode: 4, json: { error: { code: "not_found" } } }, 404, "not_found"],
    [{ exitCode: 8, json: { error: { code: "analysis_missing" } } }, 409, "analysis_missing"],
    [new PythonCliError("timeout"), 503, "backend_unavailable"],
  ];
  for (const [result, status, code] of cases) {
    const { runCli } = recorder({ put: result });
    const response = await put(createEditRoute({ authorize, env: env(), runCli }));
    assert.equal(response.status, status, code);
    assert.equal(response.body.code, code);
    assert.equal(typeof response.body.error, "string");
    if (status === 422) assert.deepEqual(response.body.errors, result.json.errors);
    if (code === "revision_conflict") {
      assert.deepEqual(response.body.current, current);
      assert.equal(response.body.etag, "d".repeat(64));
      assert.equal(response.headers.get("etag"), `"${"d".repeat(64)}"`);
    }
  }
});

// --- GET words ------------------------------------------------------------------------------------

async function wordsJob() {
  const root = await mkdtemp(path.join(os.tmpdir(), "clip-words-"));
  const clip = path.join(root, JOB_ID, "analysis", "clips", CLIP_ID);
  await import("node:fs/promises").then(({ mkdir }) => mkdir(clip, { recursive: true }));
  const raw = Buffer.from('{"schema":"potongin.words/1","words":[]}');
  const sha = createHash("sha256").update(raw).digest("hex");
  await writeFile(path.join(clip, `words.${sha.slice(0, 16)}.json`), raw);
  return { root, clip, raw, sha };
}

test("GET words serves the verified artifact: immutable by sha, revalidated without", async (t) => {
  const fx = await wordsJob();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  const { calls, runCli } = recorder({ get: editResult({ words: { sha256: fx.sha, url: "/x" } }) });
  const route = createWordsRoute({ authorize, env: env({ JOBS_ROOT: fx.root }), runCli });
  const pinned = await route.GET(request(`${WORDS_URL}?sha=${fx.sha}`), context(IDS));
  assert.equal(pinned.status, 200);
  assert.deepEqual(Buffer.from(await pinned.arrayBuffer()), fx.raw);
  assert.equal(pinned.headers.get("etag"), `"${fx.sha}"`);
  assert.equal(pinned.headers.get("cache-control"), "private, max-age=31536000, immutable");
  assert.equal(pinned.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(pinned.headers.get("x-content-type-options"), "nosniff");
  assert.equal(calls.length, 0);  // a pinned sha needs no Python
  const current = await route.GET(request(WORDS_URL), context(IDS));
  assert.equal(current.status, 200);
  assert.equal(current.headers.get("cache-control"), "private, no-cache");
  assert.equal(current.headers.get("etag"), `"${fx.sha}"`);
  assert.equal(calls.length, 1);
  const revalidated = await route.GET(request(WORDS_URL, { headers: { "If-None-Match": `"${fx.sha}"` } }), context(IDS));
  assert.equal(revalidated.status, 304);
  const missing = await read(await route.GET(request(`${WORDS_URL}?sha=${"e".repeat(64)}`), context(IDS)));
  assert.equal(missing.status, 404);
  for (const query of ["?sha=abc", `?sha=${fx.sha.toUpperCase()}`, `?sha=${fx.sha}&x=1`]) {
    assert.equal((await route.GET(request(`${WORDS_URL}${query}`), context(IDS))).status, 400, query);
  }
});

test("GET words refuses a tampered or symlinked artifact", async (t) => {
  const fx = await wordsJob();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  const route = createWordsRoute({ authorize, env: env({ JOBS_ROOT: fx.root }), runCli: recorder().runCli });
  const file = path.join(fx.clip, `words.${fx.sha.slice(0, 16)}.json`);
  await writeFile(file, '{"tampered":true}');
  assert.equal((await route.GET(request(`${WORDS_URL}?sha=${fx.sha}`), context(IDS))).status, 404);
  await unlink(file);
  const outside = path.join(fx.root, "outside.json");
  await writeFile(outside, fx.raw);
  await symlink(outside, file);
  assert.equal((await route.GET(request(`${WORDS_URL}?sha=${fx.sha}`), context(IDS))).status, 404);
});

// --- the real api CLI through web/lib/python-cli.mjs (integration) --------------------------------

const BUILD_JOBS = String.raw`
import copy, hashlib, json, sys
from pathlib import Path
repo, root = Path(sys.argv[1]), Path(sys.argv[2])
sys.path[:0] = [str(repo / "src"), str(repo / "tests")]
from support import edit_v2_fixtures as fixtures
from test_edit_v2_api import make_job
contexts = {cid: fixtures.load_context(cid) for cid in fixtures.CONTEXT_IDS}
jobs = {}
for name, options in {
    "prepared": {}, "unprepared": {"prepared": False}, "no_transcript": {"prepared": False, "transcript": False},
    "no_source": {"source": False}, "no_selection": {"prepared": False, "selection": False},
    "stranded": {"prepared": False, "selection": False, "attempts": True}, "v1": {"mode": "v1", "prepared": False},
}.items():
    job_id, job = make_job(root, contexts, **options)
    jobs[name] = job_id
print(json.dumps(jobs))
`;

async function runPython(args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(python(), args, { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: os.tmpdir() } });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else reject(new Error(`python exited ${code}: ${Buffer.concat(err).toString("utf8").slice(-2000)}`));
    });
    child.stdin.end(input ?? "");
  });
}

async function realJobs() {
  const root = await mkdtemp(path.join(os.tmpdir(), "clip-edit-real-"));
  const jobs = JSON.parse(await runPython(["-c", BUILD_JOBS, REPO, root]));
  return { root, jobs };
}

function realDeps(root, extra = {}) {
  return { authorize, env: env({ JOBS_ROOT: root }), pythonBin: python(), ...extra };
}

test("every openable and reason code of the clips listing, through the real api CLI", async (t) => {
  const { root, jobs } = await realJobs();
  t.after(() => rm(root, { recursive: true, force: true }));
  const route = createClipsRoute(realDeps(root));
  const reasons = {};
  for (const [name, jobId] of Object.entries(jobs)) {
    const result = await read(await route.GET(request(`/api/jobs/${jobId}/clips`), context({ id: jobId })));
    assert.equal(result.status, 200, `${name}: ${result.text}`);
    reasons[name] = [...new Set(result.body.clips.map((clip) => `${clip.openable}:${clip.reason}`))];
    assert.ok(!result.text.includes(root));
  }
  assert.deepEqual(reasons, {
    prepared: ["true:null"], unprepared: ["false:needs_prepare"], no_transcript: ["false:transcript_missing"],
    no_source: ["false:source_missing"], no_selection: ["false:selection_unreadable"],
    stranded: ["false:analysis_incomplete"], v1: ["false:not_v3"],
  });
  const unknown = randomUUID();
  assert.equal((await route.GET(request(`/api/jobs/${unknown}/clips`), context({ id: unknown }))).status, 404);
});

test("GET, PUT, replay and conflicts of a real document; the seed headers; ?seed=1", async (t) => {
  const { root, jobs } = await realJobs();
  t.after(() => rm(root, { recursive: true, force: true }));
  const jobId = jobs.prepared;
  const listing = await read(await createClipsRoute(realDeps(root)).GET(request(`/api/jobs/${jobId}/clips`), context({ id: jobId })));
  const clipId = listing.body.clips[0].clipId;
  const ids = { id: jobId, clipId };
  const url = `/api/jobs/${jobId}/clips/${clipId}/edit`;
  const route = createEditRoute(realDeps(root));
  const seed = await read(await route.GET(request(url), context(ids)));
  assert.equal(seed.status, 200, seed.text);
  assert.equal(seed.headers.get("x-edit-seed"), "1");
  const next = structuredClone(seed.body.doc);
  next.revision = 1;
  next.parent_sha256 = seed.body.etag;
  next.audit.editor = "editor-v3/1.0.0";
  next.audit.last_command = "SetCutFade";
  next.main.cut_fade_ms = 20;
  const body = JSON.stringify(next);
  const call = (options) => route.PUT(request(url, { method: "PUT", body: options.body ?? body, headers: {
    "If-Match": `"${options.match ?? seed.body.etag}"`, "Idempotency-Key": options.key } }), context(ids)).then(read);
  const key = randomUUID();
  const saved = await call({ key });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.body.doc.revision, 1);
  const replay = await call({ key });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.etag, saved.body.etag);  // the same key replays the same result
  const other = await call({ key, body: body.replace('"cut_fade_ms":20', '"cut_fade_ms":21') });
  assert.equal(other.status, 409);
  assert.equal(other.body.code, "idempotency_conflict");
  const stale = await call({ key: randomUUID() });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "revision_conflict");
  assert.equal(stale.body.etag, saved.body.etag);
  assert.equal(stale.headers.get("etag"), `"${saved.body.etag}"`);
  const invalid = structuredClone(next);
  invalid.revision = 2;
  invalid.parent_sha256 = saved.body.etag;
  invalid.main.cut_fade_ms = 51;
  const rejected = await call({ key: randomUUID(), match: saved.body.etag, body: JSON.stringify(invalid) });
  assert.equal(rejected.status, 422, rejected.text);
  assert.ok(rejected.body.errors.some((issue) => issue.path === "/main/cut_fade_ms"));
  const float = await call({ key: randomUUID(), match: saved.body.etag, body: JSON.stringify(invalid).replace('"cut_fade_ms":51', '"cut_fade_ms":8.0') });
  assert.equal(float.status, 422);
  assert.equal(float.body.code, "float_not_allowed");
  const newer = await call({ key: randomUUID(), match: saved.body.etag, body: JSON.stringify({ ...invalid, schema_minor: 1 }) });
  assert.equal(newer.status, 426);
  const current = await read(await route.GET(request(url), context(ids)));
  assert.equal(current.headers.get("x-edit-seed"), null);
  assert.equal(current.body.etag, saved.body.etag);
  const reset = await read(await route.GET(request(`${url}?seed=1`), context(ids)));
  assert.equal(reset.body.etag, seed.body.etag);
  assert.equal(reset.headers.get("x-edit-seed"), "1");
  const words = await createWordsRoute(realDeps(root)).GET(request(current.body.words.url), context(ids));
  assert.equal(words.status, 200);
  const artifact = JSON.parse(Buffer.from(await words.arrayBuffer()).toString("utf8"));
  assert.equal(artifact.schema, "potongin.words/1");
});

// --- E11: the children of these routes carry no secret --------------------------------------------

const FAKE_PYTHON = String.raw`
import { readFileSync, writeFileSync } from "node:fs";
const envelope = JSON.parse(readFileSync(0, "utf8"));
const environ = {};
for (const entry of readFileSync("/proc/self/environ", "utf8").split("\0")) {
  if (!entry) continue;
  const at = entry.indexOf("=");
  environ[entry.slice(0, at)] = entry.slice(at + 1);
}
writeFileSync(process.env.JOBS_ROOT + "/environ-" + envelope.op + ".json", JSON.stringify(environ));
const results = {
  clips: { clips: [] },
  prepare_job: { state: "done", clips: [] },
  get: { doc: {}, etag: "a".repeat(64), isSeed: true, seed: {}, seedEtag: "a".repeat(64), engine: "edit-v2/1",
    notices: [], words: { sha256: "b".repeat(64), url: "/x" }, readOnly: false, readOnlyReason: null },
  put: { doc: {}, etag: "c".repeat(64), warnings: [] },
};
process.stdout.write(JSON.stringify(results[envelope.op]));
`;

test("QG-SEC: the api children of the clip routes see no secret in /proc/self/environ", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "clip-edit-env-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = path.join(dir, "python.mjs");
  await writeFile(fake, `#!${process.execPath}\n${FAKE_PYTHON}`);
  await chmod(fake, 0o755);
  const deps = { authorize, env: env({ JOBS_ROOT: dir, ...SECRETS }), pythonBin: fake, latestRenders: async () => new Map() };
  assert.equal((await createClipsRoute(deps).GET(request(CLIPS_URL), context({ id: JOB_ID }))).status, 200);
  assert.equal((await createClipsRoute(deps).POST(request(CLIPS_URL, { method: "POST", body: "{}" }), context({ id: JOB_ID }))).status, 202);
  assert.equal((await createEditRoute(deps).GET(request(EDIT_URL), context(IDS))).status, 200);
  assert.equal((await put(createEditRoute(deps))).status, 200);
  const files = (await readdir(dir)).filter((name) => name.startsWith("environ-")).sort();
  assert.deepEqual(files, ["environ-clips.json", "environ-get.json", "environ-prepare_job.json", "environ-put.json"]);
  for (const file of files) {
    const environ = JSON.parse(await readFile(path.join(dir, file), "utf8"));
    for (const [name, value] of Object.entries(SECRETS)) {
      assert.equal(environ[name], undefined, `${file}: ${name}`);
      assert.ok(!Object.values(environ).includes(value), `${file}: value of ${name}`);
    }
    for (const name of Object.keys(environ)) assert.doesNotMatch(name, /^(?:APP_|POTONGIN_SETTINGS_|POTONGIN_LLM)|_API_KEY$/);
    assert.equal(environ.POTONGIN_EDITOR_V3, "on");
  }
});
