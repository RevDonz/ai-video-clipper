// "Pakai di semua klip" routes (CONTRACTS §5.48): POST /api/jobs/:id/clips/:clipId/apply-all and
// POST /api/jobs/:id/apply-all/:batchId/undo. Unit cases use a recording CLI runner; the
// integration case runs the real `python -m ai_clipper.edit_v2.api` on a three-clip job.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as applyRouteModule from "../app/api/jobs/[id]/clips/[clipId]/apply-all/route.js";
import * as undoRouteModule from "../app/api/jobs/[id]/apply-all/[batchId]/undo/route.js";
import { createApplyAllRoute, createUndoApplyAllRoute, sanitizeApplyResult, sanitizeUndoResult } from "../lib/apply-all.mjs";
import { createSessionToken, isAuthorized } from "../lib/auth.mjs";
import { createClipsRoute, createEditRoute } from "../lib/clip-edit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const AUTH = Object.freeze({ APP_USERNAME: "admin", APP_PASSWORD: "pw-batch-value", APP_SESSION_SECRET: "batch-session-".padEnd(48, "q") });
const JOB_ID = "8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55";
const CLIP_ID = "clip_62654c2c2fa04f125391464a";
const OTHER = "clip_000000000000000000000002";
const ETAG = "c".repeat(64);
const BATCH = "4a7e1c2b-9d3f-4b6a-8c5e-0f1a2b3c4d5e";
const APPLY_URL = `/api/jobs/${JOB_ID}/clips/${CLIP_ID}/apply-all`;
const UNDO_URL = `/api/jobs/${JOB_ID}/apply-all/${BATCH}/undo`;
const APPLY_IDS = { id: JOB_ID, clipId: CLIP_ID };
const UNDO_IDS = { id: JOB_ID, batchId: BATCH };

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

const applyBody = (extra = {}) => JSON.stringify({ group: "captions", etag: ETAG, ...extra });
const apply = (route, options = {}) => route.POST(request(APPLY_URL, {
  body: options.body ?? applyBody(), headers: { "Idempotency-Key": BATCH, ...options.headers }, ...options.request,
}), context(options.ids ?? APPLY_IDS)).then(read);
const undo = (route, options = {}) => route.POST(request(UNDO_URL, { body: options.body, ...options.request }),
  context(options.ids ?? UNDO_IDS)).then(read);

const APPLIED = Object.freeze({
  exitCode: 0,
  json: {
    batchId: BATCH, group: "captions", applied: [{ clipId: OTHER, index: 2 }],
    skipped: [{ clipId: null, index: 3, reason: "not_ready" }, { clipId: OTHER, index: 4, reason: "edited", path: "/x" }],
    unchanged: [],
  },
});

test("route modules export POST on node", () => {
  for (const module of [applyRouteModule, undoRouteModule]) {
    assert.equal(typeof module.POST, "function");
    assert.equal(module.runtime, "nodejs");
    assert.equal(module.dynamic, "force-dynamic");
  }
});

test("both routes need a session, the editor flag and the same origin before anything is spawned", async () => {
  const { calls, runCli } = recorder();
  const deps = { authorize, env: env(), runCli };
  assert.equal((await apply(createApplyAllRoute(deps), { request: { cookie: false } })).status, 401);
  assert.equal((await undo(createUndoApplyAllRoute(deps), { request: { cookie: false } })).status, 401);
  const off = { authorize, env: env({ POTONGIN_EDITOR_V3: "off" }), runCli };
  assert.equal((await apply(createApplyAllRoute(off))).status, 404);
  assert.equal((await undo(createUndoApplyAllRoute(off))).status, 404);
  for (const origin of ["http://evil.example", null]) {
    const applied = await apply(createApplyAllRoute(deps), { request: { origin } });
    assert.equal(applied.status, 403);
    assert.equal(applied.body.code, "csrf_rejected");
    assert.equal((await undo(createUndoApplyAllRoute(deps), { request: { origin } })).status, 403);
  }
  assert.equal(calls.length, 0);
});

