import assert from "node:assert/strict";
import crypto from "node:crypto";
import { closeSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildClipperInvocation, main, manifestJobPatch, nextWorkerProgress, runFencedProcess } from "../scripts/run-job.mjs";
import { readCandidateFeedback } from "../lib/candidate-feedback.mjs";
import { openPreviewSource } from "../lib/preview-source.mjs";
import { LeaseLostError, claimNextJob } from "../lib/primary-job-queue.mjs";
import { createManualTrend, ingestTrendItems, setTrendContextEnabled, updateTrendItem } from "../lib/trend-context.mjs";

const baseJob = { progress: 20, options: { renderMode: "fit-blur", limit: 3, minDuration: 20, maxDuration: 60 } };
const v1Args = [
  "/data/jobs/id/input/source.mp4", "--output-dir", "/data/jobs/id/output",
  "--model", "small", "--device", "cpu", "--language", "id",
  "--min-duration", "20", "--max-duration", "60", "--limit", "3",
  "--width", "720", "--height", "1280", "--render-mode", "fit-blur",
  "--artifact-root", "/data/jobs/id",
];

test("V1 worker invocation keeps its flags and always names the job artifact root", () => {
  assert.deepEqual(buildClipperInvocation(baseJob, "/data/jobs/id/input/source.mp4", "/data/jobs/id/output", {}), {
    command: "/app/.venv/bin/ai-clipper", args: v1Args,
  });
});

test("every selection mode writes analysis beside the output it will be published with", () => {
  const attemptOutput = "/data/jobs/id/.attempts/0123abcd/output";
  const v2 = { ...baseJob.options, selectionMode: "v2-shadow", clipProfile: "standard", maxCandidates: 40, maxMediaCandidates: 6, mediaTimeout: 12.5 };
  for (const options of [baseJob.options, { ...baseJob.options, selectionMode: "v1" }, v2]) {
    const { args } = buildClipperInvocation({ ...baseJob, options }, "/input.mp4", attemptOutput, {});
    assert.equal(args.filter((value) => value === "--artifact-root").length, 1, JSON.stringify(options));
    assert.equal(args[args.indexOf("--artifact-root") + 1], "/data/jobs/id/.attempts/0123abcd");
  }
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
      "--width", "720", "--height", "1280", "--render-mode", "fit-blur", "--artifact-root", "/data/jobs/id",
      "--selection-mode", "v2-shadow", "--clip-profile", "viral-short",
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

test("run-job fencing rejects a stale lease before starting pipeline work", async () => {
  const id = "abcdefab-cdef-4abc-8def-abcdefabcdef";
  const root = await mkdtemp(path.join(os.tmpdir(), "clipper-worker-fence-"));
  const jobRoot = path.join(root, id);
  await mkdir(path.join(jobRoot, "input"), { recursive: true });
  await writeFile(path.join(jobRoot, "input", "source.mp4"), "video");
  await writeFile(path.join(jobRoot, "job.json"), JSON.stringify({
    id, status: "queued", progress: 0,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    source: { type: "upload", name: "source.mp4" }, sourcePath: path.join(jobRoot, "input", "source.mp4"),
    options: { renderMode: "fit-blur", limit: 1, minDuration: 20, maxDuration: 60 }, clips: [],
  }));
  const claim = await claimNextJob({ jobsRoot: root, workerId: "worker", leaseMs: 60_000, maxAttempts: 3 });
  assert.ok(claim);
  await assert.rejects(
    main(["node", "run-job.mjs", id, "stale-token"], { ...process.env, JOBS_ROOT: root, PRIMARY_LEASE_MS: "60000", AI_CLIPPER_BIN: "/must-not-run" }),
    /lease/i,
  );
  const state = JSON.parse(await readFile(path.join(jobRoot, "job.json"), "utf8"));
  assert.equal(state.status, "preparing");
  assert.equal(state.queue.lease.token, undefined);
  assert.match(state.queue.lease.tokenHash, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(state), new RegExp(claim.token));
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
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    source: { type: "upload", name: "source.mp4" }, sourcePath,
    options: {
      renderMode: "fit-blur", limit: 1, minDuration: 20, maxDuration: 60,
      selectionMode: "v2-shadow", clipProfile: "standard",
      maxCandidates: 200, maxMediaCandidates: 12, mediaTimeout: 30,
    },
    clips: [],
  }));
  const claim = await claimNextJob({ jobsRoot: root, workerId: "worker", leaseMs: 60_000, maxAttempts: 3, legacyQuiescenceMs: 0 });
  assert.ok(claim);

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

  await main(["node", "run-job.mjs", id, claim.token], { ...process.env, JOBS_ROOT: root, PRIMARY_LEASE_MS: "60000", AI_CLIPPER_BIN: fakeClipper });
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
  assert.equal(JSON.parse(await readFile(path.join(jobRoot, "output", ".attempt-owner.json"), "utf8")).id, id);
});

