// Editor V3 exports (plan §4.2, §4.6, §9.1; T2.2): POST/GET /api/jobs/:id/clips/:clipId/renders,
// GET (legacy and v3) and DELETE /api/jobs/:id/renders/:renderId, the v3 request validator and the
// RenderDTO. Every path is resolved from import.meta.url (plan §8, D11).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as clipRendersRouteModule from "../app/api/jobs/[id]/clips/[clipId]/renders/route.js";
import * as renderStatusRouteModule from "../app/api/jobs/[id]/renders/[renderId]/route.js";
import { createSessionToken, isAuthorized } from "../lib/auth.mjs";
import {
  RENDER_QUEUE_MODULE,
  createClipRendersRoute,
  createRenderStatusRoute,
  latestRenders,
  listClipRenders,
  renderDtoV3,
  validateRenderRequestV3,
} from "../lib/clip-renders.mjs";
import { PYTHON_CLI_MODULES, PythonCliError, childEnv } from "../lib/python-cli.mjs";
import { sanitizeRenderStatus } from "../lib/render-requests.mjs";
import { StorageAdmissionError } from "../lib/storage-admission.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const AUTH = Object.freeze({ APP_USERNAME: "admin", APP_PASSWORD: "pw-secret-value", APP_SESSION_SECRET: "session-secret-".padEnd(48, "z") });
const JOB_ID = "8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55";
const CLIP_ID = "clip_62654c2c2fa04f125391464a";
const OTHER_CLIP = "clip_" + "1".repeat(24);
const RENDER_ID = "923e4567-e89b-42d3-a456-426614174000";
const KEY = "323e4567-e89b-42d3-a456-426614174000";
const RESERVATION_ID = "423e4567-e89b-42d3-a456-426614174000";
const RESERVATION_TOKEN = "523e4567-e89b-42d3-a456-426614174000";
const DOC_SHA = "d".repeat(64);
const SOURCE_SHA = "5".repeat(64);
const RENDER_KEY = "e".repeat(64);
const T0 = "2026-09-25T12:00:00.000Z";
const T1 = "2026-09-25T12:00:05.000Z";
const T2 = "2026-09-25T12:00:30.000Z";
const SECRETS = Object.freeze({
  APP_PASSWORD: AUTH.APP_PASSWORD, APP_SESSION_SECRET: AUTH.APP_SESSION_SECRET,
  POTONGIN_SETTINGS_SECRET: "settings-secret-value", OPENROUTER_API_KEY: "sk-or-secret-value",
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

function v3Request(overrides = {}) {
  return {
    version: "render-request-v3", render_id: RENDER_ID, idempotency_key: KEY, state: "queued", stage: "antre",
    progress_pm: 0, clip_id: CLIP_ID, doc_sha256: DOC_SHA, doc_revision: 2,
    doc_relative: `analysis/clips/${CLIP_ID}/edit/archive/r2.${DOC_SHA}.json.gz`, render_key: RENDER_KEY,
    size: "output", quality: "standar", output_relative: `output/edits/${CLIP_ID}/${RENDER_KEY.slice(0, 16)}.mp4`,
    source_content_sha256: SOURCE_SHA, source_snapshot_relative: `analysis/render-inputs/source.${SOURCE_SHA}.mp4`,
    timeout_ms: 129_600, created_at: T0, updated_at: T0, claimed_at: null, rendering_at: null, completed_at: null,
    failed_at: null, cancelled_at: null, cancel_requested_at: null, attempts: 0, error_code: null, warnings: [],
    completed_by: null, lease_token: null, heartbeat_at: null, storage_reservation_id: null,
    storage_reservation_token: null, storage_reserved_bytes: null, ...overrides,
  };
}

function rendering(overrides = {}) {
  return v3Request({ state: "rendering", stage: "merender", progress_pm: 420, attempts: 1, claimed_at: T1, rendering_at: T1,
    lease_token: "623e4567-e89b-42d3-a456-426614174000", heartbeat_at: T1, updated_at: T1, ...overrides });
}

function completed(overrides = {}) {
  return v3Request({ state: "completed", stage: "selesai", progress_pm: 1000, attempts: 1, claimed_at: T1, rendering_at: T1,
    completed_at: T2, updated_at: T2, completed_by: "render", ...overrides });
}

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

function storage(events, { reserve, bind = true } = {}) {
  return {
    storageConfig: { quotaBytes: 1n },
    randomUUID: () => RESERVATION_ID,
    reserve: async (jobsRoot, options) => {
      events.push(["reserve", options.jobId, options.declaredBytes, options.reservationId]);
      if (reserve instanceof Error) throw reserve;
      return { reservationId: options.reservationId, token: RESERVATION_TOKEN, reservedBytes: String(options.declaredBytes + 100n) };
    },
    bind: async (jobsRoot, reservationId, token, renderId) => {
      events.push(["bind", reservationId, token, renderId]);
      return bind;
    },
    release: async (jobsRoot, reservationId, token, terminalState) => {
      events.push(["release", reservationId, token, terminalState]);
      return true;
    },
  };
}

const RENDERS_URL = `/api/jobs/${JOB_ID}/clips/${CLIP_ID}/renders`;
const STATUS_URL = `/api/jobs/${JOB_ID}/renders/${RENDER_ID}`;
const CLIP_IDS = { id: JOB_ID, clipId: CLIP_ID };
const STATUS_IDS = { id: JOB_ID, renderId: RENDER_ID };
const BODY = JSON.stringify({ editEtag: DOC_SHA });

function post(route, { body = BODY, key = KEY, ...options } = {}) {
  const headers = key === null ? {} : { "Idempotency-Key": key };
  return route.POST(request(RENDERS_URL, { method: "POST", body, headers, ...options }), context(CLIP_IDS)).then(read);
}

async function queueDir(root, jobId = JOB_ID) {
  const job = path.join(root, jobId);
  const directory = path.join(job, "analysis", "render-requests");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(job, "job.json"), "{}");
  return directory;
}

async function writeRequest(directory, value) {
  await writeFile(path.join(directory, `${value.render_id}.json`), JSON.stringify(value));
}

// --- the request and its DTO ----------------------------------------------------------------------

test("route modules export their handlers and run on node", () => {
  assert.equal(typeof clipRendersRouteModule.POST, "function");
  assert.equal(typeof clipRendersRouteModule.GET, "function");
  assert.equal(typeof renderStatusRouteModule.GET, "function");
  assert.equal(typeof renderStatusRouteModule.DELETE, "function");
  for (const module of [clipRendersRouteModule, renderStatusRouteModule]) {
    assert.equal(module.runtime, "nodejs");
    assert.equal(module.dynamic, "force-dynamic");
  }
});

test("the v3 validator accepts every state and rejects what the Python validator rejects", () => {
  for (const value of [v3Request(), rendering(), completed(),
    completed({ completed_by: "seed", attempts: 0, claimed_at: null, rendering_at: null, source_snapshot_relative: null }),
    v3Request({ state: "cancelled", cancelled_at: T1, error_code: "cancelled", updated_at: T1 }),
    rendering({ cancel_requested_at: T2 }),
    v3Request({ state: "failed", attempts: 1, claimed_at: T1, failed_at: T2, error_code: "verification_failed", stage: "memverifikasi" }),
    v3Request({ storage_reservation_id: RESERVATION_ID, storage_reservation_token: RESERVATION_TOKEN, storage_reserved_bytes: 4096 }),
    completed({ warnings: ["peak_reduced:-3.80 dB", "auto_file_unavailable"] })]) {
    assert.deepEqual(validateRenderRequestV3(value), value);
  }
  const bad = [
    { extra: 1 }, { version: "render-request-v2" }, { state: "paused" }, { stage: "selesai" }, { progress_pm: 1001 },
    { progress_pm: 1.5 }, { clip_id: "clip_x" }, { doc_revision: -1 },
    { doc_relative: `analysis/clips/${CLIP_ID}/seed.json` },
    { output_relative: `output/edits/${CLIP_ID}/../../escape.mp4` }, { output_relative: `output/edits/${OTHER_CLIP}/${RENDER_KEY.slice(0, 16)}.mp4` },
    { size: "1080x1920" }, { quality: "tinggi" }, { timeout_ms: 1000 }, { warnings: ["<script>"] },
    { warnings: "tight_cut" }, { completed_by: "seed" }, { source_snapshot_relative: null },
    { source_snapshot_relative: "/etc/passwd" }, { storage_reservation_id: RESERVATION_ID }, { attempts: 4 },
    { error_code: "render_failed" }, { cancel_requested_at: T1 }, { created_at: "yesterday" },
    { render_id: "../../x" }, { idempotency_key: KEY.toUpperCase() },
  ];
  for (const change of bad) {
    assert.throws(() => validateRenderRequestV3(v3Request(change)), undefined, JSON.stringify(change));
  }
  const { stage: _stage, ...missing } = v3Request();
  assert.throws(() => validateRenderRequestV3(missing));
  assert.throws(() => validateRenderRequestV3(completed({ completed_by: null })));
  assert.throws(() => validateRenderRequestV3(rendering({ lease_token: null })));
});

test("the RenderDTO carries state, stage and links, never a server path", () => {
  const queued = renderDtoV3(JOB_ID, v3Request({ warnings: ["auto_file_unavailable"] }));
  assert.deepEqual(queued, {
    renderId: RENDER_ID, clipId: CLIP_ID, state: "queued", stage: "antre", progressPm: 0, revision: 2,
    errorCode: null, resultUrl: null, srtUrl: null, warnings: ["auto_file_unavailable"], completedBy: null,
    cancelRequested: false, createdAt: T0, updatedAt: T0,
  });
  const done = renderDtoV3(JOB_ID, completed());
  const base = `/api/jobs/${JOB_ID}/files/output/edits/${CLIP_ID}/${RENDER_KEY.slice(0, 16)}`;
  assert.equal(done.resultUrl, `${base}.mp4`);
  assert.equal(done.srtUrl, `${base}.srt`);
  assert.equal(done.progressPm, 1000);
  assert.equal(renderDtoV3(JOB_ID, rendering({ cancel_requested_at: T2 })).cancelRequested, true);
  const text = JSON.stringify([queued, done]);
  for (const secret of ["analysis/", "render-inputs", RESERVATION_TOKEN, "lease", SOURCE_SHA, DOC_SHA]) {
    assert.ok(!text.includes(secret), secret);
  }
});

// --- POST /clips/:clipId/renders -------------------------------------------------------------------

test("POST renders: session, flag, CSRF, ids and the exact {editEtag} body, before any spawn", async () => {
  const { calls, runCli } = recorder();
  const events = [];
  const deps = { authorize, env: env(), runCli, ...storage(events) };
  assert.equal((await post(createClipRendersRoute(deps), { cookie: false })).status, 401);
  const off = await post(createClipRendersRoute({ ...deps, env: env({ POTONGIN_EDITOR_V3: "off" }) }));
  assert.deepEqual([off.status, off.body.code], [404, "editor_disabled"]);
  for (const options of [{ origin: "https://evil.example" }, { origin: null }, { fetchSite: "cross-site" }]) {
    const result = await post(createClipRendersRoute(deps), options);
    assert.deepEqual([result.status, result.body.code], [403, "csrf_rejected"]);
  }
  for (const key of [null, "nope", KEY.toUpperCase()]) {
    assert.equal((await post(createClipRendersRoute(deps), { key })).status, 400, String(key));
  }
  for (const body of ["{}", JSON.stringify({ editEtag: DOC_SHA, size: "1080x1920" }), JSON.stringify({ editEtag: DOC_SHA.toUpperCase() }),
    JSON.stringify({ editEtag: 5 }), `[${BODY}]`, "", `{"editEtag":"${DOC_SHA}","editEtag":"${DOC_SHA}"}`]) {
    assert.equal((await post(createClipRendersRoute(deps), { body })).status, 400, body);
  }
  assert.equal((await post(createClipRendersRoute(deps), { contentType: "text/plain" })).status, 400);
  const big = await post(createClipRendersRoute(deps), { body: `{"editEtag":"${DOC_SHA}"${" ".repeat(1100)}}` });
  assert.deepEqual([big.status, big.body.code], [413, "payload_too_large"]);
  const ids = await createClipRendersRoute(deps).POST(request(RENDERS_URL, { method: "POST", body: BODY, headers: { "Idempotency-Key": KEY } }),
    context({ id: JOB_ID, clipId: "clip_bad" }));
  assert.equal(ids.status, 400);
  assert.deepEqual([calls.length, events.length], [0, 0]);
});

test("POST renders reserves storage first, creates, binds and answers 202 with the DTO", async () => {
  const events = [];
  const { calls, runCli } = recorder({
    estimate: { exitCode: 0, json: { bytes: "123456" } },
    create: (payload) => {
      events.push(["create", payload.storageReservation.reservation_id]);
      return { exitCode: 0, json: { request: v3Request({ storage_reservation_id: RESERVATION_ID,
        storage_reservation_token: RESERVATION_TOKEN, storage_reserved_bytes: payload.storageReservation.reserved_bytes }) } };
    },
  });
  const result = await post(createClipRendersRoute({ authorize, env: env(), runCli, ...storage(events) }));
  assert.equal(result.status, 202, result.text);
  assert.deepEqual(result.body, renderDtoV3(JOB_ID, v3Request()));
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.equal(result.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(events, [
    ["reserve", JOB_ID, 123456n, RESERVATION_ID],
    ["create", RESERVATION_ID],
    ["bind", RESERVATION_ID, RESERVATION_TOKEN, RENDER_ID],
  ]);
  assert.deepEqual(calls.map(({ module, op }) => [module, op]), [[RENDER_QUEUE_MODULE, "estimate"], [RENDER_QUEUE_MODULE, "create"]]);
  assert.deepEqual(calls[1].payload, { jobId: JOB_ID, clipId: CLIP_ID, editEtag: DOC_SHA, idempotencyKey: KEY,
    storageReservation: { reservation_id: RESERVATION_ID, token: RESERVATION_TOKEN, reserved_bytes: 123556 } });
  assert.ok(calls[1].options.timeoutMs >= 120_000);
  assert.equal(calls[1].options.env.JOBS_ROOT, "/data/jobs");
});

test("POST renders completes at once (200) by R10 or an existing key and releases its reservation", async () => {
  for (const completedBy of ["seed", "key"]) {
    const events = [];
    const instant = completed({ completed_by: completedBy, attempts: 0, claimed_at: null, rendering_at: null,
      source_snapshot_relative: null, storage_reservation_id: RESERVATION_ID, storage_reservation_token: RESERVATION_TOKEN,
      storage_reserved_bytes: 4096 });
    const { runCli } = recorder({ estimate: { exitCode: 0, json: { bytes: "1" } }, create: { exitCode: 0, json: { request: instant } } });
    const result = await post(createClipRendersRoute({ authorize, env: env(), runCli, ...storage(events) }));
    assert.equal(result.status, 200);
    assert.equal(result.body.state, "completed");
    assert.equal(result.body.completedBy, completedBy);
    assert.ok(result.body.resultUrl.endsWith(".mp4"));
    assert.deepEqual(events.at(-1), ["release", RESERVATION_ID, RESERVATION_TOKEN, "completed"]);
    assert.ok(!events.some(([name]) => name === "bind"));
  }
});

test("POST renders replay releases only its own unused reservation", async () => {
  const events = [];
  const earlier = rendering({ storage_reservation_id: "723e4567-e89b-42d3-a456-426614174000",
    storage_reservation_token: "823e4567-e89b-42d3-a456-426614174000", storage_reserved_bytes: 99 });
  const { runCli } = recorder({ estimate: { exitCode: 0, json: { bytes: "1" } }, create: { exitCode: 0, json: { request: earlier } } });
  const result = await post(createClipRendersRoute({ authorize, env: env(), runCli, ...storage(events) }));
  assert.equal(result.status, 202);
  assert.equal(result.body.state, "rendering");
  assert.deepEqual(events.at(-1), ["release", RESERVATION_ID, RESERVATION_TOKEN, "failed"]);
  assert.ok(!events.some(([name]) => name === "bind"));
});

test("POST renders maps estimate, storage, create and bind failures to fixed codes", async () => {
  const error = (exitCode, code) => ({ exitCode, json: { error: { code, path: null, ref: null, messageId: `edit.${code}` } } });
  const cases = [
    [{ estimate: error(5, "revision_conflict") }, {}, 409, "revision_conflict", false],
    [{ estimate: error(4, "not_found") }, {}, 404, "not_found", false],
    [{ estimate: new PythonCliError("invalid_request") }, {}, 503, "backend_unavailable", false],
    [{ estimate: { exitCode: 0, json: { bytes: "-1" } } }, {}, 503, "backend_unavailable", false],
    [{ estimate: { exitCode: 0, json: { bytes: "1" } } }, { reserve: new StorageAdmissionError("storage_quota_exhausted", "full") }, 507, "storage_quota_exhausted", false],
    [{ estimate: { exitCode: 0, json: { bytes: "1" } } }, { reserve: new StorageAdmissionError("storage_free_space_low", "low") }, 507, "storage_free_space_low", false],
    [{ estimate: { exitCode: 0, json: { bytes: "1" } } }, { reserve: new StorageAdmissionError("storage_admission_unavailable", "x") }, 503, "storage_admission_unavailable", false],
    [{ estimate: { exitCode: 0, json: { bytes: "1" } }, create: error(5, "revision_conflict") }, {}, 409, "revision_conflict", true],
    [{ estimate: { exitCode: 0, json: { bytes: "1" } }, create: error(9, "idempotency_conflict") }, {}, 409, "idempotency_conflict", true],
    [{ estimate: { exitCode: 0, json: { bytes: "1" } }, create: error(4, "source_missing") }, {}, 409, "source_missing", true],
    [{ estimate: { exitCode: 0, json: { bytes: "1" } }, create: error(8, "analysis_missing") }, {}, 409, "analysis_missing", true],
    [{ estimate: { exitCode: 0, json: { bytes: "1" } }, create: error(4, "not_found") }, {}, 404, "not_found", true],
    [{ estimate: { exitCode: 0, json: { bytes: "1" } }, create: error(6, "asset_missing") }, {}, 422, "asset_missing", true],
    [{ estimate: { exitCode: 0, json: { bytes: "1" } }, create: new PythonCliError("spawn_failed") }, {}, 503, "backend_unavailable", true],
    [{ estimate: { exitCode: 0, json: { bytes: "1" } }, create: { exitCode: 0, json: { request: { version: "render-request-v3" } } } }, {}, 503, "backend_unavailable", true],
  ];
  for (const [results, storageOptions, status, code, released] of cases) {
    const events = [];
    const { runCli } = recorder(results);
    const result = await post(createClipRendersRoute({ authorize, env: env(), runCli, ...storage(events, storageOptions) }));
    assert.equal(result.status, status, `${code}: ${result.text}`);
    assert.equal(result.body.code, code);
    assert.equal(typeof result.body.error, "string");
    assert.equal(events.some(([name, , , state]) => name === "release" && state === "failed"), released, code);
  }
  const events = [];
  const { runCli } = recorder({ estimate: { exitCode: 0, json: { bytes: "1" } }, create: { exitCode: 0, json: { request: v3Request({
    storage_reservation_id: RESERVATION_ID, storage_reservation_token: RESERVATION_TOKEN, storage_reserved_bytes: 101 }) } } });
  const lost = await post(createClipRendersRoute({ authorize, env: env(), runCli, ...storage(events, { bind: false }) }));
  assert.deepEqual([lost.status, lost.body.code], [503, "storage_admission_lost"]);
});

// --- GET /clips/:clipId/renders and latestRenders (read in Node, no spawn) ---------------------------

test("the clip's exports are listed newest first from the request files, invalid ones skipped", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clip-renders-list-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = await queueDir(root);
  const older = completed({ render_id: randomUUID(), idempotency_key: randomUUID(), created_at: T0 });
  const newer = v3Request({ render_id: randomUUID(), idempotency_key: randomUUID(), created_at: T1, updated_at: T1 });
  const other = v3Request({ render_id: randomUUID(), idempotency_key: randomUUID(), clip_id: OTHER_CLIP,
    doc_relative: `analysis/clips/${OTHER_CLIP}/edit/archive/r2.${DOC_SHA}.json.gz`,
    output_relative: `output/edits/${OTHER_CLIP}/${RENDER_KEY.slice(0, 16)}.mp4`, created_at: T2, updated_at: T2 });
  for (const value of [older, newer, other]) await writeRequest(directory, value);
  await writeRequest(directory, { ...v3Request({ render_id: randomUUID() }), stage: "bogus" });
  await writeFile(path.join(directory, `${randomUUID()}.json`), "{not json");
  await writeFile(path.join(directory, `${randomUUID()}.json`), JSON.stringify({ version: "render-request-v1" }));
  await writeFile(path.join(directory, ".queue.lock"), "");
  await symlink(path.join(directory, `${older.render_id}.json`), path.join(directory, `${randomUUID()}.json`));
  const listed = await listClipRenders(JOB_ID, CLIP_ID, root);
  assert.deepEqual(listed.map((item) => item.render_id), [newer.render_id, older.render_id]);
  const latest = await latestRenders(JOB_ID, root);
  assert.deepEqual([...latest.keys()].sort(), [CLIP_ID, OTHER_CLIP].sort());
  assert.deepEqual(latest.get(CLIP_ID), { renderId: newer.render_id, state: "queued", url: null, srtUrl: null, revision: 2 });
  assert.deepEqual(await listClipRenders(randomUUID(), CLIP_ID, root), []);
  const { calls, runCli } = recorder();
  const route = createClipRendersRoute({ authorize, env: env({ JOBS_ROOT: root }), runCli });
  const result = await read(await route.GET(request(RENDERS_URL), context(CLIP_IDS)));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.renders, listed.map((item) => renderDtoV3(JOB_ID, item)));
  assert.equal(calls.length, 0);
});

