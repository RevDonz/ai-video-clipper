import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { GET } from "../app/api/jobs/[id]/candidates/[candidateId]/caption-cues/route.js";
import { createSessionToken } from "../lib/auth.mjs";
import {
  MAX_TRANSCRIPT_BYTES,
  CaptionCuesInvalidError,
  readCaptionCues,
  runCaptionCueSanitizer,
  validateCaptionCues,
} from "../lib/caption-cues.mjs";

const execFile = promisify(execFileCallback);
const JOB_ID = "123e4567-e89b-42d3-a456-426614174000";
const CANDIDATE_ID = "cand_" + "a".repeat(64);
const AUTH_ENV = { APP_USERNAME: "admin", APP_PASSWORD: "secret-value", APP_SESSION_SECRET: "a-long-random-session-secret-value" };

function configuredPython() {
  const value = process.env.PYTHON_BIN || "../.venv/bin/python";
  return value.includes(path.sep) ? path.resolve(value) : value;
}

function dto(candidateId = CANDIDATE_ID) {
  return {
    candidateId,
    candidateArtifactSha256: "b".repeat(64),
    selectionVersion: "selection-v2.0",
    timingProvenance: "segment-v1",
    wordTiming: false,
    cues: [{ id: "cue_000000_1234567890abcdef", start: 0, end: 2, text: "Halo dunia", originalTextSha256: "c".repeat(64) }],
  };
}

async function fixture({ artifact = Buffer.from("opaque artifact"), transcript = Buffer.from('{"language":"id","segments":[]}') } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "clipper-cues-"));
  const job = path.join(root, JOB_ID);
  await mkdir(path.join(job, "analysis"), { recursive: true });
  await mkdir(path.join(job, "output"), { recursive: true });
  await writeFile(path.join(job, "job.json"), "{}\n");
  await writeFile(path.join(job, "analysis", "candidates.v2.json"), artifact);
  await writeFile(path.join(job, "output", "transcript.json"), transcript);
  return { root, job };
}

async function invoke(root, { id = JOB_ID, candidateId = CANDIDATE_ID, authenticated = true, pythonBin } = {}) {
  const previous = {};
  for (const name of ["JOBS_ROOT", "PYTHON_BIN", ...Object.keys(AUTH_ENV)]) previous[name] = process.env[name];
  Object.assign(process.env, AUTH_ENV, { JOBS_ROOT: root });
  if (pythonBin) process.env.PYTHON_BIN = pythonBin;
  const headers = authenticated ? { Cookie: `potongin_session=${createSessionToken(AUTH_ENV, 2_000_000_000)}` } : {};
  try {
    return await GET(new Request(`http://local/api/jobs/${id}/candidates/${candidateId}/caption-cues`, { headers }), {
      params: Promise.resolve({ id, candidateId }),
    });
  } finally {
    for (const [name, value] of Object.entries(previous)) value === undefined ? delete process.env[name] : process.env[name] = value;
  }
}

test("secure reader sends bounded artifact and transcript bytes to sanitizer without paths", async () => {
  const artifact = Buffer.from("artifact bytes");
  const transcript = Buffer.from("transcript bytes");
  const { root } = await fixture({ artifact, transcript });
  let received;
  const result = await readCaptionCues(JOB_ID, CANDIDATE_ID, root, {
    sanitizerRunner: async (...args) => { received = args; return dto(); },
  });
  assert.deepEqual(received, [artifact, transcript, CANDIDATE_ID]);
  assert.deepEqual(result, dto());
});

test("strict caption DTO rejects source leakage, malformed hashes, overlap, and word timing", () => {
  for (const mutate of [
    (value) => { value.source = "/private/video.mp4"; },
    (value) => { value.candidateArtifactSha256 = "bad"; },
    (value) => { value.wordTiming = true; },
    (value) => value.cues.push({ ...value.cues[0], id: "cue_000001_1234567890abcdef", start: 1, end: 3 }),
    (value) => { value.cues[0].privatePath = "/secret"; },
  ]) {
    const value = structuredClone(dto());
    mutate(value);
    assert.throws(() => validateCaptionCues(value), CaptionCuesInvalidError);
  }
});

