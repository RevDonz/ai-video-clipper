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
  JOB_STEPS,
  jobStepText,
  submitErrorMessage,
} from "../lib/dashboard-view.mjs";
import { DOWNLOAD_ERROR_CODES, downloadErrorMessage } from "../lib/download-errors.mjs";
import { serializePublicJob, validateYouTubeUrl } from "../lib/jobs.mjs";

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
    text: "Proses berhenti karena terjadi kesalahan.", hint: null, detail: "x",
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
  assert.deepEqual(jobFormProblems({ ...valid, youtubeUrl: "" }), { youtubeUrl: "Tempel link YouTube atau pilih file video." });
  for (const url of ["http://youtu.be/x", "https://youtube.com.evil.test/x", "youtu.be/x", "https://gaming.youtube.com/watch?v=x", "http://m.youtube.com/watch?v=x"]) {
    assert.deepEqual(jobFormProblems({ ...valid, youtubeUrl: url }), { youtubeUrl: "Link harus https:// dari youtube.com atau youtu.be." }, url);
  }
  // Mobile and YouTube Music links are YouTube links too (the job API stores them canonical).
  for (const url of ["https://m.youtube.com/watch?v=rBg0ZcwjVKQ", "https://music.youtube.com/watch?v=rBg0ZcwjVKQ", "https://youtube.com/shorts/rBg0ZcwjVKQ"]) {
    assert.deepEqual(jobFormProblems({ ...valid, youtubeUrl: url }), {}, url);
    assert.equal(validateYouTubeUrl(url), true, url);
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
    text: "Proses berhenti karena terjadi kesalahan", hint: null, detail: "yt-dlp exited with 1",
  });
  assert.deepEqual(jobFailureView({ status: "failed", error: "storage_free_space_low" }), {
    text: "Ruang kosong penyimpanan server terlalu rendah.", hint: null, detail: null,
  });
  assert.deepEqual(jobFailureView({ status: "failed" }), { text: "Proses berhenti karena terjadi kesalahan.", hint: null, detail: null });
  assert.deepEqual(jobFailureView({ status: "failed", error: "Invalid persisted job options: V2 options require v2-shadow mode" }), {
    text: "Proses berhenti karena terjadi kesalahan.", hint: null, detail: null,
  });
  assert.equal(jobFailureView({ status: "completed", error: "x" }), null);
});

test("a failed download says why in Indonesian, with one suggestion, from its code", () => {
  for (const code of DOWNLOAD_ERROR_CODES) {
    const job = { status: "failed", stageDetail: "teks lama yang tersimpan", errorCode: code, error: "[youtube] AbCdEfGhIjK: Private video" };
    const { text, hint } = downloadErrorMessage(code);
    assert.deepEqual(jobFailureView(job), { text, hint, detail: "[youtube] AbCdEfGhIjK: Private video" }, code);
  }
  assert.deepEqual(jobFailureView({ status: "failed", stageDetail: "Unduhan macet.", errorCode: "download_stalled", error: "yt-dlp tidak bergerak selama 120 detik" }), {
    text: "Unduhan macet.", hint: downloadErrorMessage("download_stalled").hint, detail: "yt-dlp tidak bergerak selama 120 detik",
  });
  // An unknown code from a newer worker falls back to the stored stage text.
  assert.deepEqual(jobFailureView({ status: "failed", stageDetail: "Sesuatu berhenti", errorCode: "download_new_kind", error: "x" }), {
    text: "Sesuatu berhenti", hint: null, detail: "x",
  });
});

// --- Page source --------------------------------------------------------------------------