// --- GET /renders/:renderId (legacy and v3) --------------------------------------------------------

test("GET render status serves v3 requests from the file and legacy requests unchanged", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clip-renders-status-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = await queueDir(root);
  await writeRequest(directory, rendering());
  const legacyId = "a23e4567-e89b-42d3-a456-426614174000";
  const candidate = `cand_${"a".repeat(64)}`;
  const legacy = {
    version: "render-request-v1", render_id: legacyId, idempotency_key: legacyId, state: "completed", candidate_id: candidate,
    candidate_artifact_sha256: "a".repeat(64), candidate_snapshot_relative: `analysis/render-inputs/candidates.${"a".repeat(64)}.json`,
    edit_manifest_sha256: "a".repeat(64), edit_revision: 2,
    edit_manifest_relative: `analysis/edits/archive/${candidate}.edit.v1.r2.${"a".repeat(64)}.json`,
    source_identity_sha256: "a".repeat(64), source_content_sha256: "a".repeat(64),
    source_snapshot_relative: `analysis/render-inputs/source.${"a".repeat(64)}.mp4`,
    output_relative: `output/edits/${candidate}/revision-2.mp4`, created_at: T0, updated_at: T1, claimed_at: T0,
    rendering_at: T0, completed_at: T1, failed_at: null, attempts: 1, error_code: null, lease_token: null, heartbeat_at: null,
  };
  await writeRequest(directory, legacy);
  const legacyCalls = [];
  const deps = { authorize, env: env({ JOBS_ROOT: root, POTONGIN_EDITOR_V3: "off" }), runCli: recorder().runCli,
    legacyRead: async (jobId, renderId) => { legacyCalls.push([jobId, renderId]); return legacy; } };
  const route = createRenderStatusRoute(deps);
  const v3 = await read(await route.GET(request(STATUS_URL), context(STATUS_IDS)));
  assert.equal(v3.status, 200);
  assert.deepEqual(v3.body, renderDtoV3(JOB_ID, rendering()));
  assert.equal(v3.body.progressPm, 420);
  assert.equal(v3.headers.get("cache-control"), "no-store");
  assert.equal(legacyCalls.length, 0);
  const old = await read(await route.GET(request(`/api/jobs/${JOB_ID}/renders/${legacyId}`), context({ id: JOB_ID, renderId: legacyId })));
  assert.equal(old.status, 200);
  assert.deepEqual(old.body, sanitizeRenderStatus(JOB_ID, legacy));  // byte-for-byte the legacy DTO
  assert.deepEqual(legacyCalls, [[JOB_ID, legacyId]]);
  const missingId = randomUUID();
  const missing = await read(await route.GET(request(`/api/jobs/${JOB_ID}/renders/${missingId}`), context({ id: JOB_ID, renderId: missingId })));
  assert.deepEqual([missing.status, missing.body.code], [404, "not_found"]);
  assert.equal((await route.GET(request(STATUS_URL), context({ id: JOB_ID, renderId: "x" }))).status, 400);
  assert.equal((await route.GET(request(STATUS_URL, { cookie: false }), context(STATUS_IDS))).status, 401);
  await writeFile(path.join(directory, `${RENDER_ID}.json`), JSON.stringify(rendering({ stage: "bogus" })));
  assert.equal((await route.GET(request(STATUS_URL), context(STATUS_IDS))).status, 503);
});

