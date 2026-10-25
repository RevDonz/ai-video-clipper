// The worker's stage codes and the clips' reason and warning codes (rombak 07 §10.4, i18n M5):
// every patch that writes a stage detail writes its code beside it (or clears a stale one), the
// engine's stage_code is kept only when it is a known code with valid params, and a manifest
// clip's reason_codes/warning_codes reach the job clip only when they are valid. Old manifests
// and progress lines without codes give the job exactly the fields they gave before.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { STAGE_CODES } from "../lib/i18n/stage.mjs";
import { cancelPrimaryJob, claimNextJob, failClaimedJob } from "../lib/primary-job-queue.mjs";
import { completedStageCode, jobClipFromManifest, nextWorkerProgress, parseCodedProgress } from "../scripts/run-job.mjs";

const JOB_ID = "a1e45678-e89b-42d3-a456-426614174000";
const line = (event) => `POTONGIN_PROGRESS ${JSON.stringify(event)}`;

test("a coded progress line keeps the engine's stage code and params", () => {
  assert.deepEqual(parseCodedProgress(line({ stage: "rendering", progress: 70, detail: "Merender klip 2 dari 5", stage_code: "render_clip", stage_params: { index: 2, total: 5 } })), {
    progress: 70, stage: "rendering", detail: "Merender klip 2 dari 5", code: "render_clip", params: { index: 2, total: 5 },
  });
  // older engines: no code, the event is what parseWorkerProgress gives
  assert.deepEqual(parseCodedProgress(line({ stage: "audio", progress: 58, detail: "Menganalisis" })), { progress: 58, stage: "audio", detail: "Menganalisis" });
  assert.equal(parseCodedProgress("hello"), null);
  assert.equal(parseCodedProgress(line({ stage: "audio", progress: 100, detail: "x", stage_code: "audio_analysis" })), null);
});

test("nextWorkerProgress writes a known code, drops an unknown one, and clears a stale one", () => {
  const coded = nextWorkerProgress({ progress: 60, stage: "llm" }, { progress: 70, stage: "rendering", detail: "Merender klip 2 dari 5", code: "render_clip", params: { index: 2, total: 5 } });
  assert.deepEqual(coded, {
    status: "processing", progress: 70, stage: "rendering", stageDetail: "Merender klip 2 dari 5", stageCode: "render_clip", stageParams: { index: 2, total: 5 },
  });
  assert.deepEqual(nextWorkerProgress({ progress: 60 }, { progress: 60, stage: "x", detail: "y", code: "nope" }), {
    status: "processing", progress: 60, stage: "x", stageDetail: "y", stageCode: null, stageParams: null,
  });
  assert.deepEqual(nextWorkerProgress({ progress: 60, stageCode: "select_llm" }, { progress: 61, stage: "x", detail: "Teks lama" }), {
    status: "processing", progress: 61, stage: "x", stageDetail: "Teks lama", stageCode: null, stageParams: null,
  });
  assert.deepEqual(nextWorkerProgress({ progress: 60, stage: "x" }, { progress: 61, stage: "x", detail: "Teks lama" }), {
    status: "processing", progress: 61, stage: "x", stageDetail: "Teks lama",
  }, "a job without codes keeps its old shape");
});

test("the finished job's stage code names every clip ready, or how many failed", () => {
  const ready = { status: "ready" };
  const failed = { status: "failed", errorCode: "render_failed" };
  assert.deepEqual(completedStageCode([{}, {}]), { stageCode: "clips_ready", stageParams: null });
  assert.deepEqual(completedStageCode([ready, failed, {}]), { stageCode: "clips_partial", stageParams: { ready: 2, total: 3, failed: 1 } });
  assert.ok(STAGE_CODES.includes("clips_partial") && STAGE_CODES.includes("clips_ready"));
});

const MANIFEST_CLIP = {
  index: 1, start: 10, end: 40, duration: 30, score: 7.5, text: "Teks klip",
  output: "/data/jobs/x/output/clip-01.mp4", subtitles: "/data/jobs/x/output/clip-01.srt",
  title: "Judul", hook_text: "Hook", description: "Deskripsi.", hashtags: ["#a"], archetype: "humor",
  selection_source: "heuristic", reasons: ["Dimulai di batas kalimat yang bersih.", "Ada 2 tawa di dalam klip."],
  scores: { hook: 7, standalone: 7, payoff: 7, emotion: 7, shareability: 7 },
  cold_open: null, source_start: 10, source_end: 40, thumbnail: null,
};
const REASON_CODES = [{ code: "open_plain", params: {} }, { code: "laughs", params: { count: 2 } }];

