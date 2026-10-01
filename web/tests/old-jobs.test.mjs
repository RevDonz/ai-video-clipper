// Projects made before the current selection, including ones edited in the retired candidate
// editor, stay viewable and downloadable after that editor's backend is gone (T4.1). The fixtures
// are an old job without a selection mode and an old candidates job with everything the retired
// editor left behind (edit manifests, render inputs, render-request-v1/-v2 files, an export).
// Every request goes through the real route modules (loaded after JOBS_ROOT points at the
// fixtures, as the server starts); the clip listing runs the real Python CLI.
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { createSessionToken } from "../lib/auth.mjs";
import { loadClipEntries } from "../lib/clip-entry-view.mjs";
import { PYTHON_CLI_MODULES } from "../lib/python-cli.mjs";
import { loadProjectDetail, projectName, statusLabel } from "../lib/project-view.mjs";
import { clipScoreView, selectionNotes, selectionNotices } from "../lib/selection-v3-view.mjs";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const REPO = path.resolve(WEB, "..");
const AUTH = { APP_USERNAME: "admin", APP_PASSWORD: "secret-value", APP_SESSION_SECRET: "a-long-random-session-secret-value" };
const V1_ID = "d1e45678-e89b-42d3-a456-426614174101";
const V2_ID = "d1e45678-e89b-42d3-a456-426614174102";
const CANDIDATE = `cand_${"c".repeat(64)}`;
const SHA = "c".repeat(64);
const RETIRED_RENDERS = ["e1e45678-e89b-42d3-a456-426614174201", "e1e45678-e89b-42d3-a456-426614174202"];
const T0 = "2026-09-01T10:00:00.000Z";
const MP4 = Buffer.from("old clip mp4 bytes");
const EXPORT = Buffer.from("old candidate editor export");

function python() {
  const configured = process.env.PYTHON_BIN;
  if (configured) return configured.includes(path.sep) ? path.resolve(configured) : configured;
  return path.join(REPO, ".venv", "bin", "python");
}

function storedClip(id, index, extra = {}) {
  const base = `/api/jobs/${id}/files/output/clip-${String(index).padStart(2, "0")}`;
  return {
    index, score: 13 - index, start: 100 * index, end: 100 * index + 45, duration: 45,
    text: `Cerita lama nomor ${index} tentang tabungan`,
    videoUrl: `${base}.mp4`, downloadUrl: `${base}.mp4?download=1`, subtitleUrl: `${base}.srt?download=1`, ...extra,
  };
}

async function write(root, relative, content) {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, typeof content === "string" || Buffer.isBuffer(content) ? content : JSON.stringify(content));
}

function retiredRequest(renderId, version, state) {
  const value = {
    version, render_id: renderId, idempotency_key: renderId, state, candidate_id: CANDIDATE,
    candidate_artifact_sha256: SHA, candidate_snapshot_relative: `analysis/render-inputs/candidates.${SHA}.json`,
    edit_manifest_sha256: SHA, edit_revision: 1,
    edit_manifest_relative: `analysis/edits/archive/${CANDIDATE}.edit.v1.r1.${SHA}.json`,
    source_identity_sha256: SHA, source_content_sha256: SHA,
    source_snapshot_relative: `analysis/render-inputs/source.${SHA}.mp4`,
    output_relative: `output/edits/${CANDIDATE}/revision-1.mp4`, created_at: T0, updated_at: T0,
    claimed_at: state === "queued" ? null : T0, rendering_at: state === "completed" ? T0 : null,
    completed_at: state === "completed" ? T0 : null, failed_at: null, attempts: state === "queued" ? 0 : 1,
    error_code: null, lease_token: null, heartbeat_at: null,
  };
  if (version === "render-request-v2") {
    Object.assign(value, { storage_reservation_id: renderId, storage_reservation_token: renderId, storage_reserved_bytes: 4096 });
  }
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)));
}