// --- DELETE /renders/:renderId ----------------------------------------------------------------------

test("DELETE cancels a v3 export: 200 when cancelled, 202 while FFmpeg is stopped, 409 when finished", async () => {
  const del = (route, options = {}) => route.DELETE(request(STATUS_URL, { method: "DELETE", ...options }), context(STATUS_IDS)).then(read);
  const cases = [
    [v3Request({ state: "cancelled", cancelled_at: T1, error_code: "cancelled", updated_at: T1 }), 200, null],
    [rendering({ cancel_requested_at: T2 }), 202, null],
    [completed(), 409, "render_finished"],
    [v3Request({ state: "failed", attempts: 1, claimed_at: T1, failed_at: T2, error_code: "render_failed" }), 409, "render_finished"],
  ];
  for (const [value, status, code] of cases) {
    const { calls, runCli } = recorder({ cancel: { exitCode: 0, json: { request: value } } });
    const result = await del(createRenderStatusRoute({ authorize, env: env(), runCli }));
    assert.equal(result.status, status, value.state);
    if (code) assert.equal(result.body.code, code);
    else assert.deepEqual(result.body, renderDtoV3(JOB_ID, value));
    assert.deepEqual(calls.map(({ module, op, payload }) => [module, op, payload]),
      [[RENDER_QUEUE_MODULE, "cancel", { jobId: JOB_ID, renderId: RENDER_ID }]]);
  }
  const { runCli: legacyRunner } = recorder({ cancel: { exitCode: 0, json: { request: { version: "render-request-v1" } } } });
  const legacy = await del(createRenderStatusRoute({ authorize, env: env(), runCli: legacyRunner }));
  assert.deepEqual([legacy.status, legacy.body.code], [409, "not_cancellable"]);
  const { runCli: missingRunner } = recorder({ cancel: { exitCode: 4, json: { error: { code: "not_found" } } } });
  assert.equal((await del(createRenderStatusRoute({ authorize, env: env(), runCli: missingRunner }))).status, 404);
  const { runCli: brokenRunner } = recorder({ cancel: new PythonCliError("spawn_failed") });
  assert.equal((await del(createRenderStatusRoute({ authorize, env: env(), runCli: brokenRunner }))).status, 503);
  const { calls, runCli } = recorder();
  const route = createRenderStatusRoute({ authorize, env: env(), runCli });
  assert.equal((await del(route, { cookie: false })).status, 401);
  assert.equal((await del(createRenderStatusRoute({ authorize, env: env({ POTONGIN_EDITOR_V3: "off" }), runCli }))).status, 404);
  for (const options of [{ origin: "https://evil.example" }, { origin: null }, { fetchSite: "cross-site" }]) {
    assert.equal((await del(route, options)).status, 403);
  }
  assert.equal(calls.length, 0);
});

