import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { GET } from "../app/api/jobs/[id]/candidates/route.js";
import {
  MAX_ARTIFACT_BYTES,
  CandidatesArtifactInvalidError,
  readBoundedArtifact,
  readCandidatesPresentation,
  runCandidateValidator,
  validatePresentation,
} from "../lib/candidates.mjs";
import { createSessionToken } from "../lib/auth.mjs";

const execFile = promisify(execFileCallback);
const JOB_ID = "123e4567-e89b-42d3-a456-426614174000";
const OTHER_JOB_ID = "223e4567-e89b-42d3-a456-426614174000";
const AUTH_ENV = {
  APP_USERNAME: "admin",
  APP_PASSWORD: "secret-value",
  APP_SESSION_SECRET: "a-long-random-session-secret-value",
};

function validPresentation() {
  return {
    available: true,
    selectionVersion: "selection-v2.0",
    provenance: ["selection-v2.0", "media-features-v1"],
    candidates: [{
      id: "candidate-one",
      start: 0,
      end: 30,
      duration: 30,
      text: "Why are cloud bills high?",
      profile: "standard",
      score: 5,
      reasons: ["Hook berbentuk pertanyaan langsung."],
      topicTerms: ["cloud"],
      rank: 1,
      displayOrder: 1,
      features: {
        hookStrength: 8,
        hookRelevance: 0,
        standaloneContext: 6,
        payoffCompleteness: 9,
        informationDensity: 5,
        emotionEnergy: 0,
        dialogueDynamics: 0,
        visualActivity: 0,
        topicValue: 4,
        boundaryQuality: 10,
        penalty: 0,
      },
      scoreBreakdown: {
        contributions: [{ name: "hook_strength", value: 0, weight: 1, weightedValue: 0, source: "text" }],
        activeWeightTotal: 1,
        weightedPrePenaltyScore: 0,
        penaltyDeduction: 0,
        diversityDeduction: 0,
        finalScore: 5,
      },
      measuredMedia: {
        intervalStart: 0,
        intervalEnd: 30,
        measurements: {
          audioEnergy: 0,
          energyChange: null,
          sceneActivity: 2,
          motion: 0,
          faceActivity: 6,
        },
      },
    }],
  };
}

async function rootWithJob(id = JOB_ID) {
  const root = await mkdtemp(path.join(os.tmpdir(), "clipper-candidates-"));
  const job = path.join(root, id);
  await mkdir(job, { recursive: true });
  await writeFile(path.join(job, "job.json"), "{}\n");
  return { root, job };
}

async function publish(root, raw = Buffer.from("artifact bytes"), id = JOB_ID) {
  const analysis = path.join(root, id, "analysis");
  await mkdir(analysis, { recursive: true });
  await writeFile(path.join(analysis, "candidates.v2.json"), raw);
}

function request(id = JOB_ID, authenticated = true) {
  const headers = {};
  if (authenticated) {
    const token = createSessionToken(AUTH_ENV, 2_000_000_000);
    headers.Cookie = `potongin_session=${token}`;
  }
  return new Request(`http://local/api/jobs/${id}/candidates`, { headers });
}

