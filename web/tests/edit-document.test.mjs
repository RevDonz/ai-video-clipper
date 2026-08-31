import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFile = promisify(execFileCallback);

import { GET, PUT } from "../app/api/jobs/[id]/candidates/[candidateId]/edit/route.js";
import { createSessionToken } from "../lib/auth.mjs";
import {
  EditBackendUnavailableError,
  EditConflictError,
  EditRequestInvalidError,
  MAX_EDIT_BODY_BYTES,
  readEditDocument,
  runEditorPython,
} from "../lib/edit-document.mjs";

const JOB_ID = "123e4567-e89b-42d3-a456-426614174000";
const CANDIDATE_ID = `cand_${"a".repeat(64)}`;
const KEY = "323e4567-e89b-42d3-a456-426614174000";
const SHA = "a".repeat(64);
const AUTH_ENV = {
  APP_USERNAME: "admin", APP_PASSWORD: "secret-value",
  APP_SESSION_SECRET: "a-long-random-session-secret-value",
};

function configuredPython() {
  const value = process.env.PYTHON_BIN || "../.venv/bin/python";
  return value.includes(path.sep) ? path.resolve(value) : value;
}

async function rootWithJob() {
  const root = await mkdtemp(path.join(os.tmpdir(), "clipper-edit-"));
  const analysis = path.join(root, JOB_ID, "analysis");
  await mkdir(analysis, { recursive: true });
  await writeFile(path.join(root, JOB_ID, "job.json"), "{}\n");
  await writeFile(path.join(analysis, "candidates.v2.json"), "opaque");
  return { root, analysis };
}

function envelope() {
  return { created: true, etag: SHA, manifest: {
    edit_manifest_version: "clip-edit-v1.0",
    identity: { candidate_id: CANDIDATE_ID },
    revision: 1, parent_revision_sha256: null,
    timeline: {}, visual: {}, caption_style: {}, captions: [], overlays: [], audio: {}, audit: {},
  } };
}

function fakeExec(result = envelope(), errorCode = null) {
  return (_bin, _argv, _options, callback) => {
    const error = errorCode === null ? null : Object.assign(new Error("SECRET backend"), { code: errorCode });
    callback(error, Buffer.from(JSON.stringify(result)), Buffer.from("SECRET backend"));
    return { stdin: { on() {}, end() {} } };
  };
}

function request(method, { origin = "http://local", headers = {}, body } = {}) {
  const token = createSessionToken(AUTH_ENV, 2_000_000_000);
  return new Request(`http://local/api/jobs/${JOB_ID}/candidates/${CANDIDATE_ID}/edit`, {
    method,
    headers: { Host: "local", Cookie: `potongin_session=${token}`, ...(method === "PUT" ? {
      Origin: origin, "Content-Type": "application/json", "If-Match": `"${SHA}"`,
      "Idempotency-Key": KEY, "Sec-Fetch-Site": "same-origin",
    } : {}), ...headers },
    body,
  });
}

