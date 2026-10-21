// "Hook di video" (CONTRACTS §5.57): POST /api/jobs/:id/clips/:clipId/hook switches the clip's hook
// overlay through the document store. Unit cases use a recording CLI runner; the integration case
// runs the real `python -m ai_clipper.edit_v2.api` on a three-clip job.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as hookRouteModule from "../app/api/jobs/[id]/clips/[clipId]/hook/route.js";
import { createSessionToken, isAuthorized } from "../lib/auth.mjs";
import { createClipHookRoute, sanitizeHookResult } from "../lib/clip-hook-api.mjs";
import { createClipsRoute, createEditRoute, sanitizeClip } from "../lib/clip-edit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const AUTH = Object.freeze({ APP_USERNAME: "admin", APP_PASSWORD: "pw-hook-value", APP_SESSION_SECRET: "hook-session-".padEnd(48, "q") });
const JOB_ID = "8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55";
const CLIP_ID = "clip_62654c2c2fa04f125391464a";
const ETAG = "c".repeat(64);
const NEXT = "d".repeat(64);
const REQUEST_ID = "4a7e1c2b-9d3f-4b6a-8c5e-0f1a2b3c4d5e";
const URL_PATH = `/api/jobs/${JOB_ID}/clips/${CLIP_ID}/hook`;
const IDS = { id: JOB_ID, clipId: CLIP_ID };

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

function request(url, { method = "POST", body, headers = {}, origin = "http://local", cookie = true,
  contentType = "application/json" } = {}) {
  const all = { Host: "local", ...headers };
  if (origin) all.Origin = origin;
  if (cookie) all.Cookie = `potongin_session=${createSessionToken(AUTH)}`;
  if (body !== undefined && contentType) all["Content-Type"] = contentType;
  return new Request(`http://local${url}`, { method, headers: all, body, duplex: "half" });
}

const context = (params) => ({ params: Promise.resolve(params) });

async function read(response) {
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body, text, headers: response.headers };
}

function recorder(results = {}) {
  const calls = [];
  const runCli = async (module, op, payload, options) => {
    calls.push({ module, op, payload, options });
    const result = results[op];
    if (typeof result === "function") return result(payload);
    if (!result) throw new Error(`unexpected op ${op}`);
    return result;
  };
  return { calls, runCli };
}

const hookBody = (extra = {}) => JSON.stringify({ on: false, etag: ETAG, ...extra });
const send = (route, options = {}) => route.POST(request(URL_PATH, {
  body: options.body ?? hookBody(), headers: { "Idempotency-Key": REQUEST_ID, ...options.headers }, ...options.request,
}), context(options.ids ?? IDS)).then(read);

const SWITCHED = Object.freeze({
  exitCode: 0,
  json: { etag: NEXT, revision: 4, changed: true, hook: { on: false, available: true }, doc: { secret: 1 } },
});

test("the route module exports POST on node", () => {
  assert.equal(typeof hookRouteModule.POST, "function");
  assert.equal(hookRouteModule.runtime, "nodejs");
  assert.equal(hookRouteModule.dynamic, "force-dynamic");
});

test("the route needs a session, the editor flag and the same origin before anything is spawned", async () => {
  const { calls, runCli } = recorder();
  const deps = { authorize, env: env(), runCli };
  assert.equal((await send(createClipHookRoute(deps), { request: { cookie: false } })).status, 401);
  assert.equal((await send(createClipHookRoute({ ...deps, env: env({ POTONGIN_EDITOR_V3: "off" }) }))).status, 404);
  for (const origin of ["http://evil.example", null]) {
    const result = await send(createClipHookRoute(deps), { request: { origin } });
    assert.equal(result.status, 403);
    assert.equal(result.body.code, "csrf_rejected");
  }
  assert.equal(calls.length, 0);
});