async function fixtures(root) {
  const common = { status: "completed", progress: 100, stage: "Selesai", createdAt: T0, updatedAt: T0 };
  // an old job: no selection mode, no analysis directory
  await write(root, `${V1_ID}/job.json`, {
    id: V1_ID, ...common, source: { type: "upload", name: "podcast-lama.mp4" },
    sourcePath: `/data/jobs/${V1_ID}/input/podcast-lama.mp4`,
    options: { renderMode: "face-track", limit: 2, minDuration: 20, maxDuration: 60 },
    clips: [storedClip(V1_ID, 1), storedClip(V1_ID, 2)],
  });
  // an old candidates job that was edited and exported in the retired candidate editor
  await write(root, `${V2_ID}/job.json`, {
    id: V2_ID, ...common, source: { type: "upload", name: "obrolan-lama.mp4" },
    sourcePath: `/data/jobs/${V2_ID}/input/obrolan-lama.mp4`,
    options: { renderMode: "fit-blur", limit: 1, minDuration: 20, maxDuration: 60, selectionMode: "v2-shadow",
      clipProfile: "standard", maxCandidates: 200 },
    selectionV2: { mode: "v2-shadow", status: "completed", analysis_id: "a".repeat(32), selection_version: "selection-v2.0",
      candidate_count: 1, artifact: "analysis/candidates.v2.json", warnings: ["candidate 0:1: media_unavailable"] },
    clips: [storedClip(V2_ID, 1)],
  });
  for (const [id, count] of [[V1_ID, 2], [V2_ID, 1]]) {
    for (let index = 1; index <= count; index += 1) {
      await write(root, `${id}/output/clip-0${index}.mp4`, MP4);
      await write(root, `${id}/output/clip-0${index}.srt`, "1\n00:00:00,000 --> 00:00:01,000\nhalo\n");
    }
  }
  await write(root, `${V2_ID}/output/manifest.json`, { clips: [{ index: 1, start: 100, end: 145, text: "Cerita lama" }] });
  await write(root, `${V2_ID}/analysis/candidates.v2.json`, { selection_version: "selection-v2.0" });
  await write(root, `${V2_ID}/analysis/candidate-feedback.v1.json`, { feedback_version: "feedback-v1" });
  await write(root, `${V2_ID}/analysis/edits/${CANDIDATE}.edit.v1.json`, { edit_manifest_version: "clip-edit-v1.0" });
  await write(root, `${V2_ID}/analysis/edits/archive/${CANDIDATE}.edit.v1.r1.${SHA}.json`, "{}");
  await write(root, `${V2_ID}/analysis/render-inputs/candidates.${SHA}.json`, "{}");
  await write(root, `${V2_ID}/output/edits/${CANDIDATE}/revision-1.mp4`, EXPORT);
  await write(root, `${V2_ID}/analysis/render-requests/${RETIRED_RENDERS[0]}.json`,
    JSON.stringify(retiredRequest(RETIRED_RENDERS[0], "render-request-v1", "completed")));
  await write(root, `${V2_ID}/analysis/render-requests/${RETIRED_RENDERS[1]}.json`,
    JSON.stringify(retiredRequest(RETIRED_RENDERS[1], "render-request-v2", "queued")));
}

const ROOT = await mkdtemp(path.join(os.tmpdir(), "old-jobs-"));
after(() => rm(ROOT, { recursive: true, force: true }));
await fixtures(ROOT);
Object.assign(process.env, { ...AUTH, JOBS_ROOT: ROOT, POTONGIN_EDITOR_V3: "on", PYTHON_BIN: python() });
const clipsRoute = await import("../app/api/jobs/[id]/clips/route.js");
const filesRoute = await import("../app/api/jobs/[id]/files/[...path]/route.js");
const renderStatusRoute = await import("../app/api/jobs/[id]/renders/[renderId]/route.js");
const jobRoute = await import("../app/api/jobs/[id]/route.js");

const cookie = () => `potongin_session=${createSessionToken(AUTH, 2_000_000_000)}`;

// The browser's fetch, answered by the route modules the app serves.
async function appFetch(url) {
  const target = new URL(url, "http://local");
  const request = new Request(target, { headers: { Cookie: cookie(), Host: "local" } });
  const parts = target.pathname.split("/").slice(1).map(decodeURIComponent);
  assert.deepEqual(parts.slice(0, 2), ["api", "jobs"], url);
  const [id, kind, ...rest] = parts.slice(2);
  const params = (value) => ({ params: Promise.resolve(value) });
  if (kind === undefined) return jobRoute.GET(request, params({ id }));
  if (kind === "clips" && rest.length === 0) return clipsRoute.GET(request, params({ id }));
  if (kind === "files") return filesRoute.GET(request, params({ id, path: rest }));
  if (kind === "renders" && rest.length === 1) return renderStatusRoute.GET(request, params({ id, renderId: rest[0] }));
  throw new Error(`the project page does not request ${url}`);
}