// --- the real render_queue CLI (spawned like python-cli.mjs: allowlisted env, stdin envelope) --------

function realRunner(extraEnv = {}) {
  return (module, op, payload, options) => new Promise((resolve, reject) => {
    const child = spawn(python(), ["-m", module], { env: childEnv({ ...options.env, ...extraEnv }), stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", () => {});
    child.on("error", () => reject(new PythonCliError("spawn_failed")));
    child.on("close", (code) => {
      if (![0, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].includes(code)) { reject(new PythonCliError("backend_failed")); return; }
      resolve({ exitCode: code, json: JSON.parse(Buffer.concat(out).toString("utf8")) });
    });
    child.stdin.end(JSON.stringify({ op, ...payload }));
  });
}

const BUILD_CLIP = String.raw`
import copy, hashlib, json, sys
from pathlib import Path
repo, root = Path(sys.argv[1]), Path(sys.argv[2])
sys.path[:0] = [str(repo / "src"), str(repo / "tests")]
from support import edit_v2_fixtures as fixtures
from test_edit_v2_store import make_clip
context = fixtures.load_context("c30")
seed = copy.deepcopy(context.seed)
source = b"clip renders web test source"
seed["base"]["source"]["content_sha256"] = hashlib.sha256(source).hexdigest()
clip = make_clip(root, context, seed=seed)
job = root / seed["base"]["job_id"]
(job / "input").mkdir()
(job / "input" / "source.mp4").write_bytes(source)
(job / "output").mkdir()
(job / "job.json").write_text(json.dumps({"id": seed["base"]["job_id"], "sourcePath": str(job / "input" / "source.mp4")}))
print(json.dumps({"jobId": seed["base"]["job_id"], "clipId": seed["clip_id"], "seedEtag": fixtures.etag(seed)}))
`;

function runPython(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(python(), args, { env: { PATH: process.env.PATH, HOME: os.tmpdir() } });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out).toString("utf8"))
      : reject(new Error(Buffer.concat(err).toString("utf8").slice(-2000)))));
  });
}