async function invoke(root, { id = JOB_ID, authenticated = true } = {}) {
  const previous = {};
  for (const name of ["JOBS_ROOT", ...Object.keys(AUTH_ENV)]) previous[name] = process.env[name];
  Object.assign(process.env, AUTH_ENV, { JOBS_ROOT: root });
  try {
    return await GET(request(id, authenticated), { params: Promise.resolve({ id }) });
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("secure reader passes bounded artifact bytes to injected authoritative validator", async () => {
  const { root } = await rootWithJob();
  const raw = Buffer.from("opaque task5 artifact");
  await publish(root, raw);
  let received;

  const result = await readCandidatesPresentation(JOB_ID, root, {
    validatorRunner: async (value) => {
      received = value;
      return validPresentation();
    },
  });

  assert.deepEqual(received, raw);
  assert.deepEqual(result, validPresentation());
});

test("missing artifact is backward compatible and never invokes validator", async () => {
  const { root } = await rootWithJob();
  let invoked = false;
  const result = await readCandidatesPresentation(JOB_ID, root, {
    validatorRunner: async () => { invoked = true; },
  });
  assert.deepEqual(result, { available: false, candidates: [] });
  assert.equal(invoked, false);
});

test("malformed validator output and validator timeout are sanitized", async (t) => {
  for (const [name, runner] of [
    ["malformed output", async () => ({ available: true, candidates: [], source: "secret" })],
    ["timeout", async () => { throw Object.assign(new Error("secret timeout detail"), { code: "ETIMEDOUT" }); }],
  ]) {
    await t.test(name, async () => {
      const { root } = await rootWithJob();
      await publish(root);
      await assert.rejects(
        readCandidatesPresentation(JOB_ID, root, { validatorRunner: runner }),
        (error) => error instanceof CandidatesArtifactInvalidError && !error.message.includes("secret"),
      );
    });
  }
});

test("strict output DTO rejects raw provenance and extra sensitive fields", () => {
  for (const mutate of [
    (value) => value.provenance.push("Task 3 raw provenance"),
    (value) => { value.source = "private"; },
    (value) => { value.candidates[0].analysisId = "internal"; },
    (value) => { value.candidates[0].scoreBreakdown.mediaEvidenceSha256 = "a".repeat(64); },
    (value) => { value.candidates[0].measuredMedia.source = "private"; },
  ]) {
    const dto = structuredClone(validPresentation());
    mutate(dto);
    assert.throws(() => validatePresentation(dto), CandidatesArtifactInvalidError);
  }
});

test("bounded FD reader catches files that grow beyond the limit", async () => {
  let position = 0;
  const fakeHandle = {
    async read(buffer, offset, length) {
      const remaining = MAX_ARTIFACT_BYTES + 1 - position;
      const bytesRead = Math.min(length, remaining);
      buffer.fill(0x20, offset, offset + bytesRead);
      position += bytesRead;
      return { bytesRead, buffer };
    },
  };
  await assert.rejects(readBoundedArtifact(fakeHandle), CandidatesArtifactInvalidError);
  assert.equal(position, MAX_ARTIFACT_BYTES + 1);
});

test("opened FD realpath must remain inside canonical analysis directory", async () => {
  const { root } = await rootWithJob();
  await publish(root);
  let invoked = false;
  await assert.rejects(
    readCandidatesPresentation(JOB_ID, root, {
      resolveFdPath: async () => "/tmp/outside/candidates.v2.json",
      validatorRunner: async () => { invoked = true; return validPresentation(); },
    }),
    CandidatesArtifactInvalidError,
  );
  assert.equal(invoked, false);
});

test("job, analysis, and final artifact symlinks are rejected", async (t) => {
  await t.test("job symlink", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "clipper-candidates-link-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "clipper-candidates-outside-"));
    await writeFile(path.join(outside, "job.json"), "{}\n");
    await symlink(outside, path.join(root, JOB_ID));
    await assert.rejects(readCandidatesPresentation(JOB_ID, root), /job/i);
  });
  await t.test("analysis symlink", async () => {
    const { root, job } = await rootWithJob();
    const outside = await mkdtemp(path.join(os.tmpdir(), "clipper-candidates-outside-"));
    await writeFile(path.join(outside, "candidates.v2.json"), "x");
    await symlink(outside, path.join(job, "analysis"));
    await assert.rejects(readCandidatesPresentation(JOB_ID, root), CandidatesArtifactInvalidError);
  });
  await t.test("artifact symlink", async () => {
    const { root, job } = await rootWithJob();
    const outside = path.join(await mkdtemp(path.join(os.tmpdir(), "clipper-candidates-outside-")), "artifact.json");
    await writeFile(outside, "x");
    await mkdir(path.join(job, "analysis"));
    await symlink(outside, path.join(job, "analysis", "candidates.v2.json"));
    await assert.rejects(readCandidatesPresentation(JOB_ID, root), CandidatesArtifactInvalidError);
  });
});

test("route enforces authentication, UUID, job status, and no-store", async () => {
  const { root } = await rootWithJob();
  const denied = await invoke(root, { authenticated: false });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get("cache-control"), "no-store");

  const invalid = await invoke(root, { id: "../../etc/passwd" });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.headers.get("cache-control"), "no-store");

  const missing = await invoke(root, { id: OTHER_JOB_ID });
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("cache-control"), "no-store");

  const absent = await invoke(root);
  assert.equal(absent.status, 200);
  assert.deepEqual(await absent.json(), { available: false, candidates: [] });
  assert.equal(absent.headers.get("cache-control"), "no-store");
});

test("actual Python validator integration", async (t) => {
  const python = process.env.PYTHON_BIN || "python";
  try {
    await execFile(python, ["-c", "import ai_clipper.candidate_api"]);
  } catch {
    t.skip("Python or installed ai_clipper package is unavailable in this Node test environment");
    return;
  }
  const artifact = {
    selection_version: "selection-v2.0",
    source: "a.mp4",
    provenance: ["raw provenance must not pass through"],
    weight_config: {
      hook_strength: 1.4, hook_relevance: 1.2, standalone_context: 1.1,
      payoff_completeness: 1.4, information_density: 1, topic_value: 0.8,
      boundary_quality: 1.1, audio_energy: 0.5, audio_energy_change: 0.4,
      scene_activity: 0.3, motion: 0.3, face_activity: 0.2, penalty: 0.6,
      overlap_threshold: 0, overlap_metric: "overlap_ratio", diversity_strength: 0.3,
      version: "selection-v2.0",
    },
    candidates: [], breakdowns: [], media_snapshots: [],
  };
  const dto = await runCandidateValidator(Buffer.from(JSON.stringify(artifact)), { pythonBin: python });
  assert.deepEqual(dto, {
    available: true,
    selectionVersion: "selection-v2.0",
    provenance: ["selection-v2.0"],
    candidates: [],
  });
});