test("old projects load with every clip, without old scores or version notices", async () => {
  for (const [id, count] of [[V1_ID, 2], [V2_ID, 1]]) {
    const loaded = await loadProjectDetail(id, { fetchImpl: appFetch });
    assert.equal(loaded.type, "loaded", id);
    const { job } = loaded;
    assert.equal(job.id, id);
    assert.equal(statusLabel(job.status), statusLabel("completed"));
    assert.ok(projectName(job).length > 0);
    assert.equal(job.clips.length, count);
    assert.equal("sourcePath" in job, false);
    assert.deepEqual(selectionNotices(job), []);
    assert.deepEqual(selectionNotes(job), []);
    for (const clip of job.clips) {
      assert.equal(clipScoreView(clip), null, "an old score is on another scale and is not shown");
      assert.match(clip.videoUrl, new RegExp(`^/api/jobs/${id}/files/output/clip-0\\d\\.mp4$`));
      assert.ok(clip.title && clip.description, "old clips get a title and a caption to copy");
    }
  }
});

test("old clips play and download, and so does an export of the retired editor", async () => {
  const { job } = await loadProjectDetail(V2_ID, { fetchImpl: appFetch });
  for (const url of [job.clips[0].videoUrl, job.clips[0].downloadUrl]) {
    const response = await appFetch(url);
    assert.equal(response.status, 200, url);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), MP4);
  }
  const subtitles = await appFetch(job.clips[0].subtitleUrl);
  assert.equal(subtitles.status, 200);
  assert.match(await subtitles.text(), /halo/);
  const exported = await appFetch(`/api/jobs/${V2_ID}/files/output/edits/${CANDIDATE}/revision-1.mp4?download=1`);
  assert.equal(exported.status, 200);
  assert.deepEqual(Buffer.from(await exported.arrayBuffer()), EXPORT);
});

test("the clip listing names old clips as not editable; old export statuses are not found", async () => {
  const queue = path.join(ROOT, V2_ID, "analysis", "render-requests");
  const before = await readdir(queue);
  // the oldest jobs have no output/manifest.json: nothing is listed, so no card offers the editor
  for (const [id, count] of [[V1_ID, 0], [V2_ID, 1]]) {
    const entries = await loadClipEntries(id, { fetchImpl: appFetch });
    assert.equal(entries.state, "available", id);
    assert.equal(entries.byIndex.size, count);
    for (const entry of entries.byIndex.values()) {
      assert.equal(entry.editHref, null);
      assert.equal(entry.reasonText, "Klip dari job ini tidak bisa diedit; proses ulang videonya");
      assert.equal(entry.latestExport, null);
    }
  }
  for (const renderId of RETIRED_RENDERS) {
    const response = await appFetch(`/api/jobs/${V2_ID}/renders/${renderId}`);
    assert.equal(response.status, 404, renderId);
    assert.deepEqual(await response.json(), { error: "Render tidak ditemukan", code: "not_found" });
  }
  // nothing was written into the old job's queue
  assert.deepEqual(await readdir(queue), before);
  assert.equal(JSON.parse(await readFile(path.join(queue, `${RETIRED_RENDERS[1]}.json`), "utf8")).state, "queued");
});

test("the web app keeps nothing of the retired editor's backend", async () => {
  const exists = (relative) => access(path.join(WEB, relative)).then(() => true, () => false);
  assert.equal(await exists("lib/render-requests.mjs"), false);
  const retiredModules = /ai_clipper\.(?:editor_api|edit_manifest|render_manifest|candidate_api|candidate_cues|candidate_feedback)\b/;
  for (const module of PYTHON_CLI_MODULES) assert.doesNotMatch(module, retiredModules);
  const files = [];
  for (const directory of ["app", "lib", "scripts", "components"]) {
    for (const entry of await readdir(path.join(WEB, directory), { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && /\.(?:m?js|jsx)$/.test(entry.name)) files.push(path.join(entry.parentPath ?? entry.path, entry.name));
    }
  }
  assert.ok(files.length > 50);
  for (const file of files) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, retiredModules, file);
    assert.doesNotMatch(source, /--job-dir|render-request-v1|createRenderRequest|sanitizeRenderStatus/, file);
  }
});
