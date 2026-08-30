import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { GET, PUT, feedbackErrorResponse } from "../app/api/jobs/[id]/candidate-feedback/route.js";
import { createSessionToken } from "../lib/auth.mjs";
import {
  FeedbackArtifactInvalidError,
  FeedbackBackendUnavailableError,
  FeedbackConflictError,
  FeedbackRequestInvalidError,
  FeedbackSelectionChangedError,
  FeedbackTimeoutError,
  MAX_FEEDBACK_COMMAND_BYTES,
  readCandidateFeedback,
  runFeedbackPython,
} from "../lib/candidate-feedback.mjs";

const execFile = promisify(execFileCallback);
const JOB_ID = "123e4567-e89b-42d3-a456-426614174000";
const OTHER_ID = "223e4567-e89b-42d3-a456-426614174000";
const CANDIDATE_ID = `cand_${"a".repeat(64)}`;
const REQUEST_ID = "323e4567-e89b-42d3-a456-426614174000";
const AUTH_ENV = {
  APP_USERNAME: "admin",
  APP_PASSWORD: "secret-value",
  APP_SESSION_SECRET: "a-long-random-session-secret-value",
};

async function rootWithJob() {
  const root = await mkdtemp(path.join(os.tmpdir(), "clipper-feedback-"));
  const job = path.join(root, JOB_ID);
  const analysis = path.join(job, "analysis");
  await mkdir(analysis, { recursive: true });
  await writeFile(path.join(job, "job.json"), "{}\n");
  await writeFile(path.join(analysis, "candidates.v2.json"), "opaque");
  return { root, job, analysis };
}

function state() {
  return {
    available: true,
    selectionVersion: "selection-v2.0",
    candidateArtifactSha256: "a".repeat(64),
    latestByCandidate: {},
    eventCount: 0,
  };
}

function body(overrides = {}) {
  return {
    candidateId: CANDIDATE_ID,
    decision: "accepted",
    note: "good",
    clientRequestId: REQUEST_ID,
    ...overrides,
  };
}

function request(root, method = "GET", id = JOB_ID, value = undefined, authenticated = true) {
  const headers = {};
  if (authenticated) {
    headers.Cookie = `potongin_session=${createSessionToken(AUTH_ENV, 2_000_000_000)}`;
  }
  if (value !== undefined) headers["Content-Type"] = "application/json";
  return new Request(`http://local/api/jobs/${id}/candidate-feedback`, {
    method, headers, body: value === undefined ? undefined : value,
  });
}

async function invoke(root, method, { id = JOB_ID, value, authenticated = true } = {}) {
  const previous = {};
  for (const name of ["JOBS_ROOT", "PYTHON_BIN", ...Object.keys(AUTH_ENV)]) previous[name] = process.env[name];
  Object.assign(process.env, AUTH_ENV, { JOBS_ROOT: root, PYTHON_BIN: process.env.PYTHON_BIN || "python" });
  try {
    const handler = method === "GET" ? GET : PUT;
    return await handler(request(root, method, id, value, authenticated), { params: Promise.resolve({ id }) });
  } finally {
    for (const [name, old] of Object.entries(previous)) {
      if (old === undefined) delete process.env[name]; else process.env[name] = old;
    }
  }
}

test("secure job resolver passes only canonical analysis path, operation, and bounded raw JSON", async () => {
  const { root, analysis } = await rootWithJob();
  let received;
  const raw = Buffer.from(JSON.stringify(body()));
  const result = await readCandidateFeedback(JOB_ID, "put", raw, root, {
    runner: async (...args) => { received = args; return { created: true, event: {
      eventId: REQUEST_ID, clientRequestId: REQUEST_ID, candidateId: CANDIDATE_ID,
      decision: "accepted", note: "good", createdAt: "2026-08-30T00:00:00.000Z",
    }, state: state() }; },
  });
  assert.deepEqual(received, [analysis, "put", raw]);
  assert.equal(result.created, true);
});

test("reader rejects invalid UUID before filesystem and job/analysis/artifact symlinks", async (t) => {
  let called = false;
  await assert.rejects(
    readCandidateFeedback("../../etc/passwd", "get", Buffer.alloc(0), "/definitely/missing", {
      runner: async () => { called = true; },
    }),
    FeedbackRequestInvalidError,
  );
  assert.equal(called, false);

  await t.test("analysis symlink", async () => {
    const { root, job } = await rootWithJob();
    const outside = await mkdtemp(path.join(os.tmpdir(), "feedback-outside-"));
    await writeFile(path.join(outside, "candidates.v2.json"), "x");
    await (await import("node:fs/promises")).rm(path.join(job, "analysis"), { recursive: true });
    await symlink(outside, path.join(job, "analysis"));
    await assert.rejects(readCandidateFeedback(JOB_ID, "get", Buffer.alloc(0), root), FeedbackArtifactInvalidError);
  });
});