// A stand-in for the Python engine that behaves like run_pipeline: analysis goes
// under --artifact-root, which defaults to the output directory when omitted.
const FAKE_ENGINE = `#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const output = arg("--output-dir");
const artifactRoot = process.argv.includes("--artifact-root") ? arg("--artifact-root") : output;
await mkdir(output, { recursive: true });
await mkdir(path.join(artifactRoot, "analysis"), { recursive: true });
await writeFile(path.join(artifactRoot, "analysis", "candidates.v2.json"), '{"fake":"candidates"}');
await writeFile(path.join(artifactRoot, "analysis", "selection.v3.json"), '{"fake":"selection"}');
if (process.env.FAKE_ENGINE_FAIL === "1") {
  await writeFile(path.join(output, "manifest.json"), JSON.stringify({ status: "failed", error: "engine failed on purpose" }));
  process.exit(1);
}
const poster = process.env.FAKE_ENGINE_THUMBNAIL;
if (poster === "write") await writeFile(path.join(output, "clip-01.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
await writeFile(path.join(output, "manifest.json"), JSON.stringify({
  status: "completed",
  clips: [{
    index: 1, score: 9, start: 0, end: 30, duration: 30, text: "Klip uji", output: path.join(output, "clip-01.mp4"), subtitles: path.join(output, "clip-01.srt"),
    ...(poster ? { thumbnail: path.join(output, "clip-01.jpg") } : {}),
  }],
}));
`;

const FAKE_YT_DLP = `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
const template = process.argv[process.argv.indexOf("--output") + 1];
await writeFile(template.replace("%(ext)s", "mp4"), Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(20)]));
`;

async function engineFixture(prefix, { id, source, sourcePath, queued = true, options = {} }) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const jobRoot = path.join(root, id);
  await mkdir(path.join(jobRoot, "input"), { recursive: true });
  const resolvedSource = sourcePath === undefined ? path.join(jobRoot, "input", "source.mp4") : sourcePath;
  if (resolvedSource) await writeFile(resolvedSource, "video");
  await writeFile(path.join(jobRoot, "job.json"), JSON.stringify({
    id, status: queued ? "queued" : "processing", progress: 0,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    source: source || { type: "upload", name: "source.mp4" }, sourcePath: resolvedSource,
    options: { renderMode: "fit-blur", limit: 1, minDuration: 20, maxDuration: 60, ...options },
    clips: [],
  }));
  const bin = await mkdtemp(path.join(os.tmpdir(), "clipper-worker-bin-"));
  const engine = path.join(bin, "fake-ai-clipper.mjs");
  await writeFile(engine, FAKE_ENGINE);
  await writeFile(path.join(bin, "yt-dlp"), FAKE_YT_DLP);
  await chmod(engine, 0o755);
  await chmod(path.join(bin, "yt-dlp"), 0o755);
  const env = { ...process.env, JOBS_ROOT: root, PRIMARY_LEASE_MS: "60000", AI_CLIPPER_BIN: engine, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  return { root, jobRoot, env };
}

const V2_OPTIONS = { selectionMode: "v2-shadow", clipProfile: "standard", maxCandidates: 200, maxMediaCandidates: 12, mediaTimeout: 30 };
const attemptRootFor = (jobRoot, token) => path.join(jobRoot, ".attempts", crypto.createHash("sha256").update(token).digest("hex"));

