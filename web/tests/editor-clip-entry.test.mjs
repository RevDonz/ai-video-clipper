// T2.6: the project page's editor entry per V3 clip (plan §4.2 GET/POST /clips, Appendix C.6) in
// web/lib/clip-entry-view.mjs: the "Edit klip" link, the edit badge, the latest export link and
// the openable/reason message. The listing route only exists with POTONGIN_EDITOR_V3=on.
import assert from "node:assert/strict";
import test from "node:test";

import { CLIP_REASON_TEXT, clipEntryView, loadClipEntries, prepareClipEntries } from "../lib/clip-entry-view.mjs";

const JOB = "8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55";
const CLIP = "clip_9b2e41c07d3a5f18e6c2a0b4";

function listing(fields = {}) {
  return {
    clipId: CLIP, index: 1, title: "Judul", hookText: "Hook", description: "Deskripsi", hashtags: ["#a"], durationMs: 42_000,
    engine: "edit-v2/1", edit: { state: "seed", revision: 0, etag: "a".repeat(64), updatedAtMs: 1 }, latestRender: null,
    openable: true, reason: null, ...fields,
  };
}

function response(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

test("an openable clip links to its editor; the seed reads 'Belum diedit'", () => {
  const view = clipEntryView(JOB, listing());
  assert.equal(view.editHref, `/projects/${JOB}/clips/${CLIP}/edit`);
  assert.equal(view.openable, true);
  assert.deepEqual(view.editBadge, { text: "Belum diedit", tone: "muted" });
  assert.equal(view.latestExport, null);
  assert.equal(view.reasonText, null);
  assert.equal(view.needsPrepare, false);
  assert.equal(view.engineLegacy, false);
});

test("an edited clip shows its revision and its latest export", () => {
  const view = clipEntryView(JOB, listing({
    edit: { state: "edited", revision: 3, etag: "b".repeat(64), updatedAtMs: 2 },
    latestRender: { renderId: "r-9", state: "completed", revision: 3,
      url: `/api/jobs/${JOB}/files/output/edits/${CLIP}/0123456789abcdef.mp4`,
      srtUrl: `/api/jobs/${JOB}/files/output/edits/${CLIP}/0123456789abcdef.srt` },
  }));
  assert.deepEqual(view.editBadge, { text: "Diedit · revisi 3", tone: "edited" });
  assert.deepEqual(view.latestExport, {
    label: "Ekspor terakhir · revisi 3", state: "completed",
    href: `/api/jobs/${JOB}/files/output/edits/${CLIP}/0123456789abcdef.mp4`,
    srtHref: `/api/jobs/${JOB}/files/output/edits/${CLIP}/0123456789abcdef.srt`,
  });
});

test("an export in progress or failed has no download link", () => {
  assert.deepEqual(clipEntryView(JOB, listing({ latestRender: { renderId: "r", state: "rendering", revision: 2, url: null, srtUrl: null } })).latestExport,
    { label: "Ekspor sedang diproses", state: "rendering", href: null, srtHref: null });
  assert.deepEqual(clipEntryView(JOB, listing({ latestRender: { renderId: "r", state: "queued", revision: 2, url: null, srtUrl: null } })).latestExport.label,
    "Ekspor sedang diproses");
  assert.deepEqual(clipEntryView(JOB, listing({ latestRender: { renderId: "r", state: "failed", revision: 2, url: null, srtUrl: null } })).latestExport,
    { label: "Ekspor terakhir gagal", state: "failed", href: null, srtHref: null });
  assert.equal(clipEntryView(JOB, listing({ latestRender: { renderId: "r", state: "cancelled", revision: 2, url: null, srtUrl: null } })).latestExport, null);
});

test("links never leave the job's own API paths", () => {
  const hostile = clipEntryView(JOB, listing({ latestRender: { renderId: "r", state: "completed", revision: 1,
    url: "javascript:alert(1)", srtUrl: "https://evil.example/x.srt" } }));
  assert.equal(hostile.latestExport.href, null);
  assert.equal(hostile.latestExport.srtHref, null);
  const otherJob = clipEntryView(JOB, listing({ latestRender: { renderId: "r", state: "completed", revision: 1,
    url: "/api/jobs/00000000-0000-4000-8000-000000000000/files/output/x.mp4", srtUrl: null } }));
  assert.equal(otherJob.latestExport.href, null);
  const traversal = clipEntryView(JOB, listing({ latestRender: { renderId: "r", state: "completed", revision: 1,
    url: `/api/jobs/${JOB}/../../x.mp4`, srtUrl: null } }));
  assert.equal(traversal.latestExport.href, null);
});

test("a clip that cannot open names its reason (Appendix C.6)", () => {
  assert.deepEqual(CLIP_REASON_TEXT, {
    needs_prepare: "Klip perlu disiapkan dulu",
    source_missing: "Video sumber sudah tidak ada",
    selection_unreadable: "Hasil seleksi tidak terbaca",
    transcript_missing: "Transkrip tidak ditemukan",
    analysis_incomplete: "Analisis job belum selesai",
    not_v3: "Job ini bukan job V3",
  });
  const missing = clipEntryView(JOB, listing({ openable: false, reason: "source_missing" }));
  assert.equal(missing.editHref, null);
  assert.equal(missing.reasonText, "Video sumber sudah tidak ada");
  const prepare = clipEntryView(JOB, listing({ clipId: null, edit: null, openable: false, reason: "needs_prepare" }));
  assert.equal(prepare.needsPrepare, true);
  assert.equal(prepare.reasonText, "Klip perlu disiapkan dulu");
  assert.equal(prepare.editBadge, null);
  const unknown = clipEntryView(JOB, listing({ openable: false, reason: "mystery" }));
  assert.equal(unknown.reasonText, "Klip ini belum bisa dibuka di editor");
});

test("a malformed clip id is never linked; a legacy-engine clip is flagged", () => {
  const bad = clipEntryView(JOB, listing({ clipId: "clip_../../x" }));
  assert.equal(bad.editHref, null);
  assert.equal(bad.openable, false);
  assert.equal(bad.reasonText, "Klip ini belum bisa dibuka di editor");
  assert.equal(clipEntryView(JOB, listing({ engine: "legacy" })).engineLegacy, true);
});

test("the listing loads by clip index; 404 means the editor is off", async () => {
  const calls = [];
  const loaded = await loadClipEntries(JOB, { fetchImpl: async (url, init) => {
    calls.push([url, init.cache]);
    return response(200, { clips: [listing(), listing({ index: 2, clipId: "clip_" + "1".repeat(24) })] });
  } });
  assert.deepEqual(calls, [[`/api/jobs/${JOB}/clips`, "no-store"]]);
  assert.equal(loaded.state, "available");
  assert.equal(loaded.byIndex.get(2).clipId, "clip_" + "1".repeat(24));
  assert.equal(loaded.byIndex.size, 2);
  assert.equal((await loadClipEntries(JOB, { fetchImpl: async () => response(404, { error: "x" }) })).state, "unavailable");
  assert.deepEqual(await loadClipEntries(JOB, { fetchImpl: async () => response(401, {}) }),
    { state: "redirect", location: `/login?next=${encodeURIComponent(`/projects/${JOB}`)}`, byIndex: new Map() });
  const failed = await loadClipEntries(JOB, { fetchImpl: async () => response(500, { error: "boom" }) });
  assert.equal(failed.state, "error");
  assert.equal(failed.message, "Status editor klip tidak dapat dimuat.");
  assert.equal((await loadClipEntries(JOB, { fetchImpl: async () => { throw new TypeError("offline"); } })).state, "error");
  assert.equal((await loadClipEntries(JOB, { fetchImpl: async () => response(200, { clips: "no" }) })).state, "error");
});

test("an aborted load rethrows the abort", async () => {
  const abort = new DOMException("aborted", "AbortError");
  await assert.rejects(loadClipEntries(JOB, { fetchImpl: async () => { throw abort; } }), (error) => error === abort);
});

test("preparing an older job posts once to the job-level route", async () => {
  const calls = [];
  const ok = await prepareClipEntries(JOB, { fetchImpl: async (url, init) => {
    calls.push([url, init.method, init.headers["Content-Type"], init.body]);
    return response(202, { state: "done" });
  } });
  assert.deepEqual(ok, { ok: true, message: "" });
  assert.deepEqual(calls, [[`/api/jobs/${JOB}/clips`, "POST", "application/json", "{}"]]);
  const busy = await prepareClipEntries(JOB, { fetchImpl: async () => response(503, { error: "sibuk" }) });
  assert.deepEqual(busy, { ok: false, message: "Klip belum bisa disiapkan. Coba lagi sebentar lagi." });
  const offline = await prepareClipEntries(JOB, { fetchImpl: async () => { throw new TypeError("offline"); } });
  assert.equal(offline.ok, false);
});
