import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildClipperInvocation, main, manifestJobPatch, nextWorkerProgress } from "../scripts/run-job.mjs";

const baseJob = { progress: 20, options: { renderMode: "fit-blur", limit: 3, minDuration: 20, maxDuration: 60 } };
const v1Args = [
  "/data/jobs/id/input/source.mp4", "--output-dir", "/data/jobs/id/output",
  "--model", "small", "--device", "cpu", "--language", "id",
  "--min-duration", "20", "--max-duration", "60", "--limit", "3",
  "--width", "720", "--height", "1280", "--render-mode", "fit-blur",
];

test("V1 worker invocation remains byte-for-byte unchanged", () => {
  assert.deepEqual(buildClipperInvocation(baseJob, "/data/jobs/id/input/source.mp4", "/data/jobs/id/output", {}), {
    command: "/app/.venv/bin/ai-clipper", args: v1Args,
  });
});

test("V2 shadow worker invocation appends only validated selection flags", () => {
  const job = { ...baseJob, options: { ...baseJob.options, selectionMode: "v2-shadow", clipProfile: "viral-short", maxCandidates: 40, maxMediaCandidates: 6, mediaTimeout: 12.5 } };
  assert.deepEqual(buildClipperInvocation(job, "/input.mp4", "/data/jobs/id/output", {
    AI_CLIPPER_BIN: "/custom/ai-clipper", WHISPER_MODEL: "medium", WHISPER_DEVICE: "cuda", WHISPER_LANGUAGE: "en",
  }), {
    command: "/custom/ai-clipper",
    args: [
      "/input.mp4", "--output-dir", "/data/jobs/id/output", "--model", "medium", "--device", "cuda", "--language", "en",
      "--min-duration", "20", "--max-duration", "60", "--limit", "3",
      "--width", "720", "--height", "1280", "--render-mode", "fit-blur",
      "--selection-mode", "v2-shadow", "--artifact-root", "/data/jobs/id", "--clip-profile", "viral-short",
      "--max-candidates", "40", "--max-media-candidates", "6", "--media-timeout", "12.5",
    ],
  });
});

test("worker rejects hostile persisted selection values without constructing argv", () => {
  for (const options of [
    { ...baseJob.options, selectionMode: "v2-shadow; rm -rf /" },
    { ...baseJob.options, selectionMode: "v2-shadow", clipProfile: ["standard"] },
    { ...baseJob.options, selectionMode: "v2-shadow", maxCandidates: true },
    { ...baseJob.options, selectionMode: "v2-shadow", maxCandidates: 10, maxMediaCandidates: 11 },
  ]) assert.throws(() => buildClipperInvocation({ ...baseJob, options }, "/input", "/output", {}));
});

test("worker accepts canonical persisted numbers but never coerces persisted values", () => {
  assert.deepEqual(
    buildClipperInvocation(baseJob, "/data/jobs/id/input/source.mp4", "/data/jobs/id/output", {}).args,
    v1Args,
  );
  const hostileValues = ["3", [3], { valueOf: () => 3 }, new Number(3), true, NaN, Infinity];
  for (const value of hostileValues) {
    assert.throws(
      () => buildClipperInvocation({ ...baseJob, options: { ...baseJob.options, limit: value } }, "/input", "/output", {}),
      /persisted job options/i,
    );
  }
});

test("worker strictly validates every persisted numeric option", () => {
  const v2 = {
    ...baseJob.options,
    selectionMode: "v2-shadow",
    clipProfile: "standard",
    maxCandidates: 200,
    maxMediaCandidates: 12,
    mediaTimeout: 30,
  };
  for (const key of ["minDuration", "maxDuration", "maxCandidates", "maxMediaCandidates", "mediaTimeout"]) {
    for (const value of [[v2[key]], String(v2[key]), new Number(v2[key]), false]) {
      assert.throws(
        () => buildClipperInvocation({ ...baseJob, options: { ...v2, [key]: value } }, "/input", "/output", {}),
        /persisted job options/i,
      );
    }
  }
});

test("candidate-ready progress remains processing and never decreases percentage", () => {
  assert.deepEqual(nextWorkerProgress({ progress: 61, stage: "media" }, {
    progress: 60, stage: "candidates_ready", detail: "Kandidat bayangan V2 siap",
  }), {
    status: "processing", progress: 61, stage: "candidates_ready", stageDetail: "Kandidat bayangan V2 siap",
  });
});