test("python bridge uses argv without shell, bounded buffers, timeout, and strict output", async () => {
  const calls = [];
  const fakeExec = (bin, argv, options, callback) => {
    calls.push({ bin, argv, options });
    callback(null, Buffer.from(JSON.stringify(state())), Buffer.alloc(0));
    return { stdin: { on() {}, end(value) { calls[0].stdin = value; } } };
  };
  assert.deepEqual(await runFeedbackPython("/safe/analysis", "get", Buffer.alloc(0), {
    pythonBin: "/venv/python", execFileImpl: fakeExec,
  }), state());
  assert.deepEqual(calls[0].argv, ["-m", "ai_clipper.candidate_feedback", "--analysis-dir", "/safe/analysis", "--operation", "get"]);
  assert.equal(calls[0].options.shell, false);
  assert.ok(calls[0].options.timeout > 0);
  assert.ok(calls[0].options.maxBuffer <= 8 * 1024 * 1024);

  const latest = state();
  latest.eventCount = 2;
  latest.latestByCandidate[CANDIDATE_ID] = {
    eventId: "423e4567-e89b-42d3-a456-426614174000",
    clientRequestId: "523e4567-e89b-42d3-a456-426614174000",
    candidateId: CANDIDATE_ID,
    decision: "rejected",
    note: "later",
    createdAt: "2026-08-30T00:01:00.000Z",
  };
  const oldEvent = {
    eventId: REQUEST_ID, clientRequestId: REQUEST_ID, candidateId: CANDIDATE_ID,
    decision: "accepted", note: "good", createdAt: "2026-08-30T00:00:00.000Z",
  };
  const replayExec = (_bin, _argv, _options, callback) => {
    callback(null, Buffer.from(JSON.stringify({ created: false, event: oldEvent, state: latest })), Buffer.alloc(0));
    return { stdin: { on() {}, end() {} } };
  };
  const replay = await runFeedbackPython("/safe/analysis", "put", Buffer.from(JSON.stringify(body())), {
    execFileImpl: replayExec,
  });
  assert.equal(replay.created, false);
  assert.equal(replay.event.eventId, REQUEST_ID);

  await assert.rejects(
    runFeedbackPython("/safe/analysis", "put", Buffer.alloc(MAX_FEEDBACK_COMMAND_BYTES + 1)),
    FeedbackRequestInvalidError,
  );
});

test("Unicode note validation counts scalar values and rejects controls", async () => {
  const event = {
    eventId: REQUEST_ID, clientRequestId: REQUEST_ID, candidateId: CANDIDATE_ID,
    decision: "accepted", note: "😀".repeat(500), createdAt: "2026-08-30T00:00:00.000Z",
  };
  const valid = { created: true, event, state: { ...state(), eventCount: 1, latestByCandidate: { [CANDIDATE_ID]: event } } };
  const bridge = (value) => runFeedbackPython("/safe/analysis", "put", Buffer.from("{}"), {
    execFileImpl: (_bin, _argv, _options, callback) => {
      callback(null, Buffer.from(JSON.stringify(value)), Buffer.alloc(0));
      return { stdin: { on() {}, end() {} } };
    },
  });
  assert.equal((await bridge(valid)).event.note, "😀".repeat(500));
  const tooLongEvent = { ...event, note: "😀".repeat(501) };
  await assert.rejects(
    bridge({ ...valid, event: tooLongEvent, state: { ...valid.state, latestByCandidate: { [CANDIDATE_ID]: tooLongEvent } } }),
    FeedbackArtifactInvalidError,
  );
  const controlEvent = { ...event, note: "bad\n" };
  await assert.rejects(
    bridge({ ...valid, event: controlEvent, state: { ...valid.state, latestByCandidate: { [CANDIDATE_ID]: controlEvent } } }),
    FeedbackArtifactInvalidError,
  );
});

