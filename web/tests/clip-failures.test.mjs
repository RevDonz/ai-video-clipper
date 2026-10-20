// A clip that failed to render (the pipeline's per-clip isolation): the job keeps it with its
// packaging, "status: failed" and a short code, but without a file. The worker and the job API
// keep it that way, and every view shows it as "Gagal" with nothing to play, pick, download
// or edit.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { historyOffersEdit } from "../lib/clip-entry-view.mjs";
import {
  CLIP_ERROR_CODES,
  clipCountText,
  clipCounts,
  clipErrorCode,
  failedClipView,
  isFailedClip,
  readyClips,
} from "../lib/clip-status.mjs";
import { serializePublicJob, sanitizeStoredClip } from "../lib/jobs.mjs";
import { historySummary, projectRowDetail } from "../lib/project-view.mjs";
import { clipsHeading, pickAll, prunePicks } from "../lib/project-workspace.mjs";
import { jobClipFromManifest } from "../scripts/run-job.mjs";

const JOB_ID = "123e4567-e89b-42d3-a456-426614174000";
const OUTPUT = "/data/jobs/123e4567-e89b-42d3-a456-426614174000/output";

// The engine's entry for a failed clip (src/ai_clipper/pipeline.py _failed_manifest_clip).
const FAILED_ENTRY = {
  index: 2, start: 160, end: 190, duration: 30, score: 7.25, text: "Teks klip.",
  output: null, subtitles: null, thumbnail: null,
  title: "Klip yang gagal", hook_text: "Hook singkat", description: "Deskripsi klip.",
  hashtags: ["#podcastindonesia"], archetype: "humor", selection_source: "llm", reasons: ["Alasan kuat."],
  scores: { hook: 8, standalone: 7, payoff: 6, emotion: 5, shareability: 4 }, cold_open: null,
  source_start: 160, source_end: 190, status: "failed", error_code: "render_failed",
};
const READY_ENTRY = {
  ...FAILED_ENTRY, index: 1, start: 100, end: 130, source_start: 100, source_end: 130, title: "Klip jadi",
  output: `${OUTPUT}/clip-01.mp4`, subtitles: `${OUTPUT}/clip-01.srt`, thumbnail: `${OUTPUT}/clip-01.jpg`,
};
delete READY_ENTRY.status;
delete READY_ENTRY.error_code;

const URL_KEYS = ["videoUrl", "downloadUrl", "subtitleUrl", "thumbnailUrl"];

function readyClip(index, extra = {}) {
  const base = `/api/jobs/${JOB_ID}/files/output/clip-${String(index).padStart(2, "0")}`;
  return { index, score: 7, duration: 30, text: "transkrip", title: `Klip ${index}`, videoUrl: `${base}.mp4`, downloadUrl: `${base}.mp4?download=1`, subtitleUrl: `${base}.srt?download=1`, ...extra };
}
const failedClip = (index, extra = {}) => ({ index, score: 9, duration: 30, text: "transkrip", title: `Klip ${index}`, status: "failed", errorCode: "render_failed", ...extra });

test("the codes are the engine's; anything else reads as a failed render", () => {
  assert.deepEqual(CLIP_ERROR_CODES, ["render_failed", "render_timeout"]);
  assert.equal(clipErrorCode("render_timeout"), "render_timeout");
  for (const value of [undefined, null, "", "ffmpeg exploded", "RENDER_FAILED", 3]) assert.equal(clipErrorCode(value), "render_failed");
});

test("only status 'failed' marks a clip as failed", () => {
  assert.equal(isFailedClip(failedClip(1)), true);
  for (const clip of [readyClip(1), { status: "ok" }, { status: "FAILED" }, null, undefined, "failed"]) assert.equal(isFailedClip(clip), false);
  const clips = [readyClip(1), failedClip(2), readyClip(3)];
  assert.deepEqual(readyClips(clips).map((clip) => clip.index), [1, 3]);
  assert.deepEqual(readyClips(null), []);
  assert.deepEqual(clipCounts(clips), { total: 3, ready: 2, failed: 1 });
  assert.deepEqual(clipCounts(undefined), { total: 0, ready: 0, failed: 0 });
});

