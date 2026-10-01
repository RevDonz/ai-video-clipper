// The dashboard (app/dashboard/page.jsx) shows only the current method: no version labels,
// no legacy modes, no technical provenance. Old jobs stay viewable with their clips.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AI_STATUS_UNREADABLE,
  JOB_STAGE_LABELS,
  JOB_STATUS_LABELS,
  aiStatusView,
  clipMetaText,
  durationProblem,
  focusAiMode,
  jobActivityText,
  jobFailureView,
  jobFormProblems,
  jobPercentText,
  jobSourceLabel,
  jobStageText,
  submitErrorMessage,
} from "../lib/dashboard-view.mjs";
import { serializePublicJob } from "../lib/jobs.mjs";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFile(path.join(WEB, relative), "utf8");
const VERSION_WORDS = /\bV[1-4]\b|\bv[1-4]\b|shadow|Selection|versi|mesin (lama|baru)|Mode lama|kandidat|LLM|—/i;

const OLD_V1_JOB = {
  id: "d1e45678-e89b-42d3-a456-426614174002",
  status: "completed", progress: 100, stage: "completed", stageDetail: "Semua klip siap digunakan",
  source: { type: "youtube", url: "https://www.youtube.com/watch?v=rBg0ZcwjVKQ" },
  options: { renderMode: "fit-blur", limit: 3, minDuration: 20, maxDuration: 60 },
  // The shape old workers stored (artifacts/local job d1e45678…): URLs, timing, text, score.
  clips: [{
    index: 1, start: 10, end: 42, duration: 32, text: "Konsistensi itu kunci, bukan motivasi.", score: 71,
    videoUrl: "/api/jobs/d1e45678-e89b-42d3-a456-426614174002/files/output/clip-01.mp4",
    downloadUrl: "/api/jobs/d1e45678-e89b-42d3-a456-426614174002/files/output/clip-01.mp4?download=1",
    subtitleUrl: "/api/jobs/d1e45678-e89b-42d3-a456-426614174002/files/output/clip-01.srt",
  }],
};
const OLD_V2_JOB = {
  ...OLD_V1_JOB,
  id: "d2e45678-e89b-42d3-a456-426614174003",
  source: { type: "upload", name: "podcast-episode-12.mp4", size: 1000 },
  options: { renderMode: "face-track", limit: 3, minDuration: 20, maxDuration: 60, selectionMode: "v2-shadow", clipProfile: "standard", maxCandidates: 200, maxMediaCandidates: 12, mediaTimeout: 30 },
};

test("old V1 and V2 jobs render their clips on the dashboard without version labels", () => {
  for (const raw of [OLD_V1_JOB, OLD_V2_JOB]) {
    const job = serializePublicJob(raw);
    assert.equal(job.clips.length, 1);
    const [clip] = job.clips;
    assert.match(clip.videoUrl, /\/api\/jobs\/.+\/files\/output\/clip-01\.mp4$/);
    assert.match(clip.downloadUrl, /download=1$/);
    assert.ok(clip.title, "old clips get a title");
    assert.equal(clipMetaText(clip), "Klip 1 · 32 detik");
    for (const text of [clipMetaText(clip), jobSourceLabel(job), jobStageText(job)]) assert.doesNotMatch(text, VERSION_WORDS, text);
  }
  assert.equal(jobSourceLabel(serializePublicJob(OLD_V1_JOB)), "YouTube · rBg0ZcwjVKQ");
  assert.equal(jobSourceLabel(serializePublicJob(OLD_V2_JOB)), "podcast-episode-12.mp4");
});

test("job source labels stay short and never fall back to a raw id", () => {
  assert.equal(jobSourceLabel({ source: { type: "youtube", url: "https://youtu.be/abc123" } }), "YouTube · abc123");
  assert.equal(jobSourceLabel({ source: { type: "youtube", url: "bukan url" } }), "Video YouTube");
  assert.equal(jobSourceLabel({ source: { type: "upload" } }), "Video unggahan");
  assert.equal(jobSourceLabel({ id: "00000000-0000-4000-8000-000000000000" }), "Video");
  assert.equal(jobSourceLabel(null), "Video");
});