test("bridge and route map backend and generation errors without stderr leakage", async () => {
  const failing = (code) => (_bin, _argv, _options, callback) => {
    const error = Object.assign(new Error("SECRET stderr details"), { code });
    callback(error, Buffer.alloc(0), Buffer.from("SECRET stderr details"));
    return { stdin: { on() {}, end() {} } };
  };
  await assert.rejects(
    runFeedbackPython("/safe/analysis", "get", Buffer.alloc(0), { execFileImpl: failing(7) }),
    FeedbackBackendUnavailableError,
  );
  await assert.rejects(
    runFeedbackPython("/safe/analysis", "get", Buffer.alloc(0), { execFileImpl: failing(8) }),
    FeedbackSelectionChangedError,
  );
  for (const [error, status, code] of [
    [new FeedbackConflictError(), 409, "idempotency_conflict"],
    [new FeedbackSelectionChangedError(), 409, "selection_changed"],
    [new FeedbackBackendUnavailableError(), 503, "backend_unavailable"],
  ]) {
    const result = feedbackErrorResponse(error);
    assert.equal(result.status, status);
    const payload = await result.json();
    assert.equal(payload.code, code);
    assert.doesNotMatch(JSON.stringify(payload), /SECRET|stderr/i);
  }
});

test("route authentication, UUID, body bounds, missing artifact, invalid artifact, and no-store statuses", async () => {
  const { root } = await rootWithJob();
  const denied = await invoke(root, "GET", { authenticated: false });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get("cache-control"), "no-store");

  const invalidId = await invoke(root, "GET", { id: "not-a-uuid" });
  assert.equal(invalidId.status, 400);
  const missing = await invoke(root, "GET", { id: OTHER_ID });
  assert.equal(missing.status, 404);
  const malformed = await invoke(root, "GET");
  assert.equal(malformed.status, 422);
  assert.equal(malformed.headers.get("cache-control"), "no-store");

  const tooLarge = await invoke(root, "PUT", { value: "x".repeat(MAX_FEEDBACK_COMMAND_BYTES + 1) });
  assert.equal(tooLarge.status, 400);

  const conflict = feedbackErrorResponse(new FeedbackConflictError());
  const timeout = feedbackErrorResponse(new FeedbackTimeoutError());
  assert.equal(conflict.status, 409);
  assert.equal(timeout.status, 503);
  assert.equal(conflict.headers.get("cache-control"), "no-store");
  assert.equal(timeout.headers.get("cache-control"), "no-store");
});

test("real Python GET/PUT integration is append-only and idempotent", async (t) => {
  const configuredPython = process.env.PYTHON_BIN || "python";
  const python = configuredPython.includes(path.sep) ? path.resolve(configuredPython) : configuredPython;
  try {
    await execFile(python, ["-c", "import ai_clipper.candidate_feedback"]);
  } catch {
    t.skip("installed ai_clipper package unavailable");
    return;
  }
  const { root, analysis } = await rootWithJob();
  const repo = path.resolve("..");
  const script = [
    "import sys", `sys.path.insert(0, ${JSON.stringify(path.join(repo, "tests"))})`,
    "from test_candidate_api import encoded, task5_artifact",
    `open(${JSON.stringify(path.join(analysis, "candidates.v2.json"))}, 'wb').write(encoded(task5_artifact()))`,
  ].join(";");
  await execFile(python, ["-c", script], { cwd: repo });
  const idResult = await execFile(python, ["-c", script.replace(
    `open(${JSON.stringify(path.join(analysis, "candidates.v2.json"))}, 'wb').write(encoded(task5_artifact()))`,
    "print(task5_artifact().candidates[0].candidate_id)",
  )], { cwd: repo });
  const candidateId = idResult.stdout.trim();
  const requestValue = JSON.stringify(body({ candidateId }));

  const first = await invoke(root, "PUT", { value: requestValue });
  assert.equal(first.status, 201);
  const second = await invoke(root, "PUT", { value: requestValue });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).state.eventCount, 1);
  const conflictValue = JSON.stringify(body({ candidateId, decision: "rejected" }));
  const conflict = await invoke(root, "PUT", { value: conflictValue });
  assert.equal(conflict.status, 409);
  const get = await invoke(root, "GET");
  assert.equal(get.status, 200);
  assert.equal((await get.json()).eventCount, 1);

  const emoji500 = JSON.stringify(body({
    candidateId,
    clientRequestId: "623e4567-e89b-42d3-a456-426614174000",
    note: "😀".repeat(500),
  }));
  const emojiAccepted = await invoke(root, "PUT", { value: emoji500 });
  assert.equal(emojiAccepted.status, 201);
  assert.equal((await emojiAccepted.json()).event.note, "😀".repeat(500));
  const emoji501 = JSON.stringify(body({
    candidateId,
    clientRequestId: "723e4567-e89b-42d3-a456-426614174000",
    note: "😀".repeat(501),
  }));
  const emojiRejected = await invoke(root, "PUT", { value: emoji501 });
  assert.equal(emojiRejected.status, 400);
  assert.equal((await emojiRejected.json()).code, "invalid_request");
});