test("the real queue CLI: estimate, a create without a pinned toolchain (503, reservation released), cancel of nothing", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clip-renders-real-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const clip = JSON.parse(await runPython(["-c", BUILD_CLIP, REPO, root]));
  const events = [];
  const deps = { authorize, env: env({ JOBS_ROOT: root }), runCli: realRunner(), ...storage(events) };
  const route = createClipRendersRoute(deps);
  const url = `/api/jobs/${clip.jobId}/clips/${clip.clipId}/renders`;
  const call = (etag) => route.POST(request(url, { method: "POST", body: JSON.stringify({ editEtag: etag }),
    headers: { "Idempotency-Key": randomUUID() } }), context({ id: clip.jobId, clipId: clip.clipId })).then(read);
  const unknown = await call("e".repeat(64));
  assert.deepEqual([unknown.status, unknown.body.code], [409, "revision_conflict"]);
  assert.equal(events.length, 0);  // no reservation for an unknown revision
  const result = await call(clip.seedEtag);
  // The repository ships no resources/toolchain.json (the image build writes it, E10): no key.
  assert.deepEqual([result.status, result.body.code], [503, "backend_unavailable"]);
  assert.equal(events[0][0], "reserve");
  assert.ok(events[0][2] > 72_000_000n);  // ~72 s of output at 8 Mbit/s
  assert.deepEqual(events.at(-1), ["release", RESERVATION_ID, RESERVATION_TOKEN, "failed"]);
  const status = createRenderStatusRoute(deps);
  const missing = randomUUID();
  const cancelled = await status.DELETE(request(`/api/jobs/${clip.jobId}/renders/${missing}`, { method: "DELETE" }),
    context({ id: clip.jobId, renderId: missing }));
  assert.equal(cancelled.status, 404);
});