test("stage and status labels are Indonesian and carry no version or engine wording", () => {
  for (const label of [...Object.values(JOB_STAGE_LABELS), ...Object.values(JOB_STATUS_LABELS)]) {
    assert.doesNotMatch(label, VERSION_WORDS, label);
  }
  assert.equal(jobStageText({ status: "processing", stage: "rendering" }), "Merender klip");
  // Stages of retired modes fall back to the status.
  assert.equal(jobStageText({ status: "processing", stage: "candidates_ready" }), "Memproses");
  assert.equal(jobStageText({ status: "queued" }), "Dalam antrean");
  assert.equal(jobStageText({}), "Memproses");
});

test("the live line says what the worker is doing, and a queued job is waiting, not processing", () => {
  assert.equal(jobActivityText({ status: "processing", stageDetail: "Merender klip 2 dari 3" }), "Merender klip 2 dari 3");
  assert.equal(jobActivityText({ status: "queued" }), "Menunggu giliran diproses.");
  assert.equal(jobActivityText({ status: "queued", stageDetail: "  " }), "Menunggu giliran diproses.");
  assert.equal(jobActivityText({ status: "downloading" }), "Video sedang diproses.");
  // An old job still running reports its retired stages with version wording: never shown.
  for (const detail of ["Kandidat bayangan V2 siap", "Membuat kandidat V2 dari batas transkrip", "Selection V3 berjalan"]) {
    assert.equal(jobActivityText({ status: "processing", stageDetail: detail }), "Video sedang diproses.", detail);
  }
});

test("a failed job never shows a worker detail with version wording", () => {
  assert.deepEqual(jobFailureView({ status: "failed", stageDetail: "Mengukur media hanya untuk shortlist V2", error: "x" }), {
    text: "Proses berhenti karena terjadi kesalahan.", detail: "x",
  });
});

test("the percentage tells how far a running job is; a failed job shows none", () => {
  assert.equal(jobPercentText({ status: "processing", progress: 42 }), "42%");
  assert.equal(jobPercentText({ status: "completed", progress: 100 }), "100%");
  assert.equal(jobPercentText({ status: "queued" }), "0%");
  assert.equal(jobPercentText({ status: "processing", progress: 140 }), "100%");
  assert.equal(jobPercentText({ status: "processing", progress: "x" }), "0%");
  // "Gagal 100%" reads as finished: a failed job keeps its bar but drops the number.
  assert.equal(jobPercentText({ status: "failed", progress: 100 }), null);
});

test("clip meta shows number and length only, never the selection source", () => {
  assert.equal(clipMetaText({ index: 3, duration: 41.6, selectionSource: "heuristic" }), "Klip 3 · 42 detik");
  assert.equal(clipMetaText({ index: 2, selectionSource: "llm" }), "Klip 2");
  assert.equal(clipMetaText({}), "Klip");
});

test("the AI status line is short Indonesian for every state, without em dashes", () => {
  const cases = [
    [null, "muted", "Memeriksa AI…"],
    [{ state: "active", order: ["ollama-cloud", "openrouter"], providers: [] }, "ok", "AI aktif: ollama-cloud → openrouter"],
    [{ state: "active", order: ["custom-1"], providers: [{ name: "custom-1", displayName: "Hermes" }] }, "ok", "AI aktif: Hermes"],
    [{ state: "active", label: "LLM aktif: uji" }, "ok", "AI aktif"],
    [{ state: "disabled" }, "muted", "AI dimatikan. Momen dipilih heuristik lokal."],
    [{ state: "unconfigured" }, "muted", "AI belum diatur. Momen dipilih heuristik lokal."],
    [{ state: "unusable" }, "warning", "AI belum siap. Momen dipilih heuristik lokal."],
    [{ state: "invalid" }, "warning", "Pengaturan AI tidak valid. Momen dipilih heuristik lokal."],
    [AI_STATUS_UNREADABLE, "warning", "Status AI tidak terbaca. Job tetap berjalan."],
    [{ state: "something-new" }, "warning", "Status AI tidak dikenal. Job tetap berjalan."],
  ];
  for (const [status, tone, text] of cases) {
    assert.deepEqual(aiStatusView(status), { tone, text }, JSON.stringify(status));
    assert.doesNotMatch(text, /—/);
  }
});