test("apply checks the ids, the Idempotency-Key and the body exactly", async () => {
  const { calls, runCli } = recorder();
  const route = createApplyAllRoute({ authorize, env: env(), runCli });
  const cases = [
    { ids: { id: JOB_ID, clipId: "clip_../x" } },
    { ids: { id: "../etc", clipId: CLIP_ID } },
    { headers: { "Idempotency-Key": "not-a-uuid" } },
    { headers: { "Idempotency-Key": "" } },
    { body: applyBody({ group: "music" }) },
    { body: applyBody({ etag: "C".repeat(64) }) },
    { body: applyBody({ extra: 1 }) },
    { body: JSON.stringify({ group: "captions" }) },
    { body: "[]" },
    { body: "{" },
    { request: { contentType: "text/plain" } },
  ];
  for (const options of cases) {
    const result = await apply(route, options);
    assert.equal(result.status, 400, JSON.stringify(options));
    assert.equal(result.body.code, "invalid_request");
  }
  const large = await apply(route, { body: applyBody({ group: "captions".padEnd(2000, " ") }) });
  assert.equal(large.status, 413);
  assert.equal(calls.length, 0);
});

test("apply runs the api CLI once with the batch id and returns only the contract fields", async () => {
  const { calls, runCli } = recorder({ apply_all: APPLIED });
  const route = createApplyAllRoute({ authorize, env: env(), runCli });
  const result = await apply(route, { body: applyBody({ group: "logo" }) });
  assert.equal(result.status, 200, result.text);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.deepEqual(calls.map(({ module, op, payload }) => ({ module, op, payload })), [{
    module: "ai_clipper.edit_v2.api", op: "apply_all",
    payload: { jobId: JOB_ID, clipId: CLIP_ID, etag: ETAG, group: "logo", batchId: BATCH },
  }]);
  assert.ok(calls[0].options.timeoutMs >= 60_000);
  assert.deepEqual(result.body, {
    batchId: BATCH, group: "captions", applied: [{ clipId: OTHER, index: 2 }],
    skipped: [{ clipId: null, index: 3, reason: "not_ready" }, { clipId: OTHER, index: 4, reason: "edited" }],
    unchanged: [],
  });
});

test("apply maps the CLI outcomes to fixed answers", async () => {
  const outcomes = [
    [{ exitCode: 5, json: { error: { code: "revision_conflict" }, current: { secret: 1 }, etag: ETAG } }, 409, "revision_conflict"],
    [{ exitCode: 9, json: { error: { code: "idempotency_conflict" } } }, 409, "idempotency_conflict"],
    [{ exitCode: 4, json: { error: { code: "not_found" } } }, 404, "not_found"],
    [{ exitCode: 2, json: { error: { code: "internal_error" } } }, 503, "backend_unavailable"],
    [null, 503, "backend_unavailable"],
  ];
  for (const [outcome, status, code] of outcomes) {
    const route = createApplyAllRoute({ authorize, env: env(), runCli: async () => outcome });
    const result = await apply(route);
    assert.equal(result.status, status, result.text);
    assert.equal(result.body.code, code);
    // The source's newer document is the editor's own business: it never travels back here.
    assert.equal(result.body.current, undefined);
  }
});

test("undo takes an empty body or {}, and answers the restored and skipped clips", async () => {
  const { calls, runCli } = recorder({
    undo_apply_all: { exitCode: 0, json: { batchId: BATCH, group: "layout", restored: [{ clipId: OTHER, index: 2 }],
      skipped: [{ clipId: CLIP_ID, index: 5, reason: "changed" }, { clipId: CLIP_ID, index: 6, reason: "weird" }] } },
  });
  const route = createUndoApplyAllRoute({ authorize, env: env(), runCli });
  for (const body of [undefined, "{}", " { } "]) {
    const result = await undo(route, { body });
    assert.equal(result.status, 200, result.text);
    assert.deepEqual(result.body, {
      batchId: BATCH, group: "layout", restored: [{ clipId: OTHER, index: 2 }],
      skipped: [{ clipId: CLIP_ID, index: 5, reason: "changed" }, { clipId: CLIP_ID, index: 6, reason: "invalid" }],
    });
  }
  assert.deepEqual(calls[0].payload, { jobId: JOB_ID, batchId: BATCH });
  assert.equal((await undo(route, { body: '{"all":true}' })).status, 400);
  assert.equal((await undo(route, { ids: { id: JOB_ID, batchId: "x" } })).status, 400);
  assert.equal(calls.length, 3);
  const missing = createUndoApplyAllRoute({ authorize, env: env(),
    runCli: async () => ({ exitCode: 4, json: { error: { code: "not_found" } } }) });
  const gone = await undo(missing);
  assert.equal(gone.status, 404);
  assert.equal(gone.body.code, "not_found");
});