test("the route checks the ids, the Idempotency-Key and the body exactly", async () => {
  const { calls, runCli } = recorder();
  const route = createClipHookRoute({ authorize, env: env(), runCli });
  const cases = [
    { ids: { id: JOB_ID, clipId: "clip_../x" } },
    { ids: { id: "../etc", clipId: CLIP_ID } },
    { headers: { "Idempotency-Key": "not-a-uuid" } },
    { headers: { "Idempotency-Key": "" } },
    { body: hookBody({ on: "false" }) },
    { body: hookBody({ on: 0 }) },
    { body: hookBody({ on: null }) },
    { body: hookBody({ etag: "C".repeat(64) }) },
    { body: hookBody({ text: "Teks lain" }) },
    { body: JSON.stringify({ on: true }) },
    { body: "[]" },
    { body: "{" },
    { request: { contentType: "text/plain" } },
  ];
  for (const options of cases) {
    const result = await send(route, options);
    assert.equal(result.status, 400, JSON.stringify(options));
    assert.equal(result.body.code, "invalid_request");
  }
  const large = await send(route, { body: hookBody({ etag: ETAG.padEnd(2000, " ") }) });
  assert.equal(large.status, 413);
  assert.equal(calls.length, 0);
});

test("the route runs set_hook once and answers only the contract fields", async () => {
  const { calls, runCli } = recorder({ set_hook: SWITCHED });
  const route = createClipHookRoute({ authorize, env: env(), runCli });
  const result = await send(route);
  assert.equal(result.status, 200, result.text);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.deepEqual(calls.map(({ module, op, payload }) => ({ module, op, payload })), [{
    module: "ai_clipper.edit_v2.api", op: "set_hook",
    payload: { jobId: JOB_ID, clipId: CLIP_ID, etag: ETAG, hook: "off", idempotencyKey: REQUEST_ID },
  }]);
  assert.deepEqual(result.body, { etag: NEXT, revision: 4, changed: true, hook: { on: false, available: true } });
  const on = recorder({ set_hook: SWITCHED });
  await send(createClipHookRoute({ authorize, env: env(), runCli: on.runCli }), { body: hookBody({ on: true }) });
  assert.equal(on.calls[0].payload.hook, "on");
});

test("the route maps the CLI outcomes to fixed answers and never sends a document back", async () => {
  const outcomes = [
    [{ exitCode: 5, json: { error: { code: "revision_conflict" }, current: { secret: 1 }, etag: NEXT } }, 409, "revision_conflict"],
    [{ exitCode: 9, json: { error: { code: "idempotency_conflict" } } }, 409, "idempotency_conflict"],
    [{ exitCode: 4, json: { error: { code: "not_found" } } }, 404, "not_found"],
    [{ exitCode: 6, json: { error: { code: "op_disabled", path: "/base/words" } } }, 422, "op_disabled"],
    [{ exitCode: 8, json: { error: { code: "analysis_missing" } } }, 409, "analysis_missing"],
    [{ exitCode: 2, json: { error: { code: "internal_error" } } }, 503, "backend_unavailable"],
    [{ exitCode: 0, json: { etag: "nope" } }, 503, "backend_unavailable"],
    [null, 503, "backend_unavailable"],
  ];
  for (const [outcome, status, code] of outcomes) {
    const route = createClipHookRoute({ authorize, env: env(), runCli: async () => outcome });
    const result = await send(route);
    assert.equal(result.status, status, result.text);
    assert.equal(result.body.code, code);
    assert.equal(result.body.current, undefined);
  }
});

test("sanitizeHookResult keeps the contract fields with their types, else null", () => {
  assert.deepEqual(sanitizeHookResult({ etag: NEXT, revision: 0, changed: false, hook: { on: true, available: true, x: 1 }, y: "/p" }),
    { etag: NEXT, revision: 0, changed: false, hook: { on: true, available: true } });
  for (const bad of [null, {}, { etag: NEXT, revision: -1, changed: true, hook: { on: true, available: true } },
    { etag: NEXT, revision: 1, changed: "yes", hook: { on: true, available: true } },
    { etag: NEXT, revision: 1, changed: true, hook: { on: 1, available: true } }]) {
    assert.equal(sanitizeHookResult(bad), null, JSON.stringify(bad));
  }
});

