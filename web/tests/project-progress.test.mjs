// The project page's progress (lib/project-progress.mjs, 05-ui-dashboard.md §6.4): the stepper
// from the worker's stage (stageCode when the coded worker sent it, else job.stage, so old jobs
// keep working), the queue position and the clips ready so far.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { STAGE_CODES } from "../lib/i18n/stage.mjs";
import { PROGRESS_STEPS, currentStep, etaMinutes, progressSteps, queueView, readyCount } from "../lib/project-progress.mjs";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const youtube = { source: { type: "youtube", url: "https://youtu.be/x" } };
const upload = { source: { type: "upload", name: "a.mp4" } };
const states = (job) => progressSteps(job).map((step) => `${step.id}:${step.state}`);

test("a link job downloads first; an upload starts at the transcript", () => {
  assert.deepEqual(PROGRESS_STEPS, ["download", "transcript", "moments", "render"]);
  assert.deepEqual(states({ ...youtube, status: "downloading" }), ["download:current", "transcript:todo", "moments:todo", "render:todo"]);
  assert.deepEqual(states({ ...youtube, status: "downloading", stage: "captions" }), ["download:current", "transcript:todo", "moments:todo", "render:todo"]);
  assert.deepEqual(states({ ...youtube, status: "processing", stage: "transcribing" }), ["download:done", "transcript:current", "moments:todo", "render:todo"]);
  assert.deepEqual(states({ ...upload, status: "processing", stage: "analyzing" }), ["transcript:current", "moments:todo", "render:todo"]);
  assert.deepEqual(states({ ...upload, status: "processing", stage: "llm" }), ["transcript:done", "moments:current", "render:todo"]);
  assert.deepEqual(states({ ...upload, status: "processing", stage: "packaging" }), ["transcript:done", "moments:current", "render:todo"]);
  assert.deepEqual(states({ ...upload, status: "processing", stage: "finalizing" }), ["transcript:done", "moments:done", "render:current"]);
  assert.deepEqual(states({ ...upload, status: "queued" }), ["transcript:todo", "moments:todo", "render:todo"]);
  for (const status of ["completed", "failed", "cancelled", "deleting"]) assert.equal(progressSteps({ ...upload, status }), null, status);
});

test("the coded worker's stageCode wins; unknown codes and old stages fall back", () => {
  assert.equal(currentStep({ ...youtube, status: "processing", stage: "rendering", stageCode: "fetch_video" }), "download");
  assert.equal(currentStep({ ...upload, status: "processing", stage: "selecting", stageCode: "reframe" }), "render");
  assert.equal(currentStep({ ...upload, status: "processing", stage: "llm", stageCode: "something_new" }), "moments");
  assert.equal(currentStep({ ...upload, status: "processing", stageCode: "fetch_audio" }), "transcript", "an upload has no download step");
  assert.equal(currentStep({ ...upload, status: "processing", stage: "candidates_ready" }), "transcript", "a retired stage keeps the job in the first step");
  assert.equal(currentStep({ ...upload, status: "queued" }), null);
});

test("every stage the engine reports has a step", async () => {
  const source = await readFile(path.join(WEB, "..", "src", "ai_clipper", "pipeline.py"), "utf8");
  const stages = new Set([...source.matchAll(/report\(\s*"(\w+)",/g)].map((match) => match[1]));
  for (const stage of stages) {
    if (["completed", "failed", "cancelled"].includes(stage)) continue;
    assert.ok(currentStep({ ...upload, status: "processing", stage }), stage);
  }
});

test("every stage code of the coded worker (i18n M5) puts the job on its step", () => {
  const expected = {
    download: ["fetch_preflight", "fetch_audio", "fetch_video", "fetch_cache_hit", "fetch_wait_video"],
    transcript: ["analyze_video", "engine_prepare", "captions_upload", "captions_upload_ready", "captions_check", "captions_fetch",
      "transcribe_groq", "transcribe_groq_progress", "transcribe_audio", "transcribe_progress", "audio_analysis"],
    moments: ["candidates_generating", "candidates_features", "candidates_shortlist", "candidates_media", "candidates_ready",
      "select_llm", "select_heuristic", "select_ranges", "select_moments", "packaging"],
    render: ["reframe", "render_clip", "finalizing", "clips_ready", "clips_partial"],
  };
  // Codes that say nothing about the step (a busy engine, the end of a job) leave it to job.stage.
  const stepless = ["engine_busy", "stopped_error", "storage_insufficient", "max_attempts", "canceled_before_finish", "worker_spawn_failed", "deleting"];
  assert.deepEqual([...Object.values(expected).flat(), ...stepless].sort(), [...STAGE_CODES].sort(), "every code is placed");
  for (const [step, codes] of Object.entries(expected)) {
    for (const stageCode of codes) {
      assert.equal(currentStep({ ...youtube, status: "processing", stage: "llm", stageCode }), step, stageCode);
    }
  }
  for (const stageCode of stepless) {
    assert.equal(currentStep({ ...upload, status: "processing", stage: "llm", stageCode }), "moments", stageCode);
  }
});

test("the queue position shows once the queue reports it; maintenance is named", () => {
  assert.equal(queueView({ status: "queued" }), null, "before Fase 6 there is no position");
  assert.deepEqual(queueView({ status: "queued", queue: { position: 2, etaSeconds: 370 } }), { position: 2, etaSeconds: 370 });
  assert.deepEqual(queueView({ status: "queued", queue: { position: 1, etaSeconds: null } }), { position: 1, etaSeconds: null });
  assert.deepEqual(queueView({ status: "queued", queue: { held: "maintenance", position: 3 } }), { held: "maintenance" });
  assert.equal(queueView({ status: "queued", queue: { position: 0 } }), null);
  assert.equal(queueView({ status: "processing", queue: { position: 2 } }), null);
  assert.equal(etaMinutes(370), 6);
  assert.equal(etaMinutes(10), 1);
  assert.equal(etaMinutes(null), null);
});

test("clips that rendered count as ready while the job runs", () => {
  assert.equal(readyCount({ clips: [{ index: 1 }, { index: 2, status: "failed" }, { index: 3 }] }), 2);
  assert.equal(readyCount({}), 0);
});
