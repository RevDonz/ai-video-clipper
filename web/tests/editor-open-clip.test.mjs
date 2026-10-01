// Opening a clip in the editor without a manual prepare step (owner feedback, W3): the clip
// reference in the URL (a clip id or "klip-<n>"), and the automatic job-level prepare with its
// polling (web/lib/editor/open-clip.mjs).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CLIP_REF_PREFIX, clipRefFromSegment, editorHref, prepareForEditor } from "../lib/editor/open-clip.mjs";

const JOB = "8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55";
const CLIP = `clip_${"a".repeat(24)}`;
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const entry = (fields) => ({ clipId: null, index: 1, openable: false, reason: null, edit: null, ...fields });

function server(script) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    calls.push(`${method} ${url}${init.body ? ` ${init.body}` : ""}`);
    const step = script.shift();
    if (!step) throw new Error(`unexpected ${method} ${url}`);
    return typeof step === "function" ? step(url, init) : step;
  };
  return { calls, fetchImpl };
}

const clock = () => {
  let at = 0;
  return { now: () => at, sleep: async (ms) => { at += ms; } };
};

test("a clip reference is a clip id or klip-<n>; nothing else opens the editor", () => {
  assert.equal(CLIP_REF_PREFIX, "klip-");
  assert.deepEqual(clipRefFromSegment(CLIP), { clipId: CLIP, index: null });
  assert.deepEqual(clipRefFromSegment("klip-3"), { clipId: null, index: 3 });
  assert.deepEqual(clipRefFromSegment("klip-42"), { clipId: null, index: 42 });
  for (const bad of ["klip-0", "klip-03", "klip-100", "klip-", "klip-1a", "clip_xyz", "../klip-1", "", null, 3]) {
    assert.equal(clipRefFromSegment(bad), null, String(bad));
  }
  assert.equal(editorHref(JOB, { clipId: CLIP }), `/projects/${JOB}/clips/${CLIP}/edit`);
  assert.equal(editorHref(JOB, { index: 4 }), `/projects/${JOB}/clips/klip-4/edit`);
  assert.equal(editorHref("../x", { clipId: CLIP }), null);
  assert.equal(editorHref(JOB, { clipId: "clip_../../x" }), null);
});

test("an openable clip opens at once: one listing, no prepare", async () => {
  const { calls, fetchImpl } = server([json(200, { clips: [entry({ clipId: CLIP, openable: true })] })]);
  const result = await prepareForEditor({ jobId: JOB, clipId: CLIP, fetchImpl, ...clock() });
  assert.deepEqual(result, { state: "ready", clipId: CLIP, prepared: false });
  assert.deepEqual(calls, [`GET /api/jobs/${JOB}/clips`]);
});

test("a clip that needs preparing is prepared once, then opens by its index", async () => {
  const progress = [];
  // The prepare answer is read to the end: a body left unread is cut off (net::ERR_ABORTED) when
  // the editor later aborts its signal on leaving the prepare step.
  const prepareAnswer = json(202, { state: "done", clips: [] });
  const { calls, fetchImpl } = server([
    json(200, { clips: [entry({ index: 1, reason: "needs_prepare" }), entry({ index: 2, reason: "needs_prepare" })] }),
    prepareAnswer,
    json(200, { clips: [entry({ index: 1, clipId: CLIP, openable: true }), entry({ index: 2, clipId: `clip_${"b".repeat(24)}`, openable: true })] }),
  ]);
  const result = await prepareForEditor({ jobId: JOB, index: 2, fetchImpl, onProgress: (step) => progress.push(step.phase), ...clock() });
  assert.deepEqual(result, { state: "ready", clipId: `clip_${"b".repeat(24)}`, prepared: true });
  assert.deepEqual(calls, [`GET /api/jobs/${JOB}/clips`, `POST /api/jobs/${JOB}/clips {}`, `GET /api/jobs/${JOB}/clips`]);
  assert.deepEqual(progress, ["preparing", "checking"]);
  assert.equal(prepareAnswer.bodyUsed, true);
});