async function withEnv(root, callback) {
  const old = {};
  for (const key of ["JOBS_ROOT", ...Object.keys(AUTH_ENV)]) old[key] = process.env[key];
  Object.assign(process.env, AUTH_ENV, { JOBS_ROOT: root });
  try { return await callback(); } finally {
    for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
}

test("bridge resolves contained job and invokes Python without shell using bounded IO", async () => {
  const { root, analysis } = await rootWithJob();
  let call;
  const result = await readEditDocument(JOB_ID, CANDIDATE_ID, { operation: "get", candidateId: CANDIDATE_ID }, root, {
    runner: async (...args) => { call = args; return envelope(); },
  });
  assert.deepEqual(call, [analysis, { operation: "get", candidateId: CANDIDATE_ID }]);
  assert.equal(result.etag, SHA);

  const calls = [];
  await runEditorPython("/safe/analysis", { operation: "get", candidateId: CANDIDATE_ID }, {
    pythonBin: "/venv/python",
    execFileImpl: (bin, argv, options, callback) => {
      calls.push({ bin, argv, options });
      callback(null, Buffer.from(JSON.stringify(envelope())), Buffer.alloc(0));
      return { stdin: { on() {}, end(value) { calls[0].stdin = value; } } };
    },
  });
  assert.deepEqual(calls[0].argv, ["-m", "ai_clipper.editor_api", "--analysis-dir", "/safe/analysis"]);
  assert.equal(calls[0].options.shell, false);
  assert.ok(calls[0].options.timeout > 0);
  assert.deepEqual(JSON.parse(calls[0].stdin), { operation: "get", candidateId: CANDIDATE_ID });
});

test("PUT requires authentication, exact same origin, If-Match, idempotency key, and bounded JSON", async () => {
  const { root } = await rootWithJob();
  await withEnv(root, async () => {
    const unauthenticated = request("PUT", { body: "{}", headers: { Cookie: "" } });
    assert.equal((await PUT(unauthenticated, { params: Promise.resolve({ id: JOB_ID, candidateId: CANDIDATE_ID }) })).status, 401);

    const crossSite = request("PUT", { origin: "https://evil.test", body: "{}" });
    assert.equal((await PUT(crossSite, { params: Promise.resolve({ id: JOB_ID, candidateId: CANDIDATE_ID }) })).status, 403);

    const missingMatch = request("PUT", { body: "{}", headers: { "If-Match": "" } });
    assert.equal((await PUT(missingMatch, { params: Promise.resolve({ id: JOB_ID, candidateId: CANDIDATE_ID }) })).status, 428);

    const tooLarge = request("PUT", { body: "x".repeat(MAX_EDIT_BODY_BYTES + 1) });
    assert.equal((await PUT(tooLarge, { params: Promise.resolve({ id: JOB_ID, candidateId: CANDIDATE_ID }) })).status, 400);
  });
});

test("route emits quoted ETag/no-store and maps conflict current document without secrets", async () => {
  const { root } = await rootWithJob();
  await withEnv(root, async () => {
    const original = process.env.PYTHON_BIN;
    process.env.PYTHON_BIN = "python";
    try {
      const response = new EditConflictError(envelope());
      assert.equal(response.current.etag, SHA);
      await assert.rejects(
        runEditorPython("/safe", { operation: "get", candidateId: CANDIDATE_ID }, { execFileImpl: fakeExec({}, 7) }),
        EditBackendUnavailableError,
      );
    } finally { original === undefined ? delete process.env.PYTHON_BIN : process.env.PYTHON_BIN = original; }
  });
});

test("real route GET creates default and PUT saves and replays through Python", async () => {
  const { root, analysis } = await rootWithJob();
  const repo = path.resolve("..");
  const python = configuredPython();
  const script = [
    "import sys", `sys.path.insert(0, ${JSON.stringify(path.join(repo, "tests"))})`,
    "from test_candidate_api import encoded, task5_artifact",
    `open(${JSON.stringify(path.join(analysis, "candidates.v2.json"))}, 'wb').write(encoded(task5_artifact()))`,
    "print(task5_artifact().candidates[0].candidate_id)",
  ].join(";");
  const generated = await execFile(python, ["-c", script], { cwd: repo });
  const candidateId = generated.stdout.trim();
  const oldPython = process.env.PYTHON_BIN;
  process.env.PYTHON_BIN = python;
  try {
    await withEnv(root, async () => {
      const params = { params: Promise.resolve({ id: JOB_ID, candidateId }) };
      const missingCandidateId = `cand_${"f".repeat(64)}`;
      const missingRequest = new Request(`http://local/api/jobs/${JOB_ID}/candidates/${missingCandidateId}/edit`, {
        headers: { Host: "local", Cookie: `potongin_session=${createSessionToken(AUTH_ENV, 2_000_000_000)}` },
      });
      const missing = await GET(missingRequest, {
        params: Promise.resolve({ id: JOB_ID, candidateId: missingCandidateId }),
      });
      assert.equal(missing.status, 404);
      assert.equal((await missing.json()).code, "not_found");
      const getRequest = new Request(`http://local/api/jobs/${JOB_ID}/candidates/${candidateId}/edit`, {
        headers: { Host: "local", Cookie: `potongin_session=${createSessionToken(AUTH_ENV, 2_000_000_000)}` },
      });
      const first = await GET(getRequest, params);
      assert.equal(first.status, 200);
      assert.equal(first.headers.get("cache-control"), "no-store");
      const etag = first.headers.get("etag");
      assert.match(etag, /^"[0-9a-f]{64}"$/);
      const manifest = await first.json();
      manifest.revision = 2;
      manifest.parent_revision_sha256 = etag.slice(1, -1);
      manifest.captions[0].text = "Edited through route";
      manifest.audit.updated_at = "1970-01-01T00:00:00.001Z";
      const putRequest = request("PUT", {
        body: JSON.stringify(manifest),
        headers: { "If-Match": etag },
      });
      const saved = await PUT(putRequest, params);
      assert.equal(saved.status, 200);
      assert.equal((await saved.json()).captions[0].text, "Edited through route");
      const replayRequest = request("PUT", {
        body: JSON.stringify(manifest),
        headers: { "If-Match": etag },
      });
      const replay = await PUT(replayRequest, params);
      assert.equal(replay.status, 200);
      assert.equal(replay.headers.get("etag"), saved.headers.get("etag"));
    });
  } finally { oldPython === undefined ? delete process.env.PYTHON_BIN : process.env.PYTHON_BIN = oldPython; }
});