test("the clip count names the failed clips only when there are some", () => {
  assert.equal(clipCountText([readyClip(1), readyClip(2)]), "2 klip");
  assert.equal(clipCountText([readyClip(1), failedClip(2), failedClip(3)]), "1 klip · 2 gagal");
  assert.equal(clipCountText([]), "0 klip");
});

test("a failed clip's card says what happened and what to do; a ready clip has no such view", () => {
  assert.equal(failedClipView(readyClip(1)), null);
  assert.deepEqual(failedClipView(failedClip(2)), {
    label: "Gagal",
    text: "Render klip ini gagal.",
    hint: "Klip lain tidak terpengaruh. Untuk mencoba lagi, proses ulang videonya.",
  });
  assert.equal(failedClipView(failedClip(2, { errorCode: "render_timeout" })).text, "Render klip ini melewati batas waktu.");
  assert.equal(failedClipView(failedClip(2, { errorCode: "<b>x</b>" })).text, "Render klip ini gagal.");
  for (const view of [failedClipView(failedClip(2)), failedClipView(failedClip(2, { errorCode: "render_timeout" }))]) {
    assert.doesNotMatch(Object.values(view).join(" "), /—/);
  }
});

test("the worker keeps a failed manifest clip with its packaging and without any file link", () => {
  const clip = jobClipFromManifest(FAILED_ENTRY, JOB_ID, 1);
  assert.equal(clip.status, "failed");
  assert.equal(clip.errorCode, "render_failed");
  assert.equal(clip.index, 2);
  assert.equal(clip.title, "Klip yang gagal");
  assert.equal(clip.hookText, "Hook singkat");
  assert.deepEqual([clip.start, clip.end, clip.duration, clip.score], [160, 190, 30, 7.25]);
  assert.equal(clip.sourceStart, 160);
  for (const key of URL_KEYS) assert.equal(key in clip, false, key);
  assert.doesNotMatch(JSON.stringify(clip), /\/data\/jobs/);

  const timedOut = jobClipFromManifest({ ...FAILED_ENTRY, error_code: "render_timeout" }, JOB_ID);
  assert.equal(timedOut.errorCode, "render_timeout");
  const odd = jobClipFromManifest({ ...FAILED_ENTRY, error_code: "Traceback: /secret/path" }, JOB_ID);
  assert.equal(odd.errorCode, "render_failed");
  assert.doesNotMatch(JSON.stringify(odd), /secret/);
  // A failed entry that still names files gets no link to them, and no engine either.
  const named = jobClipFromManifest({
    ...FAILED_ENTRY, output: `${OUTPUT}/clip-02.mp4`, subtitles: `${OUTPUT}/clip-02.srt`, thumbnail: `${OUTPUT}/clip-02.jpg`,
    clip_id: `clip_${"a".repeat(24)}`, render_engine: "legacy",
  }, JOB_ID, 1, { thumbnails: new Set(["clip-02.jpg"]) });
  for (const key of [...URL_KEYS, "clipId", "renderEngine"]) assert.equal(key in named, false, key);
});

test("a ready manifest clip keeps exactly its shape", () => {
  const clip = jobClipFromManifest(READY_ENTRY, JOB_ID, 0);
  assert.equal("status" in clip, false);
  assert.equal("errorCode" in clip, false);
  assert.equal(clip.videoUrl, `/api/jobs/${JOB_ID}/files/output/clip-01.mp4`);
  // A status the engine never writes is not a failure: the clip stays as it is.
  assert.deepEqual(jobClipFromManifest({ ...READY_ENTRY, status: "ok" }, JOB_ID, 0), clip);
});