test("a prepare that is still running elsewhere is waited for, polling the listing", async () => {
  const { calls, fetchImpl } = server([
    json(200, { clips: [entry({ clipId: CLIP, reason: "needs_prepare" })] }),
    json(429, { code: "rate_limited" }, { "retry-after": "3" }),
    json(200, { clips: [entry({ clipId: CLIP, reason: "analysis_incomplete" })] }),
    json(200, { clips: [entry({ clipId: CLIP, openable: true })] }),
  ]);
  const time = clock();
  const result = await prepareForEditor({ jobId: JOB, clipId: CLIP, fetchImpl, pollMs: 2000, ...time });
  assert.deepEqual(result, { state: "ready", clipId: CLIP, prepared: true });
  assert.equal(calls.length, 4);
  assert.equal(time.now(), 3000 + 2000, "waits Retry-After, then one poll interval");
});

test("a clip that cannot be edited names its reason and never prepares", async () => {
  const { calls, fetchImpl } = server([json(200, { clips: [entry({ clipId: CLIP, reason: "source_missing" })] })]);
  const result = await prepareForEditor({ jobId: JOB, clipId: CLIP, fetchImpl, ...clock() });
  assert.deepEqual(result, { state: "error", code: "source_missing", message: "Video sumber sudah tidak ada" });
  assert.equal(calls.length, 1);
});

test("an unknown clip, a disabled editor, a lost session and a failed prepare are told apart", async () => {
  let result = await prepareForEditor({ jobId: JOB, clipId: CLIP, ...server([json(200, { clips: [] })]), ...clock() });
  assert.deepEqual(result, { state: "error", code: "not_found", message: "Klip ini tidak ada di proyek ini" });
  result = await prepareForEditor({ jobId: JOB, index: 1, ...server([json(404, { code: "editor_disabled" })]), ...clock() });
  assert.equal(result.code, "editor_disabled");
  result = await prepareForEditor({ jobId: JOB, index: 1, ...server([json(401, {})]), ...clock() });
  assert.deepEqual(result, { state: "redirect", location: `/login?next=${encodeURIComponent(`/projects/${JOB}/clips/klip-1/edit`)}` });
  result = await prepareForEditor({ jobId: JOB, index: 1, ...server([
    json(200, { clips: [entry({ reason: "needs_prepare" })] }),
    json(500, { code: "internal_error" }),
  ]), ...clock() });
  assert.deepEqual(result, { state: "error", code: "prepare_failed", message: "Klip belum bisa disiapkan. Coba lagi sebentar lagi." });
  result = await prepareForEditor({ jobId: JOB, index: 1, ...server([async () => { throw new TypeError("offline"); }]), ...clock() });
  assert.equal(result.code, "network");
});

test("the editor page opens a clip id or klip-<n>, passes the uploads flag, and names no version", async () => {
  const source = await readFile(new URL("../app/projects/[id]/clips/[clipId]/edit/page.jsx", import.meta.url), "utf8");
  assert.match(source, /const ref = clipRefFromSegment\(segment\);/);
  assert.match(source, /if \(mode === "off" \|\| !here\) notFound\(\);/);
  assert.match(source, /<EditorApp jobId=\{id\} clipId=\{ref\.clipId\} clipIndex=\{ref\.index\} runtimeKind=\{mode\} features=\{\{ uploads: flags\.uploads \}\} \/>/);
  assert.match(source, /title: "Edit klip · Potongin"/);
});

test("preparing gives up after the time limit instead of polling forever", async () => {
  const stuck = () => json(200, { clips: [entry({ clipId: CLIP, reason: "analysis_incomplete" })] });
  const script = [json(200, { clips: [entry({ clipId: CLIP, reason: "needs_prepare" })] }), json(202, { state: "pending" })];
  for (let i = 0; i < 100; i += 1) script.push(stuck());
  const result = await prepareForEditor({ jobId: JOB, clipId: CLIP, ...server(script), pollMs: 2000, maxWaitMs: 10_000, ...clock() });
  assert.deepEqual(result, { state: "error", code: "prepare_timeout", message: "Menyiapkan klip terlalu lama. Muat ulang halaman untuk mencoba lagi." });
});