test("the clips listing carries each clip's hook state", () => {
  const entry = { clipId: CLIP_ID, index: 1, edit: { state: "seed", revision: 0, etag: ETAG, updatedAtMs: 1 } };
  assert.deepEqual(sanitizeClip({ ...entry, hook: { on: false, available: true, x: 1 } }).hook, { on: false, available: true });
  assert.equal(sanitizeClip({ ...entry, hook: { on: "no", available: true } }).hook, null);
  assert.equal(sanitizeClip({ ...entry, hook: null }).hook, null);
  assert.equal(sanitizeClip(entry).hook, null);
});

// --- the real api CLI --------------------------------------------------------------------------------

const BUILD_JOB = String.raw`
import json, sys
from pathlib import Path
repo, root = Path(sys.argv[1]), Path(sys.argv[2])
sys.path[:0] = [str(repo / "src"), str(repo / "tests")]
from support import edit_v2_fixtures as fixtures
from test_edit_v2_api import make_job
contexts = {cid: fixtures.load_context(cid) for cid in fixtures.CONTEXT_IDS}
job_id, _job = make_job(root, contexts)
print(json.dumps(job_id))
`;

async function runPython(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(python(), args, { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: os.tmpdir() } });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else reject(new Error(`python exited ${code}: ${Buffer.concat(err).toString("utf8").slice(-2000)}`));
    });
  });
}

test("a real switch off and on through the route, the store and the listing", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clip-hook-real-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const jobId = JSON.parse(await runPython(["-c", BUILD_JOB, REPO, root]));
  const deps = { authorize, env: env({ JOBS_ROOT: root }), pythonBin: python() };
  const listing = async () => (await read(await createClipsRoute(deps).GET(request(`/api/jobs/${jobId}/clips`, { method: "GET" }),
    context({ id: jobId })))).body.clips[0];
  const first = await listing();
  assert.deepEqual(first.hook, { on: true, available: true });
  const route = createClipHookRoute(deps);
  const call = (on, etag, key = randomUUID()) => route.POST(request(`/api/jobs/${jobId}/clips/${first.clipId}/hook`, {
    body: JSON.stringify({ on, etag }), headers: { "Idempotency-Key": key },
  }), context({ id: jobId, clipId: first.clipId })).then(read);

  const key = randomUUID();
  const off = await call(false, first.edit.etag, key);
  assert.equal(off.status, 200, off.text);
  assert.deepEqual(off.body, { etag: off.body.etag, revision: 1, changed: true, hook: { on: false, available: true } });
  assert.ok(!off.text.includes(root));
  assert.deepEqual(await call(false, first.edit.etag, key), off, "the same Idempotency-Key replays the switch");
  const stale = await call(true, first.edit.etag);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "revision_conflict");

  const after = await listing();
  assert.deepEqual(after.hook, { on: false, available: true });
  assert.deepEqual(after.edit, { state: "edited", revision: 1, etag: off.body.etag, updatedAtMs: after.edit.updatedAtMs });
  const edit = await read(await createEditRoute(deps).GET(request(`/api/jobs/${jobId}/clips/${first.clipId}/edit`, { method: "GET" }),
    context({ id: jobId, clipId: first.clipId })));
  assert.equal(edit.body.doc.tracks.some((track) => track.kind === "hook"), false);
  assert.equal(edit.body.doc.audit.last_command, "SetHookEnabled");

  const on = await call(true, off.body.etag);
  assert.equal(on.status, 200, on.text);
  assert.deepEqual(on.body.hook, { on: true, available: true });
  assert.equal(on.body.revision, 2);
});