test("the focus hints follow the AI the next job will really use", () => {
  assert.equal(focusAiMode(null), "auto");
  assert.equal(focusAiMode({ state: "active" }), "auto");
  assert.equal(focusAiMode(AI_STATUS_UNREADABLE), "auto");
  for (const state of ["disabled", "unconfigured", "unusable", "invalid"]) assert.equal(focusAiMode({ state }), "off", state);
});

test("the form is checked in Indonesian before anything is sent, like the job API checks it", () => {
  const valid = { sourceType: "youtube", youtubeUrl: " https://youtu.be/rBg0ZcwjVKQ ", video: null, limit: "3", minDuration: "20", maxDuration: "60" };
  assert.deepEqual(jobFormProblems(valid), {});
  assert.deepEqual(jobFormProblems({ ...valid, sourceType: "upload", youtubeUrl: "", video: { name: "a.mp4" } }), {});
  assert.deepEqual(jobFormProblems({ ...valid, youtubeUrl: "" }), { youtubeUrl: "Tempel link YouTube dulu." });
  for (const url of ["http://youtu.be/x", "https://m.youtube.com/watch?v=x", "https://youtube.com.evil.test/x", "youtu.be/x"]) {
    assert.deepEqual(jobFormProblems({ ...valid, youtubeUrl: url }), { youtubeUrl: "Link harus https:// dari youtube.com atau youtu.be." }, url);
  }
  assert.deepEqual(jobFormProblems({ ...valid, sourceType: "upload", video: null }), { video: "Pilih file video dulu." });
  assert.deepEqual(jobFormProblems({ ...valid, limit: "11" }), { limit: "Isi 1 sampai 10 klip." });
  assert.deepEqual(jobFormProblems({ ...valid, limit: "2.5" }), { limit: "Isi 1 sampai 10 klip." });
  assert.deepEqual(jobFormProblems({ ...valid, limit: "" }), { limit: "Isi 1 sampai 10 klip." });
  assert.deepEqual(jobFormProblems({ ...valid, minDuration: "4" }), { minDuration: "Isi 5 sampai 180 detik." });
  assert.deepEqual(jobFormProblems({ ...valid, maxDuration: "181" }), { maxDuration: "Isi 5 sampai 180 detik." });
  assert.deepEqual(jobFormProblems({ ...valid, minDuration: "61", maxDuration: "60" }), { maxDuration: "Durasi maksimum tidak boleh kurang dari minimum." });
});

test("form problems and API errors become short Indonesian messages", () => {
  assert.equal(durationProblem("20", "60"), null);
  assert.equal(durationProblem(30, 30), null);
  assert.equal(durationProblem("61", "60"), "Durasi maksimum tidak boleh kurang dari minimum.");
  assert.equal(submitErrorMessage({ code: "storage_quota_exhausted" }), "Penyimpanan server tidak cukup untuk job baru.");
  assert.equal(submitErrorMessage({ code: "queue_capacity_reached", error: "Antrean job sedang penuh." }), "Antrean job sedang penuh.");
  assert.equal(submitErrorMessage({ code: "invalid_request", error: 42 }), "Job gagal dibuat. Periksa isian lalu coba lagi.");
  assert.equal(submitErrorMessage(null), "Job gagal dibuat. Periksa isian lalu coba lagi.");
});