test("queue-managed runs publish the attempt analysis where every web reader looks", async () => {
  for (const options of [V2_OPTIONS, {}]) {
    const id = "423e4567-e89b-42d3-a456-426614174000";
    const { root, jobRoot, env } = await engineFixture("clipper-worker-analysis-", { id, options });
    const claim = await claimNextJob({ jobsRoot: root, workerId: "worker", leaseMs: 60_000, maxAttempts: 3, legacyQuiescenceMs: 0 });
    await main(["node", "run-job.mjs", id, claim.token], env);

    const persisted = JSON.parse(await readFile(path.join(jobRoot, "job.json"), "utf8"));
    assert.equal(persisted.status, "completed", JSON.stringify(options));
    assert.equal(await readFile(path.join(jobRoot, "analysis", "candidates.v2.json"), "utf8"), '{"fake":"candidates"}');
    assert.equal(await readFile(path.join(jobRoot, "analysis", "selection.v3.json"), "utf8"), '{"fake":"selection"}');
    await assert.rejects(lstat(path.join(jobRoot, "output", "analysis")), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(attemptRootFor(jobRoot, claim.token), "analysis")), { code: "ENOENT" });
    const analysisSeenByRoutes = await readCandidateFeedback(id, "get", Buffer.alloc(0), root, { runner: async (analysis) => analysis });
    assert.equal(analysisSeenByRoutes, path.join(await realpath(root), id, "analysis"));
  }
});

test("clip posters written by the engine are published and advertised; missing ones are not", async () => {
  const expected = { write: "/files/output/clip-01.jpg", missing: undefined, "": undefined };
  for (const [poster, suffix] of Object.entries(expected)) {
    const id = "a23e4567-e89b-42d3-a456-426614174000";
    const { root, jobRoot, env } = await engineFixture("clipper-worker-poster-", { id });
    const claim = await claimNextJob({ jobsRoot: root, workerId: "worker", leaseMs: 60_000, maxAttempts: 3, legacyQuiescenceMs: 0 });
    await main(["node", "run-job.mjs", id, claim.token], { ...env, FAKE_ENGINE_THUMBNAIL: poster });

    const persisted = JSON.parse(await readFile(path.join(jobRoot, "job.json"), "utf8"));
    assert.equal(persisted.status, "completed", poster);
    const [clip] = persisted.clips;
    assert.equal(clip.thumbnailUrl, suffix && `/api/jobs/${id}${suffix}`, poster);
    assert.equal(clip.videoUrl, `/api/jobs/${id}/files/output/clip-01.mp4`);
    if (suffix) assert.equal((await lstat(path.join(jobRoot, "output", "clip-01.jpg"))).size, 4);
  }
});

test("a failed queue attempt publishes neither output nor analysis", async () => {
  const id = "523e4567-e89b-42d3-a456-426614174000";
  const { root, jobRoot, env } = await engineFixture("clipper-worker-failed-", { id, options: V2_OPTIONS });
  const claim = await claimNextJob({ jobsRoot: root, workerId: "worker", leaseMs: 60_000, maxAttempts: 3, legacyQuiescenceMs: 0 });
  const previousExitCode = process.exitCode;
  try {
    await main(["node", "run-job.mjs", id, claim.token], { ...env, FAKE_ENGINE_FAIL: "1" });
  } finally {
    process.exitCode = previousExitCode;
  }
  const persisted = JSON.parse(await readFile(path.join(jobRoot, "job.json"), "utf8"));
  assert.equal(persisted.status, "failed");
  for (const name of ["analysis", "output"]) await assert.rejects(lstat(path.join(jobRoot, name)), { code: "ENOENT" });
});

