// The project page's progress (lib/project-progress.mjs, 05-ui-dashboard.md §6.4): the stepper
// from the worker's stage (stageCode when the coded worker sent it, else job.stage, so old jobs
// keep working), the queue position and the clips ready so far.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
