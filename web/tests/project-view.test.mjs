// The project history (/projects) and one project's page (/projects/[id]) show the latest
// method only: no version labels, no candidate editor, no technical provenance. Jobs made
// with older selection modes keep their rendered clips, shown like every other clip.
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { GET as getJobDetail } from "../app/api/jobs/[id]/route.js";
import RetiredCandidatePage from "../app/projects/[id]/candidates/[[...rest]]/page.js";
import { createSessionToken } from "../lib/auth.mjs";
import { historyOffersEdit } from "../lib/clip-entry-view.mjs";
import { generateSocialMetadata, serializePublicJob } from "../lib/jobs.mjs";
import {
  ProjectDetailLoadError,
  clipLabel,
  failureDetail,
  formatProjectDate,
  historySummary,
  isActiveStatus,
  loadProjectDetail,
  matchesProjectFilter,
  matchesProjectQuery,
  projectName,
  projectProgress,
  projectRowDetail,
  projectStageText,
  statusLabel,
} from "../lib/project-view.mjs";
import {
  clipReasons,
  clipScoreView,
  focusSummaryLine,
  selectionNotes,
  selectionNotices,
  selectionWarningLabel,
} from "../lib/selection-v3-view.mjs";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFile(path.join(WEB, relative), "utf8");
const exists = (relative) => access(path.join(WEB, relative)).then(() => true, () => false);

const JOB_ID = "123e4567-e89b-42d3-a456-426614174000";
const AUTH_ENV = {
  APP_USERNAME: "admin",
  APP_PASSWORD: "secret-value",
  APP_SESSION_SECRET: "a-long-random-session-secret-value",
};

const SUMMARY = {
  mode: "v3", status: "completed", source: "llm", provider: "ollama-cloud", model: "gpt-oss:120b",
  prompt_version: "hooks-v3.1", warnings: [], artifact: "analysis/selection.v3.json", transcript_source: "youtube-captions",
};
const V3_OPTIONS = { renderMode: "fit-blur", limit: 3, minDuration: 20, maxDuration: 60, selectionMode: "v3", llmMode: "auto" };
const V3_CLIP = {
  index: 1, score: 7.4, start: 10, end: 40, duration: 30, text: "transkrip", title: "Judul", description: "Isi.\n\n#fyp", hashtags: ["#fyp"],
  selectionSource: "llm", scores: { hook: 8, standalone: 7, payoff: 6, emotion: 5, shareability: 9 },
  reasons: ["Pembukanya langsung ke inti.", "Peringkat ulang LLM: 4,8/10"],
  videoUrl: "/v", downloadUrl: "/d", subtitleUrl: "/s",
};
const legacyClip = (score) => ({
  index: 1, score, start: 0, end: 30, duration: 30, text: "Klip lama tentang tabungan",
  videoUrl: "/v", downloadUrl: "/d", subtitleUrl: "/s", ...generateSocialMetadata("Klip lama tentang tabungan"),
});

// --- Loading one project ----------------------------------------------------------------------

test("the project page asks only for the job: no candidate or feedback request", async () => {
  const controller = new AbortController();
  const calls = [];
  const result = await loadProjectDetail(JOB_ID, {
    signal: controller.signal,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json({ job: { id: JOB_ID, status: "completed", clips: [] } });
    },
  });
  assert.deepEqual(calls.map((call) => call.url), [`/api/jobs/${JOB_ID}`]);
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(calls[0].options.cache, "no-store");
  assert.deepEqual(result, { type: "loaded", job: { id: JOB_ID, status: "completed", clips: [] } });
});

test("an expired session goes to login and comes back to the project", async () => {
  const result = await loadProjectDetail(JOB_ID, { fetchImpl: async () => Response.json({ error: "expired" }, { status: 401 }) });
  assert.deepEqual(result, { type: "redirect", location: `/login?next=${encodeURIComponent(`/projects/${JOB_ID}`)}` });
});