test("legacy runs keep writing analysis directly into the job directory", async () => {
  const id = "623e4567-e89b-42d3-a456-426614174000";
  const { jobRoot, env } = await engineFixture("clipper-worker-legacy-", { id, queued: false, options: V2_OPTIONS });
  await main(["node", "run-job.mjs", id], env);
  const persisted = JSON.parse(await readFile(path.join(jobRoot, "job.json"), "utf8"));
  assert.equal(persisted.status, "completed");
  assert.equal(await readFile(path.join(jobRoot, "analysis", "candidates.v2.json"), "utf8"), '{"fake":"candidates"}');
  await assert.rejects(lstat(path.join(jobRoot, ".attempts")), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(jobRoot, "analysis", ".attempt-owner.json")), { code: "ENOENT" });
});

test("a queue-managed YouTube run leaves its source where preview and re-render look", async () => {
  const id = "723e4567-e89b-42d3-a456-426614174000";
  const { root, jobRoot, env } = await engineFixture("clipper-worker-youtube-", {
    id, source: { type: "youtube", url: "https://youtu.be/abc" }, sourcePath: null, options: V2_OPTIONS,
  });
  const claim = await claimNextJob({ jobsRoot: root, workerId: "worker", leaseMs: 60_000, maxAttempts: 3, legacyQuiescenceMs: 0 });
  await main(["node", "run-job.mjs", id, claim.token], env);

  const persisted = JSON.parse(await readFile(path.join(jobRoot, "job.json"), "utf8"));
  assert.equal(persisted.status, "completed");
  assert.equal(persisted.sourcePath, path.join(jobRoot, "input", "source.mp4"));
  assert.equal(await readFile(path.join(jobRoot, "analysis", "candidates.v2.json"), "utf8"), '{"fake":"candidates"}');
  await assert.rejects(lstat(path.join(attemptRootFor(jobRoot, claim.token), "input")), { code: "ENOENT" });
  const preview = await openPreviewSource(id, root);
  try {
    assert.equal(preview.contentType, "video/mp4");
    assert.equal(preview.size, 32);
  } finally {
    closeSync(preview.fd);
  }
});

test("lease loss immediately terminates the child process group", async () => {
  const events = [];
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const child = new EventEmitter();
  child.pid = 43210;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const promise = runFencedProcess({
    command: "/fake", args: [], env: {}, heartbeatMs: 5, progress: false,
    spawnImpl: () => child,
    update: async () => { throw new LeaseLostError(); },
    killImpl: (pid, signal) => { events.push([pid, signal]); queueMicrotask(() => child.emit("close", null, signal)); },
  });
  await assert.rejects(promise, LeaseLostError);
  assert.deepEqual(events[0], [-43210, "SIGTERM"]);
});

test("child settlement disarms delayed SIGKILL before PGID reuse", async () => {
  const events = [];
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const child = new EventEmitter();
  child.pid = 43211;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const promise = runFencedProcess({
    command: "/fake", args: [], env: {}, heartbeatMs: 5, progress: false, escalationMs: 10,
    spawnImpl: () => child,
    update: async () => { throw new LeaseLostError(); },
    killImpl: (pid, signal) => {
      events.push([pid, signal]);
      if (signal === "SIGTERM") queueMicrotask(() => child.emit("close", null, signal));
    },
  });
  await assert.rejects(promise, LeaseLostError);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(events, [[-43211, "SIGTERM"]]);
});

// --- Konteks Tren: per-job trend snapshot -----------------------------------------------------

const V3_OPTIONS = { selectionMode: "v3", llmMode: "auto", coldOpen: true, hookOverlay: true, captionStyle: "karaoke" };
const V3_TAIL = ["--selection-mode", "v3", "--llm", "auto", "--cold-open", "--hook-overlay", "--caption-style", "karaoke"];