test("the dashboard's failure box shows the reason, its one suggestion, then the technical detail", async () => {
  const source = await read("app/dashboard/page.jsx");
  assert.match(source, /<strong>\{failure\.text\}<\/strong>\s*\{failure\.hint && <span>\{failure\.hint\}<\/span>\}\s*\{failure\.detail && \(/);
});

test("the dashboard is one form for the current method", async () => {
  const source = await read("app/dashboard/page.jsx");
  assert.doesNotMatch(source, /\bV[1-3]\b|Mode lama|Klasik V1|AI Hook|shadow|selectionMode|clipProfile|llmMode|legacyModes|Disarankan/);
  assert.doesNotMatch(source, /selectionSource|selectionSourceLabel/, "no technical provenance on screen");
  assert.doesNotMatch(source, /—/);
  for (const field of ["renderMode", "limit", "minDuration", "maxDuration", "coldOpen", "hookOverlay", "captionStyle", "videoLanguage"]) {
    assert.match(source, new RegExp(`data\\.set\\("${field}"`), field);
  }
  for (const text of ["Link video", "Pilih file", "Jumlah klip", "Durasi klip", "Durasi minimum", "Durasi maksimum", "Bahasa video", "Layout", "Gaya subtitle", "Buka dengan kalimat terkuat", "Teks hook di 4 detik pertama", "Cari momen tentang… (opsional)"]) {
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
  for (const group of ["Durasi klip", "Bahasa video"]) assert.match(source, new RegExp(`<fieldset[^>]*>\\s*<legend[^>]*>${group}</legend>`), group);
  for (const name of ["renderMode", "captionStyle", "duration", "videoLanguage"]) assert.match(source, new RegExp(`type="radio" name="${name}"`), name);
  assert.match(source, /type="checkbox"[^>]*checked=\{coldOpen\}/);
  assert.match(source, /type="checkbox"[^>]*checked=\{hookOverlay\}/);
  assert.match(source, /id="video-file"[^>]*type="file"/);
});

test("link, file and Buat klip come first; the essentials stay open; the rest fold under labelled headings", async () => {
  const source = await read("app/dashboard/page.jsx");
  const form = /<form [^>]*onSubmit=\{submit\}[^>]*>([\s\S]*?)<\/form>/.exec(source)[1];
  const at = (pattern) => form.search(pattern);
  assert.ok(at(/id="youtube-url"/) >= 0 && at(/type="submit"/) > at(/id="youtube-url"/), "link field, then Buat klip");
  // Jumlah, Rasio, Durasi and Layout are on screen before any fold.
  const firstFold = at(/<Fold /);
  for (const pattern of [/id="clip-limit"/, /name="ratio"/, /name="duration"/, /name="renderMode"/]) {
    assert.ok(at(pattern) > at(/type="submit"/) && at(pattern) < firstFold, String(pattern));
  }
  // Then the three folds, in order, each holding its own options.
  const folds = ["look", "moments", "format"].map((id) => at(new RegExp(`<Fold id="${id}"`)));
  assert.deepEqual([...folds].sort((a, b) => a - b), folds);
  assert.equal(folds[0], firstFold);
  const inFold = (pattern, index) => at(pattern) > folds[index] && (index === 2 || at(pattern) < folds[index + 1]);
  for (const pattern of [/name="captionStyle"/, /name="captionPosition"/, /checked=\{coldOpen\}/, /checked=\{hookOverlay\}/, /<LookPreview /]) assert.ok(inFold(pattern, 0), String(pattern));
  for (const pattern of [/<FocusField\b/, /id="time-ranges"/]) assert.ok(inFold(pattern, 1), String(pattern));
  for (const pattern of [/name="videoLanguage"/, /name="resolution"/]) assert.ok(inFold(pattern, 2), String(pattern));
  // A fold is a heading button that says what is inside; its content is hidden, not unmounted,
  // so typed focus terms survive a close.
  const fold = source.slice(source.indexOf("function Fold("), source.indexOf("function FocusField"));
  assert.match(fold, /<h2 [^>]*>\s*<button type="button"[^>]*aria-expanded=\{open\} aria-controls=\{`\$\{id\}-options`\}/);
  assert.match(fold, /<div id=\{`\$\{id\}-options`\}[^>]*hidden=\{!open\}>/);
  assert.match(fold, /\{summary\}/);
  assert.match(source, /sectionSummary\(id, /);
  // Every choice the job will use is read with Buat klip, which comes before the folds.
  assert.match(source, /choicesSummary\(/);
  assert.match(form, /type="submit"[^>]*aria-describedby="job-summary"/);
  assert.match(form, /<p id="job-summary" className="visuallyHidden">Job berikutnya: \{summary\}<\/p>/);
  // The first invalid field opens the fold it sits in, then takes the focus.
  assert.match(source, /focusField\(FIELD_IDS\[firstInvalid\], sectionOfField\(firstInvalid\)\)/);
  assert.match(source, /focusField\("focus-terms-input", sectionOfField\("focus"\)\)/);
  // Choices are read after hydration and written through the guarded helpers only.
  assert.match(source, /readStoredChoices\(browserStorage\(\)\)/);
  assert.match(source, /writeStoredChoices\(browserStorage\(\), /);
  assert.doesNotMatch(source, /localStorage/);
  // A file dropped anywhere in the window becomes the video (checked like a picked file).
  assert.match(source, /\["drop", drop\]/);
  assert.match(source, /window\.addEventListener\(name, listener\)/);
  assert.match(source, /videoFileProblem\(file\)/);
  // Lime stays on Buat klip alone.
  const css = await read("app/dashboard/dashboard.module.css");
  const lime = css.replace(/\/\*[\s\S]*?\*\//g, "").match(/^[^{}]*\{[^}]*var\(--accent\)[^}]*\}/gm).map((rule) => rule.split("{")[0].trim());
  assert.deepEqual(lime.filter((selector) => !/progress/.test(selector)), [".submit"]);
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

test("the stage counter counts the steps a job really goes through", () => {
  const youtube = { source: { type: "youtube", url: "https://www.youtube.com/watch?v=abc" } };
  const upload = { source: { type: "upload", name: "video.mp4" } };
  assert.equal(jobStepText({ ...youtube, status: "downloading" }), "Tahap 1 dari 8");
  // the worker fetches YouTube subtitles while the job is still downloading
  assert.equal(jobStepText({ ...youtube, status: "downloading", stage: "captions" }), "Tahap 1 dari 8");
  assert.equal(jobStepText({ ...youtube, status: "processing", stage: "analyzing" }), "Tahap 2 dari 8");
  assert.equal(jobStepText({ ...youtube, status: "processing", stage: "captions" }), "Tahap 3 dari 8");
  assert.equal(jobStepText({ ...youtube, status: "processing", stage: "transcribing" }), "Tahap 3 dari 8");
  assert.equal(jobStepText({ ...youtube, status: "processing", stage: "audio" }), "Tahap 4 dari 8");
  assert.equal(jobStepText({ ...youtube, status: "processing", stage: "llm" }), "Tahap 5 dari 8");
  assert.equal(jobStepText({ ...youtube, status: "processing", stage: "selecting" }), "Tahap 5 dari 8");
  assert.equal(jobStepText({ ...youtube, status: "processing", stage: "finalizing" }), "Tahap 8 dari 8");
  // an upload has no download step
  assert.equal(jobStepText({ ...upload, status: "processing", stage: "analyzing" }), "Tahap 1 dari 7");
  assert.equal(jobStepText({ ...upload, status: "processing", stage: "rendering" }), "Tahap 6 dari 7");
  // nothing to count while waiting, once finished, or for a stage of a retired mode
  for (const job of [
    { ...youtube, status: "queued" }, { ...youtube, status: "preparing" },
    { ...youtube, status: "completed", stage: "completed" }, { ...upload, status: "failed", stage: "rendering" },
    { ...upload, status: "cancelled", stage: "audio" }, { ...upload, status: "processing", stage: "candidates_ready" },
    { ...upload, status: "processing" }, {}, null,
  ]) assert.equal(jobStepText(job), null, JSON.stringify(job));
});

test("the counted steps follow the order the engine reports its stages", async () => {
  const source = await readFile(path.join(WEB, "..", "src", "ai_clipper", "pipeline.py"), "utf8");
  const first = new Map();
  for (const match of source.matchAll(/report\(\s*"(\w+)",\s*(\d+)/g)) {
    const [, stage, percent] = match;
    if (!first.has(stage) || Number(percent) < first.get(stage)) first.set(stage, Number(percent));
  }
  const counted = JOB_STEPS.flatMap((step) => step.stages);
  for (const stage of Object.keys(JOB_STAGE_LABELS)) {
    if (["completed", "failed", "cancelled"].includes(stage)) continue;
    assert.ok(counted.includes(stage), `${stage} is counted`);
  }
  const starts = JOB_STEPS.filter((step) => step.stages.length).map((step) => Math.min(...step.stages.map((stage) => first.get(stage))));
  assert.ok(starts.every(Number.isFinite), JSON.stringify(starts));
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b), "steps in the engine's order");
});

test("the dashboard and the project page show the counter beside the stage", async () => {
  const page = await readFile(path.join(WEB, "app", "dashboard", "page.jsx"), "utf8");
  assert.match(page, /jobStepText\(activeJob\)/);
  const project = await readFile(path.join(WEB, "app", "projects", "[id]", "page.jsx"), "utf8");
  assert.match(project, /jobStepText\(job\)/);
});