// --- E11 for the render routes: through web/lib/python-cli.mjs once the queue module is allowed -------

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
process.stdout.write(JSON.stringify(envelope.op === "estimate" ? { bytes: "1" } : { error: { code: "not_found" } }));
process.exitCode = envelope.op === "estimate" ? 0 : 4;
`;

test("QG-SEC: the render queue children see no secret in /proc/self/environ",
  { skip: PYTHON_CLI_MODULES.includes(RENDER_QUEUE_MODULE) ? false
    : "web/lib/python-cli.mjs does not list ai_clipper.render_queue yet (T2.2 request to T2.Z)" },
  async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "clip-renders-env-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const fake = path.join(dir, "python.mjs");
    await writeFile(fake, `#!${process.execPath}\n${FAKE_PYTHON}`);
    await chmod(fake, 0o755);
    const events = [];
    const deps = { authorize, env: env({ JOBS_ROOT: dir, ...SECRETS }), pythonBin: fake, ...storage(events) };
    assert.equal((await post(createClipRendersRoute(deps))).status, 404);
    const cancelled = await createRenderStatusRoute(deps).DELETE(request(STATUS_URL, { method: "DELETE" }), context(STATUS_IDS));
    assert.equal(cancelled.status, 404);
    for (const op of ["estimate", "create", "cancel"]) {
      let environ;
      try { environ = JSON.parse(await readFile(path.join(dir, `environ-${op}.json`), "utf8")); } catch { continue; }
      for (const [name, value] of Object.entries(SECRETS)) {
        assert.equal(environ[name], undefined, `${op}: ${name}`);
        assert.ok(!Object.values(environ).includes(value));
      }
    }
  });