test("V3 invocation passes --trend-context last, only for V3 and only with an absolute path", () => {
  const job = { ...baseJob, options: { ...baseJob.options, ...V3_OPTIONS } };
  const snapshot = "/data/jobs/id/.attempts/abc/analysis/trend-context.json";
  const withTrends = buildClipperInvocation(job, "/in", "/data/jobs/id/.attempts/abc/output", {}, { captionsDir: "/c", trendContext: snapshot }).args;
  assert.deepEqual(withTrends.slice(-4), ["--captions-dir", "/c", "--trend-context", snapshot]);
  const plain = buildClipperInvocation(job, "/in", "/data/jobs/id/.attempts/abc/output", {}).args;
  assert.deepEqual(plain.slice(-V3_TAIL.length), V3_TAIL);
  for (const trendContext of [null, undefined, "", "analysis/trend-context.json", 42]) {
    assert.deepEqual(buildClipperInvocation(job, "/in", "/data/jobs/id/.attempts/abc/output", {}, { trendContext }).args, plain);
  }
  for (const options of [baseJob.options, { ...baseJob.options, ...V2_OPTIONS }]) {
    const args = buildClipperInvocation({ ...baseJob, options }, "/in", "/o/output", {}, { trendContext: snapshot }).args;
    assert.ok(!args.includes("--trend-context"), JSON.stringify(options));
  }
});

// Records its argv and reports the first snapshot item as a grounded trend of its clip.
const FAKE_TREND_ENGINE = `#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const output = arg("--output-dir");
await mkdir(output, { recursive: true });
await mkdir(path.join(arg("--artifact-root"), "analysis"), { recursive: true });
await writeFile(path.join(output, "argv.json"), JSON.stringify(process.argv.slice(2)));
const snapshot = process.argv.includes("--trend-context") ? JSON.parse(await readFile(arg("--trend-context"), "utf8")) : null;
await writeFile(path.join(output, "manifest.json"), JSON.stringify({
  status: "completed",
  clips: [{
    index: 1, score: 9, start: 0, end: 30, duration: 30, text: "Kabur aja dulu katanya", title: "Kabur Aja Dulu?", selection_source: "llm",
    output: path.join(output, "clip-01.mp4"), subtitles: path.join(output, "clip-01.srt"),
    ...(snapshot ? { trends: snapshot.items.slice(0, 1).map(({ id, title, kind }) => ({ id, title, kind })) } : {}),
  }],
}));
`;

async function trendJob(prefix, options = V3_OPTIONS, { queued = true } = {}) {
  const id = "823e4567-e89b-42d3-a456-426614174000";
  const fixture = await engineFixture(prefix, { id, options, queued });
  await writeFile(fixture.env.AI_CLIPPER_BIN, FAKE_TREND_ENGINE);
  const env = { ...fixture.env, POTONGIN_SETTINGS_DIR: `${fixture.root}-settings` };
  return { ...fixture, id, env };
}

async function runTrendJob({ root, jobRoot, id, env }, { queued = true } = {}) {
  let token = null;
  if (queued) token = (await claimNextJob({ jobsRoot: root, workerId: "worker", leaseMs: 60_000, maxAttempts: 3, legacyQuiescenceMs: 0 })).token;
  await main(["node", "run-job.mjs", id, ...(token ? [token] : [])], env);
  const persisted = JSON.parse(await readFile(path.join(jobRoot, "job.json"), "utf8"));
  const argv = JSON.parse(await readFile(path.join(jobRoot, "output", "argv.json"), "utf8"));
  return { persisted, argv, token };
}

const TREND_ITEM = { kind: "topic", title: "Kabur Aja Dulu", keywords: ["kabur aja dulu"], hashtags: ["#KaburAjaDulu"], score: 80 };