test("the job API serves a failed clip as failed and never with a file link", () => {
  const stored = jobClipFromManifest(FAILED_ENTRY, JOB_ID, 1);
  assert.deepEqual(sanitizeStoredClip(stored, JOB_ID), stored);
  const tampered = sanitizeStoredClip({ ...stored, ...readyClip(2), status: "failed", errorCode: "boom", thumbnailUrl: `/api/jobs/${JOB_ID}/files/output/clip-02.jpg` }, JOB_ID);
  assert.equal(tampered.status, "failed");
  assert.equal(tampered.errorCode, "render_failed");
  for (const key of URL_KEYS) assert.equal(key in tampered, false, key);
  // On a clip that did not fail, a stray status or code is dropped and nothing else changes.
  const ready = readyClip(1);
  assert.deepEqual(sanitizeStoredClip({ ...ready, status: "pending", errorCode: "render_failed" }, JOB_ID), ready);
  assert.deepEqual(sanitizeStoredClip(ready, JOB_ID), ready);
  // An old clip without any of it is returned untouched.
  const old = { index: 1, text: "x", videoUrl: "/api/jobs/x/files/output/clip-01.mp4" };
  assert.equal(sanitizeStoredClip(old, JOB_ID), old);

  const job = serializePublicJob({ id: JOB_ID, status: "completed", options: { selectionMode: "v3" }, clips: [readyClip(1), stored] });
  assert.deepEqual(job.clips.map((clip) => clip.status ?? "ready"), ["ready", "failed"]);
  for (const key of URL_KEYS) assert.equal(key in job.clips[1], false, key);
});

test("history rows and the summary count the clips that are ready", () => {
  const job = { status: "completed", clips: [readyClip(1), failedClip(2), readyClip(3)] };
  assert.equal(projectRowDetail(job), "2 klip · 1 gagal");
  assert.equal(projectRowDetail({ status: "completed", clips: [readyClip(1)] }), "1 klip");
  assert.equal(historySummary([job, { status: "completed", clips: [readyClip(1)] }]), "2 proyek · 3 klip");
});

test("the clips heading says how many of them are ready to post", () => {
  assert.equal(clipsHeading([readyClip(1), readyClip(2)], "completed"), "2 klip siap diunggah");
  assert.equal(clipsHeading([readyClip(1), failedClip(2), readyClip(3)], "completed"), "2 dari 3 klip siap diunggah");
  assert.equal(clipsHeading([readyClip(1), failedClip(2)], "processing"), "2 klip");
});

test("'Pilih semua' never picks a failed clip, and a failed clip never stays picked", () => {
  const visible = [readyClip(1), failedClip(2), readyClip(3)];
  assert.deepEqual([...pickAll(visible)], [1, 3]);
  assert.deepEqual([...prunePicks(new Set([1, 2, 3]), visible)], [1, 3]);
});

test("the history offers 'Edit klip' only when a clip is ready", () => {
  const base = { status: "completed", options: { selectionMode: "v3" } };
  assert.equal(historyOffersEdit({ ...base, clips: [failedClip(1), readyClip(2)] }, true), true);
  assert.equal(historyOffersEdit({ ...base, clips: [failedClip(1)] }, true), false);
});

test("the project page and the dashboard show a failed clip as 'Gagal' in place of the player", async () => {
  const project = await readFile(new URL("../app/projects/[id]/page.jsx", import.meta.url), "utf8");
  // The poster: "Gagal" in its frame (the shared poster draws the badge instead of the frame);
  // the detail: a frame with the reason where the video would be.
  assert.match(project, /badge=\{failed && <span className="chip error">\{failed\.label\}<\/span>\}>/);
  const poster = await readFile(new URL("../components/ClipPoster.jsx", import.meta.url), "utf8");
  assert.match(poster, /\{badge \|\| \(poster \? <img /);
  assert.match(project, /<div key=\{clip\.index\} className=\{`\$\{styles\.video\} \$\{styles\.failedFrame\}`\}>/);
  assert.match(project, /<p><strong>\{failed\.text\}<\/strong><\/p>\s*<p>\{failed\.hint\}<\/p>/);
  assert.match(project, /<h2 id="clips-title">\{clipsHeading\(clips, job\.status\)\}<\/h2>/);
  assert.match(project, /\{clipCount > 0 && <span>\{clipCountLabel\}<\/span>\}/);
  // Its title and description cannot be changed ("Ubah", "Tulis ulang"): there is no video to post.
  assert.match(project, /editable=\{job\.status === "completed" && !failed\}/);
  const dashboard = await readFile(new URL("../app/dashboard/page.jsx", import.meta.url), "utf8");
  assert.match(dashboard, /if \(failed\) return <FailedClipCard clip=\{clip\} failed=\{failed\} \/>;/);
  const card = dashboard.slice(dashboard.indexOf("function FailedClipCard"), dashboard.indexOf("function ClipCard"));
  assert.doesNotMatch(card, /<video|downloadUrl|onCopy/);
});