test("route enforces authentication, job UUID, candidate ID and no-store", async () => {
  const { root } = await fixture();
  for (const [options, status] of [
    [{ authenticated: false }, 401],
    [{ id: "../../etc/passwd" }, 400],
    [{ candidateId: "../private" }, 400],
  ]) {
    const response = await invoke(root, options);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("missing job is 404, invalid artifacts are 422, unavailable sanitizer is 503", async () => {
  const missingRoot = await mkdtemp(path.join(os.tmpdir(), "clipper-cues-missing-"));
  assert.equal((await invoke(missingRoot)).status, 404);

  const invalid = await fixture();
  await assert.rejects(
    readCaptionCues(JOB_ID, CANDIDATE_ID, invalid.root, { sanitizerRunner: async () => { throw new CaptionCuesInvalidError(); } }),
    CaptionCuesInvalidError,
  );
  assert.equal((await invoke(invalid.root, { pythonBin: configuredPython() })).status, 422);
  assert.equal((await invoke(invalid.root, { pythonBin: "/definitely/missing/python" })).status, 503);
});

test("artifact and transcript size limits are checked before sanitizer invocation", async () => {
  for (const target of ["analysis/candidates.v2.json", "output/transcript.json"]) {
    const fx = await fixture();
    await writeFile(path.join(fx.job, target), Buffer.alloc(MAX_TRANSCRIPT_BYTES + 1));
    let invoked = false;
    await assert.rejects(readCaptionCues(JOB_ID, CANDIDATE_ID, fx.root, { sanitizerRunner: async () => { invoked = true; } }), CaptionCuesInvalidError);
    assert.equal(invoked, false);
  }
});

test("job and artifact directory/file symlinks plus FD containment escapes are rejected", async (t) => {
  for (const target of ["analysis", "analysis/candidates.v2.json", "output", "output/transcript.json"]) {
    await t.test(target, async () => {
      const fx = await fixture();
      const outside = path.join(await mkdtemp(path.join(os.tmpdir(), "clipper-cues-out-")), "outside");
      if (["analysis", "output"].includes(target)) await mkdir(outside); else await writeFile(outside, "private");
      await (await import("node:fs/promises")).rm(path.join(fx.job, target), { recursive: true });
      await symlink(outside, path.join(fx.job, target));
      await assert.rejects(readCaptionCues(JOB_ID, CANDIDATE_ID, fx.root, { sanitizerRunner: async () => dto() }), CaptionCuesInvalidError);
    });
  }
  const fx = await fixture();
  let calls = 0;
  await assert.rejects(readCaptionCues(JOB_ID, CANDIDATE_ID, fx.root, {
    resolveFdPath: async () => (++calls === 1 ? path.join(fx.job, "job.json") : "/tmp/outside"),
    sanitizerRunner: async () => dto(),
  }), CaptionCuesInvalidError);
});

test("actual Node to Python sanitizer returns cues and stale candidate is 404", async () => {
  const repo = path.resolve("..");
  const python = configuredPython();
  const script = "from test_candidate_api import encoded,task5_artifact; import sys; sys.stdout.buffer.write(encoded()); print('\\n'+task5_artifact().candidates[0].candidate_id)";
  const generated = await execFile(python, ["-c", script], { cwd: repo, env: { ...process.env, PYTHONPATH: `${path.join(repo, "src")}:${path.join(repo, "tests")}` }, encoding: "buffer" });
  const split = generated.stdout.lastIndexOf(0x0a, generated.stdout.length - 2);
  const artifact = generated.stdout.subarray(0, split);
  const candidateId = generated.stdout.subarray(split + 1).toString().trim();
  const transcript = Buffer.from(JSON.stringify({ language: "id", segments: [{ start: 0, end: 4, text: "Pembuka aman" }] }));
  const fx = await fixture({ artifact, transcript });

  const response = await invoke(fx.root, { candidateId, pythonBin: python });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.candidateId, candidateId);
  assert.equal(body.cues[0].text, "Pembuka aman");
  assert.equal(body.source, undefined);
  assert.equal(response.headers.get("cache-control"), "no-store");

  const stale = await invoke(fx.root, { candidateId: "cand_" + "0".repeat(64), pythonBin: python });
  assert.equal(stale.status, 404);
});

test("execFile sanitizer reports missing executable as unavailable", async () => {
  await assert.rejects(runCaptionCueSanitizer(Buffer.from("a"), Buffer.from("b"), CANDIDATE_ID, { pythonBin: "/definitely/missing/python" }), /unavailable/i);
});