test("a failed job shows an Indonesian reason; the raw error stays behind a disclosure", () => {
  assert.deepEqual(jobFailureView({ status: "failed", stageDetail: "Proses berhenti karena terjadi kesalahan", error: "yt-dlp exited with 1" }), {
    text: "Proses berhenti karena terjadi kesalahan", detail: "yt-dlp exited with 1",
  });
  assert.deepEqual(jobFailureView({ status: "failed", error: "storage_free_space_low" }), {
    text: "Ruang kosong penyimpanan server terlalu rendah.", detail: null,
  });
  assert.deepEqual(jobFailureView({ status: "failed" }), { text: "Proses berhenti karena terjadi kesalahan.", detail: null });
  assert.equal(jobFailureView({ status: "completed", error: "x" }), null);
});

// --- Page source --------------------------------------------------------------------------

test("the dashboard is one form for the current method", async () => {
  const source = await read("app/dashboard/page.jsx");
  assert.doesNotMatch(source, /\bV[1-3]\b|Mode lama|Klasik V1|AI Hook|shadow|selectionMode|clipProfile|llmMode|legacyModes|Disarankan/);
  assert.doesNotMatch(source, /selectionSource|selectionSourceLabel/, "no technical provenance on screen");
  assert.doesNotMatch(source, /—/);
  for (const field of ["renderMode", "limit", "minDuration", "maxDuration", "coldOpen", "hookOverlay", "captionStyle"]) {
    assert.match(source, new RegExp(`data\\.set\\("${field}"`), field);
  }
  for (const text of ["Link YouTube", "Unggah file", "Jumlah klip", "Durasi minimum", "Durasi maksimum", "Layout", "Gaya subtitle", "Buka dengan kalimat terkuat", "Teks hook di 4 detik pertama", "Cari momen tentang… (opsional)"]) {
    assert.ok(source.includes(text), text);
  }
  // The focus fields are sent only through focusFormFields: an empty focus sends nothing.
  assert.match(source, /for \(const \[name, value\] of Object\.entries\(focus\.fields\)\) data\.set\(name, value\);/);
  assert.doesNotMatch(source, /data\.set\("focus/);
  assert.match(source, /<FocusField\b/);
  assert.match(source, /fetch\("\/api\/llm\/status", \{ cache: "no-store"/);
  assert.match(source, /clipCaptionText\(clip\)/);
  assert.match(source, /href=\{`\/projects\/\$\{activeJob\.id\}`\}/, "the result links to its project page");
  assert.match(source, /jobPercentText\(activeJob\)/);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
});

test("the dashboard's radio groups and toggles are real form controls", async () => {
  const source = await read("app/dashboard/page.jsx");
  assert.match(source, /<fieldset[^>]*>\s*<legend[^>]*>Layout<\/legend>/);
  assert.match(source, /type="radio" name="renderMode"/);
  assert.match(source, /type="radio" name="captionStyle"/);
  assert.match(source, /type="checkbox"[^>]*checked=\{coldOpen\}/);
  assert.match(source, /type="checkbox"[^>]*checked=\{hookOverlay\}/);
  assert.match(source, /aria-pressed=\{sourceType === "youtube"\}/);
});

test("dashboard, login and landing styles use design tokens, not literal colours", async () => {
  for (const file of ["app/dashboard/dashboard.module.css", "app/dashboard/focus.module.css", "app/login/login.module.css", "app/landing.module.css"]) {
    const css = await read(file);
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(withoutComments, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|(?<![\w-])(?:white|black)(?![\w-])/i, file);
    // An outline may only go where a surrounding box draws the focus ring instead.
    if (/outline:\s*(none|0)\b/.test(withoutComments)) {
      assert.match(withoutComments, /:focus-within\s*\{[^}]*outline:\s*2px solid var\(--focus\)/, `${file} removes an outline without a replacement ring`);
    }
  }
});