test("a manifest clip's reason and warning codes reach the job clip when valid", () => {
  const clip = jobClipFromManifest({
    ...MANIFEST_CLIP, reason_codes: REASON_CODES, warning_codes: [{ code: "thumbnail_failed", params: { clip: 1 } }],
  }, JOB_ID);
  assert.deepEqual(clip.reasonCodes, REASON_CODES);
  assert.deepEqual(clip.warningCodes, [{ code: "thumbnail_failed", params: { clip: 1 } }]);
  assert.deepEqual(clip.reasons, MANIFEST_CLIP.reasons);

  const old = jobClipFromManifest(MANIFEST_CLIP, JOB_ID);
  assert.equal("reasonCodes" in old, false, "an old manifest gives the old clip");
  assert.equal("warningCodes" in old, false);
  const { reasonCodes: _r, warningCodes: _w, ...rest } = clip;
  assert.deepEqual(rest, old);

  const broken = jobClipFromManifest({ ...MANIFEST_CLIP, reason_codes: [...REASON_CODES, { code: "nope", params: {} }], warning_codes: "x" }, JOB_ID);
  assert.equal("reasonCodes" in broken, false);
  assert.equal("warningCodes" in broken, false);
  const mismatched = jobClipFromManifest({ ...MANIFEST_CLIP, reason_codes: REASON_CODES.slice(0, 1) }, JOB_ID);
  assert.equal("reasonCodes" in mismatched, false, "one entry per reason, or none");
});

test("a failed manifest clip keeps its reason codes too", () => {
  const clip = jobClipFromManifest({ ...MANIFEST_CLIP, output: null, subtitles: null, status: "failed", error_code: "render_failed", reason_codes: REASON_CODES }, JOB_ID);
  assert.equal(clip.status, "failed");
  assert.deepEqual(clip.reasonCodes, REASON_CODES);
});

// --- the queue's own stage details -------------------------------------------------------------

async function seeded(job) {
  const jobsRoot = await mkdtemp(path.join(os.tmpdir(), "stage-codes-"));
  await mkdir(path.join(jobsRoot, job.id), { recursive: true });
  await writeFile(path.join(jobsRoot, job.id, "job.json"), `${JSON.stringify(job)}\n`);
  return jobsRoot;
}

const persisted = async (jobsRoot, id) => JSON.parse(await readFile(path.join(jobsRoot, id, "job.json"), "utf8"));

function queuedJob(id, status = "queued", extra = {}) {
  return {
    id, status, progress: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    source: { type: "upload", name: "source.mp4" }, sourcePath: `/data/jobs/${id}/input/source.mp4`,
    options: { renderMode: "fit-blur", limit: 3, minDuration: 20, maxDuration: 60 }, clips: [], ...extra,
  };
}

test("cancelling, running out of attempts and a failed spawn write their stage codes", async () => {
  const cancelId = "b1e45678-e89b-42d3-a456-426614174001";
  const cancelRoot = await seeded(queuedJob(cancelId, "queued", { stageCode: "render_clip", stageParams: { index: 1, total: 2 } }));
  await cancelPrimaryJob({ jobsRoot: cancelRoot, id: cancelId, now: Date.parse("2026-01-01T00:01:00.000Z") });
  const cancelled = await persisted(cancelRoot, cancelId);
  assert.equal(cancelled.stageDetail, "Dibatalkan sebelum selesai");
  assert.equal(cancelled.stageCode, "canceled_before_finish");
  assert.equal(cancelled.stageParams, null);

  const tiredId = "b1e45678-e89b-42d3-a456-426614174002";
  const tiredRoot = await seeded(queuedJob(tiredId, "downloading"));
  await claimNextJob({ jobsRoot: tiredRoot, workerId: "w", leaseMs: 60_000, maxAttempts: 1, legacyQuiescenceMs: 0, now: Date.parse("2026-01-01T00:01:00.000Z") });
  await claimNextJob({ jobsRoot: tiredRoot, workerId: "w", leaseMs: 60_000, maxAttempts: 1, now: Date.parse("2026-01-01T00:03:00.000Z") });
  const tired = await persisted(tiredRoot, tiredId);
  assert.equal(tired.status, "failed");
  assert.equal(tired.stageCode, "max_attempts");

  const spawnId = "b1e45678-e89b-42d3-a456-426614174003";
  const spawnRoot = await seeded(queuedJob(spawnId));
  const now = Date.parse("2026-01-01T00:01:00.000Z");
  const claim = await claimNextJob({ jobsRoot: spawnRoot, workerId: "w", leaseMs: 60_000, maxAttempts: 3, legacyQuiescenceMs: 0, now });
  await failClaimedJob({ jobsRoot: spawnRoot, id: spawnId, token: claim.token, leaseMs: 60_000, error: "spawn ENOENT", now: now + 1000 });
  const spawned = await persisted(spawnRoot, spawnId);
  assert.equal(spawned.stageCode, "worker_spawn_failed");
  assert.equal(spawned.stageDetail, "Primary worker gagal memulai proses");
});