test("a V3 job snapshots enabled trends into analysis/, passes --trend-context and keeps grounded clip trends", async () => {
  const job = await trendJob("clipper-worker-trends-");
  await ingestTrendItems([TREND_ITEM, { ...TREND_ITEM, title: "Mati", keywords: ["mati mati"], score: 99 }], { env: job.env, source: "hermes-label" });
  await createManualTrend({ kind: "person", title: "Pak Budi", keywords: ["pak budi"], score: 10 }, { env: job.env });
  const { items } = JSON.parse(await readFile(path.join(job.env.POTONGIN_SETTINGS_DIR, "trend-context.json"), "utf8"));
  await updateTrendItem(items[1].id, { enabled: false }, { env: job.env });

  const { persisted, argv, token } = await runTrendJob(job);
  assert.equal(persisted.status, "completed", persisted.error);
  const attemptSnapshot = path.join(attemptRootFor(job.jobRoot, token), "analysis", "trend-context.json");
  assert.deepEqual(argv.slice(-2), ["--trend-context", attemptSnapshot]);
  assert.deepEqual(argv.slice(-2 - V3_TAIL.length, -2), V3_TAIL);
  assert.doesNotMatch(JSON.stringify(argv), /Kabur|Budi|kabur aja dulu|KaburAjaDulu/, "trend text never enters argv");

  // Published with the rest of analysis/, private, and free of source data.
  const published = path.join(job.jobRoot, "analysis", "trend-context.json");
  assert.equal((await lstat(published)).mode & 0o777, 0o600);
  const snapshot = JSON.parse(await readFile(published, "utf8"));
  assert.deepEqual(snapshot.items.map((item) => item.title), ["Kabur Aja Dulu", "Pak Budi"]);
  assert.doesNotMatch(JSON.stringify(snapshot), /hermes-label|manual|"source"|examples/);

  assert.deepEqual(persisted.clips[0].trends, [{ id: items[0].id, title: "Kabur Aja Dulu", kind: "topic" }]);
});

test("without enabled active trends a V3 job runs exactly as before: no snapshot, no flag, no clip trends", async () => {
  const setups = {
    "no store": async () => {},
    "switched off": async (env) => {
      await ingestTrendItems([TREND_ITEM], { env, source: "hermes" });
      await setTrendContextEnabled(false, { env });
    },
    "all items disabled": async (env) => {
      const created = await createManualTrend(TREND_ITEM, { env });
      await updateTrendItem(created.id, { enabled: false }, { env });
    },
    "all items expired": async (env) => {
      const created = await createManualTrend(TREND_ITEM, { env });
      await updateTrendItem(created.id, { expiresAt: new Date(Date.now() - 60_000).toISOString() }, { env });
    },
    "corrupt store": async (env) => {
      await mkdir(env.POTONGIN_SETTINGS_DIR, { recursive: true });
      await writeFile(path.join(env.POTONGIN_SETTINGS_DIR, "trend-context.json"), "{ rusak");
    },
  };
  for (const [label, setup] of Object.entries(setups)) {
    const job = await trendJob("clipper-worker-notrends-");
    await setup(job.env);
    const { persisted, argv } = await runTrendJob(job);
    assert.equal(persisted.status, "completed", `${label}: ${persisted.error}`);
    assert.ok(!argv.includes("--trend-context"), label);
    assert.deepEqual(argv.slice(-V3_TAIL.length), V3_TAIL, label);
    await assert.rejects(lstat(path.join(job.jobRoot, "analysis", "trend-context.json")), { code: "ENOENT" }, label);
    assert.equal("trends" in persisted.clips[0], false, label);
  }
});

test("V1 and V2 jobs never get a trend snapshot, even with enabled trends", async () => {
  for (const options of [{}, V2_OPTIONS]) {
    const job = await trendJob("clipper-worker-legacy-trends-", options);
    await ingestTrendItems([TREND_ITEM], { env: job.env, source: "hermes" });
    const { persisted, argv } = await runTrendJob(job);
    assert.equal(persisted.status, "completed", JSON.stringify(options));
    assert.ok(!argv.includes("--trend-context"));
    await assert.rejects(lstat(path.join(job.jobRoot, "analysis", "trend-context.json")), { code: "ENOENT" });
  }
});

test("a legacy (unqueued) V3 run writes its snapshot straight into the job's analysis/", async () => {
  const job = await trendJob("clipper-worker-legacy-v3-trends-", V3_OPTIONS, { queued: false });
  await ingestTrendItems([TREND_ITEM], { env: job.env, source: "hermes" });
  const { persisted, argv } = await runTrendJob(job, { queued: false });
  assert.equal(persisted.status, "completed", persisted.error);
  const snapshot = path.join(job.jobRoot, "analysis", "trend-context.json");
  assert.deepEqual(argv.slice(-2), ["--trend-context", snapshot]);
  assert.equal(JSON.parse(await readFile(snapshot, "utf8")).items.length, 1);
});