test("a missing project, a server error and a dropped connection say what happened", async () => {
  await assert.rejects(
    loadProjectDetail(JOB_ID, { fetchImpl: async () => Response.json({ error: "Job tidak ditemukan" }, { status: 404 }) }),
    (error) => error instanceof ProjectDetailLoadError && error.kind === "not-found" && /tidak ada atau sudah dihapus/.test(error.message),
  );
  await assert.rejects(
    loadProjectDetail(JOB_ID, { fetchImpl: async () => Response.json({ error: "Detail job tidak dapat dibaca" }, { status: 500 }) }),
    (error) => error instanceof ProjectDetailLoadError && error.kind === "request" && /tidak bisa dimuat/.test(error.message),
  );
  await assert.rejects(
    loadProjectDetail(JOB_ID, { fetchImpl: async () => { throw new TypeError("fetch failed"); } }),
    (error) => error instanceof ProjectDetailLoadError && error.kind === "network" && /koneksi/.test(error.message),
  );
  const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
  await assert.rejects(loadProjectDetail(JOB_ID, { fetchImpl: async () => { throw aborted; } }), (error) => error === aborted);
  await assert.rejects(
    loadProjectDetail(JOB_ID, { fetchImpl: async () => Response.json({}, { status: 200 }) }),
    (error) => error instanceof ProjectDetailLoadError && error.kind === "request",
  );
});