test("the sanitizers drop anything outside the contract", () => {
  assert.deepEqual(sanitizeApplyResult({ batchId: "x", group: "music", applied: [{ clipId: "../x", index: 1 }, { index: "2" }, null],
    skipped: "no", unchanged: [{ clipId: OTHER, index: 3, reason: "edited" }] }), {
    batchId: null, group: null, applied: [{ clipId: null, index: 1 }], skipped: [], unchanged: [{ clipId: OTHER, index: 3 }],
  });
  assert.deepEqual(sanitizeUndoResult({}), { batchId: null, group: null, restored: [], skipped: [] });
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

test("a real batch and its undo through the routes, the store and the receipts", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "apply-all-real-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const jobId = JSON.parse(await runPython(["-c", BUILD_JOB, REPO, root]));
  const deps = { authorize, env: env({ JOBS_ROOT: root }), pythonBin: python() };
  const listing = await read(await createClipsRoute(deps).GET(request(`/api/jobs/${jobId}/clips`, { method: "GET" }), context({ id: jobId })));
  const [first, second, third] = listing.body.clips.map((clip) => clip.clipId);
  const edit = createEditRoute(deps);
  const editUrl = (clipId) => `/api/jobs/${jobId}/clips/${clipId}/edit`;
  const current = (clipId) => edit.GET(request(editUrl(clipId), { method: "GET" }), context({ id: jobId, clipId })).then(read);
  const seed = await current(first);
  const next = structuredClone(seed.body.doc);
  next.revision = 1;
  next.parent_sha256 = seed.body.etag;
  next.audit.editor = "editor-v3/1.0.0";
  next.audit.last_command = "SetCaptionPack";
  next.captions.pack = { id: "bold", v: 1 };
  const saved = await read(await edit.PUT(request(editUrl(first), { method: "PUT", body: JSON.stringify(next),
    headers: { "If-Match": `"${seed.body.etag}"`, "Idempotency-Key": randomUUID() } }), context({ id: jobId, clipId: first })));
  assert.equal(saved.status, 200, saved.text);

  const batchId = randomUUID();
  const route = createApplyAllRoute(deps);
  const call = (etag) => route.POST(request(`/api/jobs/${jobId}/clips/${first}/apply-all`, {
    body: JSON.stringify({ group: "captions", etag }), headers: { "Idempotency-Key": batchId },
  }), context({ id: jobId, clipId: first })).then(read);
  const stale = await route.POST(request(`/api/jobs/${jobId}/clips/${first}/apply-all`, {
    body: JSON.stringify({ group: "captions", etag: seed.body.etag }), headers: { "Idempotency-Key": randomUUID() },
  }), context({ id: jobId, clipId: first })).then(read);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "revision_conflict");
  const result = await call(saved.body.etag);
  assert.equal(result.status, 200, result.text);
  assert.deepEqual(result.body, { batchId, group: "captions", applied: [{ clipId: second, index: 2 }, { clipId: third, index: 3 }],
    skipped: [], unchanged: [] });
  assert.ok(!result.text.includes(root));
  for (const clipId of [second, third]) assert.deepEqual((await current(clipId)).body.doc.captions.pack, { id: "bold", v: 1 });
  assert.deepEqual(await call(saved.body.etag), result, "the same Idempotency-Key replays the batch");

  const undone = await read(await createUndoApplyAllRoute(deps).POST(request(`/api/jobs/${jobId}/apply-all/${batchId}/undo`),
    context({ id: jobId, batchId })));
  assert.equal(undone.status, 200, undone.text);
  assert.deepEqual(undone.body, { batchId, group: "captions", restored: [{ clipId: second, index: 2 }, { clipId: third, index: 3 }], skipped: [] });
  for (const clipId of [second, third]) {
    const doc = (await current(clipId)).body.doc;
    assert.deepEqual(doc.captions.pack, seed.body.doc.captions.pack);
    assert.equal(doc.revision, 2);
  }
});