test("completed manifest persists selection_v2 summary while V1 clips stay unchanged", () => {
  const selection = {
    mode: "v2-shadow", status: "completed", analysis_id: "0123456789abcdef0123456789abcdef",
    selection_version: "selection-v2.0", candidate_count: 3,
    artifact: "analysis/candidates.v2.json", warnings: ["candidate 0:1: media_unavailable"],
    sourcePath: "/private/source.mp4", nested: { secret: "do-not-copy" },
  };
  const sanitized = {
    mode: "v2-shadow", status: "completed", analysis_id: "0123456789abcdef0123456789abcdef",
    selection_version: "selection-v2.0", candidate_count: 3,
    artifact: "analysis/candidates.v2.json", warnings: ["candidate 0:1: media_unavailable"],
  };
  const clips = [{ index: 1, text: "V1 exact result" }];
  assert.deepEqual(manifestJobPatch({ status: "completed", selection_v2: selection }, clips), { selectionV2: sanitized, clips });
  assert.deepEqual(manifestJobPatch({ status: "completed" }, clips), { clips });
  assert.deepEqual(manifestJobPatch({ status: "failed", selection_v2: selection }), { selectionV2: sanitized });
});

test("malformed or oversized selection_v2 summaries are omitted without leaking data", () => {
  const valid = {
    mode: "v2-shadow", status: "completed", analysis_id: "0123456789abcdef0123456789abcdef",
    selection_version: "selection-v2.0", candidate_count: 3,
    artifact: "analysis/candidates.v2.json", warnings: [],
  };
  for (const selection_v2 of [
    { ...valid, analysis_id: "ABCDEF0123456789abcdef0123456789" },
    { ...valid, candidate_count: 5001 },
    { ...valid, artifact: "/private/candidates.v2.json" },
    { ...valid, warnings: Array(101).fill("artifact_archive_failed") },
    { ...valid, warnings: ["raw secret: super-secret-token"] },
    { ...valid, warnings: ["x".repeat(161)] },
  ]) {
    const patch = manifestJobPatch({ selection_v2 }, [{ index: 1 }]);
    assert.deepEqual(patch, { clips: [{ index: 1 }] });
    assert.doesNotMatch(JSON.stringify(patch), /private|secret|token/);
  }
});

test("worker integration ingests pipeline selection_v2 and still completes with V1 clips", async () => {
  const id = "123e4567-e89b-42d3-a456-426614174000";
  const root = await mkdtemp(path.join(os.tmpdir(), "clipper-worker-test-"));
  const jobRoot = path.join(root, id);
  const sourcePath = path.join(jobRoot, "input", "source.mp4");
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, "video");
  await writeFile(path.join(jobRoot, "job.json"), JSON.stringify({
    id, status: "queued", progress: 0,
    source: { type: "upload", name: "source.mp4" }, sourcePath,
    options: {
      renderMode: "fit-blur", limit: 1, minDuration: 20, maxDuration: 60,
      selectionMode: "v2-shadow", clipProfile: "standard",
      maxCandidates: 200, maxMediaCandidates: 12, mediaTimeout: 30,
    },
    clips: [],
  }));

  const fakeClipper = path.join(root, "fake-ai-clipper.mjs");
  await writeFile(fakeClipper, `#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const output = process.argv[process.argv.indexOf("--output-dir") + 1];
await mkdir(output, { recursive: true });
console.log('POTONGIN_PROGRESS {"progress":60,"stage":"candidates_ready","detail":"Kandidat bayangan V2 siap"}');
await writeFile(path.join(output, "manifest.json"), JSON.stringify({
  status: "completed",
  selection_v2: {
    mode: "v2-shadow", status: "completed", analysis_id: "0123456789abcdef0123456789abcdef",
    selection_version: "selection-v2.0", candidate_count: 2,
    artifact: "analysis/candidates.v2.json", warnings: [], sourcePath: "/private/source.mp4",
    huge: { payload: "raw-secret".repeat(10000) },
  },
  clips: [{ index: 1, score: 9, start: 0, end: 30, duration: 30, text: "V1 exact result", output: path.join(output, "clip.mp4"), subtitles: path.join(output, "clip.srt") }],
}));
`);
  await chmod(fakeClipper, 0o755);

  await main(["node", "run-job.mjs", id], { ...process.env, JOBS_ROOT: root, AI_CLIPPER_BIN: fakeClipper });
  const persisted = JSON.parse(await readFile(path.join(jobRoot, "job.json"), "utf8"));
  assert.equal(persisted.status, "completed");
  assert.equal(persisted.stage, "completed");
  assert.equal(persisted.clips[0].text, "V1 exact result");
  assert.equal(persisted.selection_v2, undefined);
  assert.deepEqual(persisted.selectionV2, {
    mode: "v2-shadow", status: "completed", analysis_id: "0123456789abcdef0123456789abcdef",
    selection_version: "selection-v2.0", candidate_count: 2,
    artifact: "analysis/candidates.v2.json", warnings: [],
  });
  assert.doesNotMatch(JSON.stringify(persisted), /private\/source|raw-secret/);
});