test("job detail disables storage for auth, validation, success, missing, and server error responses", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clipper-job-detail-"));
  const jobRoot = path.join(root, JOB_ID);
  await mkdir(jobRoot, { recursive: true });
  const previous = Object.fromEntries(["JOBS_ROOT", ...Object.keys(AUTH_ENV)].map((name) => [name, process.env[name]]));
  Object.assign(process.env, AUTH_ENV, { JOBS_ROOT: root });
  const token = createSessionToken(AUTH_ENV, 2_000_000_000);
  const request = (id = JOB_ID, authenticated = true) => new Request(`http://local/api/jobs/${id}`, {
    headers: authenticated ? { Cookie: `potongin_session=${token}` } : {},
  });
  const invoke = (id = JOB_ID, authenticated = true) => getJobDetail(request(id, authenticated), {
    params: Promise.resolve({ id }),
  });

  try {
    const denied = await invoke(JOB_ID, false);
    const invalid = await invoke("not-a-uuid");
    const missing = await invoke("223e4567-e89b-42d3-a456-426614174000");
    await writeFile(path.join(jobRoot, "job.json"), JSON.stringify({ id: JOB_ID, clips: [] }));
    const success = await invoke();
    await writeFile(path.join(jobRoot, "job.json"), "not json");
    const failed = await invoke();

    assert.deepEqual([denied.status, invalid.status, missing.status, success.status, failed.status], [401, 400, 404, 200, 500]);
    for (const response of [denied, invalid, missing, success, failed]) {
      assert.equal(response.headers.get("Cache-Control"), "no-store");
    }
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

// --- What a clip card shows -------------------------------------------------------------------

test("only clips of the current selection get a score; older clips show none", () => {
  assert.deepEqual(clipScoreView(V3_CLIP), {
    total: 7.4,
    rows: [
      { name: "hook", label: "Hook", value: 8, percent: 80 },
      { name: "standalone", label: "Berdiri sendiri", value: 7, percent: 70 },
      { name: "payoff", label: "Payoff", value: 6, percent: 60 },
      { name: "emotion", label: "Emosi", value: 5, percent: 50 },
      { name: "shareability", label: "Layak dibagikan", value: 9, percent: 90 },
    ],
  });
  assert.deepEqual(clipScoreView({ ...V3_CLIP, selectionSource: "heuristic", scores: undefined }), { total: 7.4, rows: [] });
  // An old clip's score is on another scale, even when it happens to fall between 0 and 10.
  for (const clip of [legacyClip(9), legacyClip(13), { ...V3_CLIP, selectionSource: "v1" }, { ...V3_CLIP, score: 42, scores: null }, null]) {
    assert.equal(clipScoreView(clip), null, JSON.stringify(clip?.score));
  }
});

test("why a clip was chosen keeps the reasons and drops the engine's rerank bookkeeping", () => {
  assert.deepEqual(clipReasons(V3_CLIP), ["Pembukanya langsung ke inti."]);
  assert.deepEqual(clipReasons({ reasons: ["  ", 7, "Ada 2 tawa di dalam klip."] }), ["Ada 2 tawa di dalam klip."]);
  assert.deepEqual(clipReasons(legacyClip(9)), []);
});

test("an old job serializes with its clips and gets no notices, scores or focus line", () => {
  const job = serializePublicJob({
    id: JOB_ID, status: "completed", options: { renderMode: "face-track", limit: 1, minDuration: 20, maxDuration: 60 },
    clips: [legacyClip(13)], sourcePath: "/private/source.mp4",
  });
  assert.equal(job.clips.length, 1);
  assert.equal(job.clips[0].videoUrl, "/v");
  assert.equal(job.clips[0].subtitleUrl, "/s");
  assert.deepEqual(selectionNotices(job), []);
  assert.equal(clipScoreView(job.clips[0]), null);
  assert.equal(focusSummaryLine(job), null);
  // The caption written for an old clip reads without an em dash (R-02), here and when copied.
  const stored = serializePublicJob({ id: JOB_ID, status: "completed", clips: [{ index: 1, text: "Klip lama tentang tabungan", videoUrl: "/v", downloadUrl: "/d" }] });
  for (const clip of [job.clips[0], stored.clips[0]]) {
    assert.match(clip.description, /Simak sampai akhir\. Bagian mana yang paling relate buat kamu\?/);
    assert.doesNotMatch(clip.description, /—/);
  }
});

// --- Notices: what the owner can act on, nothing else ----------------------------------------

test("a clean AI run shows no notice: provider, model, prompt and transcript stay off screen", () => {
  assert.deepEqual(selectionNotices({ options: V3_OPTIONS, selectionV3: SUMMARY }), []);
  const noisy = { ...SUMMARY, warnings: ["no_word_timestamps", "llm_error:openrouter/qwen:rate_limited", "suspect_segments:10", "llm_filled:2"] };
  assert.deepEqual(selectionNotices({ options: V3_OPTIONS, selectionV3: noisy }), []);
});

test("a fallback run says the AI failed and where to fix it", () => {
  const [notice, ...rest] = selectionNotices({ options: V3_OPTIONS, selectionV3: { ...SUMMARY, status: "fallback", source: "heuristic" } });
  assert.equal(rest.length, 0);
  assert.equal(notice.tone, "warning");
  assert.match(notice.title, /AI gagal/);
  assert.match(notice.text, /API key atau kuota/);
  assert.deepEqual([notice.href, notice.action], ["/settings", "Buka Pengaturan"]);
});

test("a run without AI says so, unless the owner turned AI off for that job", () => {
  const heuristic = { ...SUMMARY, source: "heuristic", provider: null, model: null };
  const [notice] = selectionNotices({ options: V3_OPTIONS, selectionV3: heuristic });
  assert.equal(notice.tone, "info");
  assert.match(notice.title, /tanpa AI/);
  assert.equal(notice.href, "/settings");
  assert.deepEqual(selectionNotices({ options: { ...V3_OPTIONS, llmMode: "off" }, selectionV3: heuristic }), []);
});

test("warnings the owner can act on become notices; every other explained one is a note", () => {
  const summary = {
    ...SUMMARY,
    warnings: [
      "trend_sensitive_humor:2", "focus_terms_unmatchable:1", "trend_items_skipped:3", "trend_context_invalid",
      "trend_ref_ungrounded:1", "trend_packaging_ungrounded:1", "focus_few_matches:2", "focus_few_matches:0",
      "focus_literal_ungrounded:3", "focus_packaging_ungrounded:2", "focus_topup:2", "focus_topup_failed:rate_limited",
      "focus_topup_skipped:budget", "llm_dropped:1:too_long", "llm_filled:2", "suspect_segments:10",
    ],
  };
  const job = { options: V3_OPTIONS, selectionV3: summary };
  const notices = selectionNotices(job);
  // The same Indonesian explanations as before, unchanged: Konteks Tren and Fokus klip keep their wording.
  assert.deepEqual(notices.map((notice) => notice.text), [
    selectionWarningLabel("trend_sensitive_humor:2"),
    selectionWarningLabel("focus_terms_unmatchable:1"),
    selectionWarningLabel("trend_items_skipped:3"),
    selectionWarningLabel("trend_context_invalid"),
  ]);
  assert.ok(notices.every((notice) => notice.tone === "warning"));
  assert.deepEqual(notices.map((notice) => notice.href ?? null), [null, null, "/trends", "/trends"]);
  assert.deepEqual(selectionNotes(job), [
    "trend_ref_ungrounded:1", "trend_packaging_ungrounded:1", "focus_few_matches:2", "focus_few_matches:0",
    "focus_literal_ungrounded:3", "focus_packaging_ungrounded:2", "focus_topup:2", "focus_topup_failed:rate_limited",
    "focus_topup_skipped:budget",
  ].map(selectionWarningLabel));
  // Codes the engine writes for itself have no explanation and are neither a notice nor a note.
  for (const text of [...notices.map((notice) => notice.text), ...selectionNotes(job)]) {
    assert.ok(text);
    assert.doesNotMatch(text, /\b(trend|focus|llm)_[a-z_]+|suspect_segments|—|\bV[1-3]\b|prompt/);
  }
  assert.deepEqual(selectionNotes({ options: V3_OPTIONS, selectionV3: SUMMARY }), []);
  assert.deepEqual(selectionNotes({ options: V3_OPTIONS }), []);
  assert.deepEqual(selectionNotes(null), []);
});

test("the focus line separates the count with a middle dot, not an em dash", () => {
  const job = { options: V3_OPTIONS, selectionV3: { ...SUMMARY, focus: { terms: ["jomok", "jomokers"], matched: 5, requested: 8 } } };
  assert.equal(focusSummaryLine(job).text, "Fokus: jomok, jomokers · 5 dari 8 klip cocok");
  for (const code of ["trend_sensitive_humor:1", "focus_terms_unmatchable:2", "trend_items_skipped:1", "trend_context_invalid"]) {
    assert.doesNotMatch(selectionWarningLabel(code), /—/, code);
  }
});

// --- History helpers --------------------------------------------------------------------------

test("project names, dates, statuses and clip labels read like a person wrote them", () => {
  assert.equal(projectName({ id: JOB_ID, source: { type: "upload", name: "episode-12.mp4" } }), "episode-12.mp4");
  assert.equal(projectName({ id: JOB_ID, source: { type: "youtube", url: "https://www.youtube.com/watch?v=Ive926sC6mc" } }), "YouTube · Ive926sC6mc");
  assert.equal(projectName({ id: JOB_ID, source: { type: "youtube", url: "https://youtu.be/abc123" } }), "YouTube · abc123");
  assert.equal(projectName({ id: JOB_ID, source: { type: "youtube", url: "not a url" } }), "Video YouTube");
  assert.equal(projectName({ id: JOB_ID }), "Proyek 123e4567");
  assert.equal(projectName(null), "Proyek");
  assert.equal(formatProjectDate(undefined), "Tanggal tidak tersedia");
  assert.equal(formatProjectDate("bukan tanggal"), "Tanggal tidak tersedia");
  assert.match(formatProjectDate("2026-09-30T07:25:00.000Z"), /30 Sep 2026/);
  assert.equal(statusLabel("completed"), "Selesai");
  assert.equal(statusLabel("deleting"), "Menghapus");
  assert.equal(statusLabel("weird"), "Status tidak dikenal");
  assert.equal(isActiveStatus("processing"), true);
  assert.equal(isActiveStatus("completed"), false);
  assert.equal(isActiveStatus("deleting"), false);
  assert.equal(projectProgress({ progress: 140 }), 100);
  assert.equal(projectProgress({ progress: Number.NaN }), 0);
  assert.equal(clipLabel({ index: 3, duration: 81.01 }), "Klip 03 · 1:21");
  assert.equal(clipLabel({ index: 12, duration: null }), "Klip 12");
});

test("history filters and search find projects by name, ID, URL, clip title or transcript", () => {
  const jobs = [
    { id: JOB_ID, status: "completed", source: { type: "upload", name: "podcast.mp4" }, clips: [{ title: "Rahasia copet", text: "mutus ngambang" }] },
    { id: "223e4567-e89b-42d3-a456-426614174000", status: "processing", source: { type: "youtube", url: "https://youtu.be/xyz" }, clips: [] },
    { id: "323e4567-e89b-42d3-a456-426614174000", status: "failed", source: { type: "upload", name: "rusak.mp4" } },
  ];
  assert.deepEqual(jobs.filter((job) => matchesProjectFilter(job, "active")).map((job) => job.status), ["processing"]);
  assert.deepEqual(jobs.filter((job) => matchesProjectFilter(job, "completed")).map((job) => job.status), ["completed"]);
  assert.deepEqual(jobs.filter((job) => matchesProjectFilter(job, "failed")).map((job) => job.status), ["failed"]);
  assert.equal(jobs.filter((job) => matchesProjectFilter(job, "all")).length, 3);
  for (const query of ["copet", "NGAMBANG", "podcast", "123e4567", "youtu.be/xyz", "  rusak "]) {
    assert.equal(jobs.filter((job) => matchesProjectQuery(job, query)).length, 1, query);
  }
  assert.equal(jobs.filter((job) => matchesProjectQuery(job, "")).length, 3);
  assert.equal(historySummary(jobs), "3 proyek · 1 klip");
  assert.equal(historySummary([]), "0 proyek");
});

test("a history row says how many clips a project has, or where an unfinished one stands", () => {
  assert.equal(projectRowDetail({ status: "completed", clips: [{}, {}] }), "2 klip");
  assert.equal(projectRowDetail({ status: "completed" }), "0 klip");
  assert.equal(projectRowDetail({ status: "processing", stageDetail: "Memilih momen terbaik", clips: [] }), "Memilih momen terbaik");
  assert.equal(projectRowDetail({ status: "queued", clips: [] }), "Sedang diproses");
  assert.equal(projectRowDetail({ status: "failed", stageDetail: "Penyimpanan server tidak cukup" }), "Penyimpanan server tidak cukup");
  assert.equal(projectRowDetail({ status: "failed", stageDetail: "  " }), "Berhenti sebelum selesai");
  assert.equal(projectRowDetail({ status: "deleting", stageDetail: "Proyek sedang dihapus dari penyimpanan server" }), "Sedang dihapus");
});

// Old jobs still running or failed in a retired mode report stages such as "Kandidat bayangan V2
// siap"; that wording stays in the job file.
const VERSIONED_STAGES = ["Kandidat bayangan V2 siap", "Membuat kandidat V2 dari batas transkrip", "Selection V3 berjalan"];

test("a history row never shows a stage text that names a version", () => {
  for (const stageDetail of VERSIONED_STAGES) {
    assert.equal(projectRowDetail({ status: "processing", stageDetail, clips: [] }), "Sedang diproses", stageDetail);
    assert.equal(projectRowDetail({ status: "failed", stageDetail }), "Berhenti sebelum selesai", stageDetail);
  }
});

test("the project page's progress title and failure notice drop a stage text that names a version", async () => {
  assert.equal(projectStageText({ status: "processing", stageDetail: "Memilih momen terbaik" }), "Memilih momen terbaik");
  assert.equal(projectStageText({ status: "queued" }), "Sedang diproses");
  assert.equal(projectStageText({ status: "failed", stageDetail: "Penyimpanan server tidak cukup" }), "Penyimpanan server tidak cukup");
  assert.equal(projectStageText({ status: "failed", stageDetail: " " }), "Proyek ini berhenti sebelum klip selesai.");
  for (const stageDetail of VERSIONED_STAGES) {
    assert.equal(projectStageText({ status: "processing", stageDetail }), "Sedang diproses", stageDetail);
    assert.equal(projectStageText({ status: "failed", stageDetail }), "Proyek ini berhenti sebelum klip selesai.", stageDetail);
  }
  const source = await read("app/projects/[id]/page.jsx");
  assert.doesNotMatch(source, /job\.stageDetail/, "the page reads the stage only through projectStageText");
  assert.match(source, /<h2 id="progress-title">\{projectStageText\(job\)\}<\/h2>/);
});

// --- The retired candidate editor -------------------------------------------------------------

test("the candidate editor, its routes and its libraries are gone", async () => {
  for (const relative of [
    "app/projects/[id]/candidates/[candidateId]/edit/page.jsx",
    "app/api/jobs/[id]/candidates/route.js",
    "app/api/jobs/[id]/candidates/[candidateId]/caption-cues/route.js",
    "app/api/jobs/[id]/candidates/[candidateId]/edit/route.js",
    "app/api/jobs/[id]/candidates/[candidateId]/renders/route.js",
    "app/api/jobs/[id]/candidate-feedback/route.js",
    // The source preview only fed the old editor's player.
    "app/api/jobs/[id]/preview-source/route.js",
    "lib/candidate-view.mjs",
    "lib/candidates.mjs",
    "lib/candidate-feedback.mjs",
    "lib/caption-cues.mjs",
    "lib/edit-document.mjs",
    "lib/editor-view.mjs",
    "lib/editor-timeline.mjs",
    "e2e/mutation.spec.mjs",
  ]) assert.equal(await exists(relative), false, `${relative} should be deleted`);
});

test("an old candidate-editor link lands on its project page", async () => {
  const redirected = async (params) => {
    try {
      await RetiredCandidatePage({ params: Promise.resolve(params) });
    } catch (error) {
      return error.digest;
    }
    return null;
  };
  assert.match(await redirected({ id: JOB_ID, rest: ["cand_abc", "edit"] }), new RegExp(`^NEXT_REDIRECT;replace;/projects/${JOB_ID};307;`));
  assert.match(await redirected({ id: JOB_ID }), new RegExp(`;/projects/${JOB_ID};`));
  assert.match(await redirected({ id: "a b/c" }), /;\/projects\/a%20b%2Fc;/);
});

test("the history and project pages carry no version wording and no candidate requests", async () => {
  for (const file of ["app/projects/page.jsx", "app/projects/[id]/page.jsx", "lib/project-view.mjs"]) {
    const source = await read(file);
    // Module paths (selection-v3-view.mjs) are code, not words on the screen.
    const text = source.replace(/^import [\s\S]*?;$/gm, "");
    assert.doesNotMatch(text, /\bV[1-3]\b|Selection V|SELECTION V|Versi prompt|mesin (lama|baru)|Mode lama|Klip lama|HASIL JOB LAMA|kandidat/i, file);
    assert.doesNotMatch(source, /\/candidates|candidate-feedback|candidate-view|Kode peringatan teknis|prompt_version|promptVersion/, file);
    assert.doesNotMatch(source, /—/, `${file}: no em dash (R-02)`);
    assert.doesNotMatch(source, /dangerouslySetInnerHTML/, file);
  }
});

test("every clip of every job is shown with the same card, whatever made it", async () => {
  const source = await read("app/projects/[id]/page.jsx");
  assert.doesNotMatch(source, /isV3Job|const v3\b/);
  assert.match(source, /clips\.map\(\(clip\) => <ClipCard key=\{clip\.index\} clip=\{clip\} job=\{job\}/);
  assert.match(source, /<video [^>]*src=\{clip\.videoUrl\} poster=\{clipPosterUrl\(clip\)\}/);
  assert.match(source, /href=\{clip\.downloadUrl\}/);
  assert.match(source, /href=\{clip\.subtitleUrl\}/);
  assert.doesNotMatch(source, /<track\b/);
  assert.match(source, /clipCaptionText\(clip\)/);
  assert.match(source, /selectionNotices\(job\)/);
  assert.match(source, /selectionNotes\(job\)/);
  assert.match(source, /focusSummaryLine\(job\)/);
  assert.match(source, /clipFocusChip\(clip, job\)/);
  assert.match(source, /clipTrendChips\(clip\)/);
});

test("the project page cancels its request when left and keeps every state announced", async () => {
  const source = await read("app/projects/[id]/page.jsx");
  assert.match(source, /const controller = new AbortController\(\)/);
  assert.match(source, /loadProjectDetail\(id, \{ signal: controller\.signal \}\)/);
  assert.match(source, /if \(!active\) return/);
  assert.match(source, /active = false;\s*controller\.abort\(\)/);
  assert.match(source, /loadError\?\.name === "AbortError"/);
  assert.match(source, /role="status" aria-live="polite"/);
  assert.match(source, /role="alert"/);
  assert.match(source, /role="progressbar"/);
  // SRT is a download, never an HTML <track> (browsers want WebVTT), and its link says so.
  assert.match(source, /aria-label=\{`Unduh subtitle SRT \$\{label\}`\}>Subtitle SRT<\/a>/);
});

test("the explained warnings sit in a closed list under the notices, as plain text", async () => {
  const source = await read("app/projects/[id]/page.jsx");
  assert.match(source, /<details className=\{styles\.notes\}>/);
  assert.match(source, /<summary>Catatan pemilihan \(\{notes\.length\}\)<\/summary>/);
  assert.doesNotMatch(source, /<code\b/);
});

test("a failed project shows the worker's own message when it is words, not a code", () => {
  const failed = (error, stageDetail = "Proses berhenti karena terjadi kesalahan") => ({ status: "failed", stageDetail, error });
  assert.equal(failureDetail(failed("Video YouTube selesai diunduh tetapi file sumber tidak ditemukan")), "Video YouTube selesai diunduh tetapi file sumber tidak ditemukan");
  assert.equal(failureDetail(failed("  ai-clipper gagal (exit 1)  ")), "ai-clipper gagal (exit 1)");
  // A bare machine code says nothing the explanation above it does not; it stays in the job file.
  for (const code of ["storage_admission_unavailable", "llm_error:rate_limited", "shadow_failed"]) {
    assert.equal(failureDetail(failed(code, "Penyimpanan server tidak cukup untuk melanjutkan job")), null, code);
  }
  assert.equal(failureDetail(failed("Penyimpanan penuh", "Penyimpanan penuh")), null, "no repeat of the stage text");
  assert.equal(failureDetail(failed("Gagal", undefined)), "Gagal");
  assert.equal(failureDetail(failed("Invalid persisted job options: V2 options require v2-shadow mode")), null, "no version wording");
  for (const job of [failed(null), failed("   "), failed(42), { status: "completed", error: "Gagal sebelumnya" }, null]) {
    assert.equal(failureDetail(job), null);
  }
});

test("a failed project says why it stopped: the worker's message under the notice", async () => {
  const source = await read("app/projects/[id]/page.jsx");
  assert.match(source, /job\.status === "failed"/);
  assert.match(source, /const serverError = failureDetail\(job\);/);
  assert.match(source, /serverError && <span className=\{styles\.errorDetail\}>Pesan dari server: \{serverError\}<\/span>/);
});

test("every clip card offers 'Edit klip' from the clips listing; the page has no prepare step", async () => {
  const source = await read("app/projects/[id]/page.jsx");
  assert.match(source, /loadClipEntries\(id, \{ signal: controller\.signal \}\)/);
  assert.match(source, /<ClipCard key=\{clip\.index\} clip=\{clip\} job=\{job\}[^>]*\n\s*entry=\{clipEntryFor\(entries, job, clip\.index\)\} \/>/);
  assert.match(source, /<a className=\{`btn \$\{styles\.edit\}`\} href=\{entry\.editHref\}>Edit klip<\/a>/);
  assert.match(source, /<section id="klip" className=\{styles\.clips\}/);
  assert.doesNotMatch(source, /Siapkan untuk editor|prepareClipEntries|method: "POST"/);
  assert.doesNotMatch(source, /engineLegacy|mesin/i);
});

// W4 verifier: a job made before the editor (no Selection V3) has no clip to edit, so the history
// does not send the owner to a project page without an editor entry.
test("the history offers 'Edit klip' only on finished projects whose clips the editor can open", () => {
  const job = { status: "completed", clips: [{ index: 1 }], options: { selectionMode: "v3" } };
  assert.equal(historyOffersEdit(job, true), true);
  assert.equal(historyOffersEdit(job, false), false, "the editor is off");
  assert.equal(historyOffersEdit({ ...job, options: { selectionMode: "v1" } }, true), false);
  assert.equal(historyOffersEdit({ ...job, options: { selectionMode: "v2" } }, true), false);
  assert.equal(historyOffersEdit({ ...job, options: undefined }, true), false);
  assert.equal(historyOffersEdit({ ...job, status: "running" }, true), false);
  assert.equal(historyOffersEdit({ ...job, clips: [] }, true), false);
  assert.equal(historyOffersEdit(null, true), false);
});

test("the history offers 'Edit klip' on finished projects while the editor is on", async () => {
  const source = await read("app/projects/page.jsx");
  assert.match(source, /setEditor\(payload\.editor === true\)/);
  assert.match(source, /const editable = historyOffersEdit\(job, editor\);/);
  assert.match(source, /href=\{`\/projects\/\$\{encodeURIComponent\(job\.id\)\}#klip`\}/);
  const route = await read("app/api/jobs/route.js");
  assert.match(route, /editor: readEditorFlags\(process\.env\)\.editorV3/);
});

test("the history links each project to its page and deletes without a browser dialog", async () => {
  const source = await read("app/projects/page.jsx");
  assert.match(source, /href=\{`\/projects\/\$\{encodeURIComponent\(job\.id\)\}`\}/);
  assert.match(source, /method: "DELETE"/);
  assert.match(source, /Hapus permanen\?/);
  assert.doesNotMatch(source, /(?<![\w.])confirm\(/);
});
