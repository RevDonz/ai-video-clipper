// The camera analysis progress of a clip (plan §11.3 T3.6, §5.7): `edit_v2.camera.ProgressFile`
// keeps `preview/camera.progress.json` while `prepare` builds a camera plan; this helper reads it
// for `GET /api/jobs/:id/clips/:clipId/camera-progress` (the route file is the W3 integrator's).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CAMERA_PROGRESS_FILE,
  STALE_AFTER_MS,
  cameraProgressResponse,
  readCameraProgress,
} from "../lib/camera-progress.mjs";

const JOB = "8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55";
const CLIP = "clip_9b2e41c07d3a5f18e6c2a0b4";

function makeRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "camera-progress-"));
  const preview = path.join(root, JOB, "analysis", "clips", CLIP, "preview");
  mkdirSync(preview, { recursive: true });
  return { root, preview, file: path.join(preview, "camera.progress.json") };
}

// The bytes edit_v2.camera.ProgressFile writes (canonical JSON, sorted keys).
const progressBytes = (done, total, window = [1000, 181000]) => JSON.stringify(
  { done, schema: "potongin.camera-progress/1", total, window_ms: window });

test("the progress file is found under the clip's preview directory by its fixed name", () => {
  assert.equal(CAMERA_PROGRESS_FILE.dir, "preview");
  assert.ok(CAMERA_PROGRESS_FILE.pattern.test("camera.progress.json"));
  assert.ok(!CAMERA_PROGRESS_FILE.pattern.test("../camera.progress.json"));
  assert.ok(STALE_AFTER_MS >= 10_000);
});

test("a running analysis reads as building with its samples; nothing running reads as none", async () => {
  const { root, file } = makeRoot();
  try {
    assert.deepEqual(await readCameraProgress({ jobsRoot: root, jobId: JOB, clipId: CLIP }), { state: "none" });
    writeFileSync(file, progressBytes(60, 240));
    assert.deepEqual(await readCameraProgress({ jobsRoot: root, jobId: JOB, clipId: CLIP }),
      { state: "building", done: 60, total: 240 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stale, malformed, oversized or symlinked file never reads as progress", async () => {
  const { root, file } = makeRoot();
  try {
    const read = () => readCameraProgress({ jobsRoot: root, jobId: JOB, clipId: CLIP });
    writeFileSync(file, progressBytes(10, 240));
    const old = (Date.now() - STALE_AFTER_MS - 5_000) / 1000;
    utimesSync(file, old, old); // a prepare that died without clearing its file
    assert.deepEqual(await read(), { state: "none" });
    for (const bad of ["", "{", "[]", JSON.stringify({ schema: "x", done: 1, total: 2, window_ms: [0, 1] }),
      progressBytes(3, 2), progressBytes(-1, 2), progressBytes(1, 0), progressBytes(1.5, 2), "x".repeat(10_000)]) {
      writeFileSync(file, bad);
      assert.deepEqual(await read(), { state: "none" }, bad.slice(0, 40));
    }
    rmSync(file);
    const elsewhere = path.join(root, "elsewhere.json");
    writeFileSync(elsewhere, progressBytes(1, 2));
    symlinkSync(elsewhere, file);
    assert.deepEqual(await read(), { state: "none" });
    assert.deepEqual(await readCameraProgress({ jobsRoot: root, jobId: "../x", clipId: CLIP }), { state: "none" });
    assert.deepEqual(await readCameraProgress({ jobsRoot: root, jobId: JOB, clipId: "clip_../" }), { state: "none" });
    assert.deepEqual(await readCameraProgress({ jobsRoot: "", jobId: JOB, clipId: CLIP }), { state: "none" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function request(headers = {}) {
  return new Request(`http://127.0.0.1/api/jobs/${JOB}/clips/${CLIP}/camera-progress`, { headers });
}

test("the route: editor flag, authentication and ids first; then the progress, never cached", async () => {
  const { root, file } = makeRoot();
  const env = { POTONGIN_EDITOR_V3: "on", JOBS_ROOT: root };
  const allow = () => null;
  try {
    writeFileSync(file, progressBytes(120, 240));
    let response = await cameraProgressResponse(request(), { id: JOB, clipId: CLIP }, { env: { ...env, POTONGIN_EDITOR_V3: "off" }, requireAuth: allow });
    assert.equal(response.status, 404);
    response = await cameraProgressResponse(request(), { id: JOB, clipId: CLIP },
      { env, requireAuth: () => Response.json({ error: "no" }, { status: 401 }) });
    assert.equal(response.status, 401);
    response = await cameraProgressResponse(request(), { id: "nope", clipId: CLIP }, { env, requireAuth: allow });
    assert.equal(response.status, 400);
    response = await cameraProgressResponse(request(), { id: JOB, clipId: CLIP }, { env, requireAuth: allow });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(await response.json(), { state: "building", done: 120, total: 240 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
