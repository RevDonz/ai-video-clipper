// The dashboard (app/dashboard/page.jsx) shows only the current method: no version labels,
// no legacy modes, no technical provenance. Old jobs stay viewable with their clips.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { dashboardSource } from "./support/screen-sources.mjs";
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

// Buat klip after Dashboard F2 (05-ui-dashboard.md §6.3): the link and Buat klip, a file row and the
// valued chips; the job's progress, clips and failure are on its project page (P4).
test("a failed job's reason, its one suggestion and the technical detail are on its project page", async () => {
  const dashboard = await read("app/dashboard/page.jsx");
  assert.doesNotMatch(dashboard, /jobFailureView|activeJob/, "Buat klip shows no job");
  const project = await read("app/projects/[id]/page.jsx");
  assert.match(project, /<Alert\.Description>\{projectStageText\(job\)\}<\/Alert\.Description>\s*\{hint && <Alert\.Description>\{hint\}<\/Alert\.Description>\}/);
  assert.match(project, /\{serverError && \(\s*<details className=\{styles\.errorDetail\}>/);
});

test("the dashboard is one form for the current method", async () => {
  const source = await dashboardSource();
  assert.doesNotMatch(source, /\bV[1-3]\b|Mode lama|Klasik V1|AI Hook|shadow|selectionMode|clipProfile|llmMode|legacyModes|Disarankan/);
  assert.doesNotMatch(source, /selectionSource|selectionSourceLabel/, "no technical provenance on screen");
  assert.doesNotMatch(source, /—/);
  for (const field of ["renderMode", "limit", "minDuration", "maxDuration", "coldOpen", "hookOverlay", "captionStyle", "videoLanguage"]) {
    assert.match(source, new RegExp(`data\\.set\\("${field}"`), field);
  }
  // Every control has its label from the catalog (labels, not sentences: 05 §2 P2).
  const id = JSON.parse(await read("messages/id/dashboard.json"));
  const labels = [
    ["source.link", "Link YouTube"], ["source.file", "Pilih file"], ["chip.countLabel", "Jumlah klip"], ["chip.durationLabel", "Durasi"],
    ["duration.min", "Minimum (dtk)"], ["duration.max", "Maksimum (dtk)"], ["chip.languageLabel", "Bahasa video"], ["chip.layoutLabel", "Tata letak"],
    ["chip.subtitleLabel", "Subtitle"], ["hook.coldOpen", "Cold open"], ["hook.text", "Teks hook"], ["focus.terms", "Cari momen tentang"],
  ];
  for (const [key, text] of labels) {
    assert.ok(source.includes(`t("${key}")`), key);
    assert.equal(key.split(".").reduce((node, part) => node?.[part], id), text, key);
  }
  // The focus fields are sent only through focusFormFields: an empty focus sends nothing.
  assert.match(source, /for \(const \[name, value\] of Object\.entries\(focus\.fields\)\) data\.set\(name, value\);/);
  assert.doesNotMatch(source, /data\.set\("focus/);
  assert.match(source, /<FocusField\b/);
  assert.match(source, /fetch\("\/api\/llm\/status", \{ cache: "no-store"/);
  // After the job is made, the page goes to its project: a full document load (P4, P12).
  assert.match(source, /const next = projectAfterSubmit\(result\);/);
  assert.match(source, /window\.location\.assign\(next\);/);
  assert.match(await read("lib/dashboard-submit.mjs"), /`\/projects\/\$\{encodeURIComponent\(id\)\}`/);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
});

test("the dashboard's one-of groups and switches are real form controls", async () => {
  const source = await read("app/dashboard/page.jsx");
  // HeroUI RadioGroup, ToggleButtonGroup and Switch: React Aria renders native radios and switches.
  assert.match(source, /<RadioGroup value=\{value\} onChange=\{onChange\}/);
  assert.match(source, /<Radio key=\{option\.id\} value=\{option\.id\}/);
  for (const [label, value] of [["chip.layoutLabel", "renderMode"], ["chip.durationLabel", "duration"], ["chip.languageLabel", "videoLanguage"], ["chip.subtitleLabel", "captionStyle"]]) {
    assert.match(source, new RegExp(`<Choices label=\\{t\\("${label.replace(".", "\\.")}"\\)\\} value=\\{${value}\\}`), value);
  }
  assert.match(source, /<Switch isSelected=\{selected\} onChange=\{onChange\}/);
  assert.match(source, /<OnOff selected=\{coldOpen\}/);
  assert.match(source, /<OnOff selected=\{hookOverlay\}/);
  assert.match(source, /<ToggleButtonGroup\s+aria-labelledby=\{`segment-\$\{label\}`\}\s+disallowEmptySelection/);
  assert.match(source, /id="video-file" type="file"/);
});

test("link and Buat klip come first, then the file, then every choice as a valued chip", async () => {
  const source = await read("app/dashboard/page.jsx");
  const form = /<form [^>]*onSubmit=\{submit\}[^>]*>([\s\S]*?)<\/form>/.exec(source)[1];
  const at = (pattern) => form.search(pattern);
  assert.ok(at(/id="youtube-url"/) >= 0 && at(/type="submit"/) > at(/id="youtube-url"/), "link field, then Buat klip");
  assert.ok(at(/id="video-file"/) > at(/type="submit"/), "then the file row");
  assert.ok(at(/\{CHIPS\.map\(/) > at(/id="video-file"/), "then the chips");
  // The chips in 05 §6.3's order, each with its control inside its popover.
  const { CHIPS } = await import("../lib/dashboard-choices.mjs");
  assert.deepEqual(CHIPS, ["count", "duration", "format", "layout", "subtitle", "hook", "focus", "language"]);
  const chip = (id) => new RegExp(`${id}: \\(\\s*<ChoiceChip \\{\\.\\.\\.chipProps\\("${id}"\\)\\}([\\s\\S]*?)</ChoiceChip>`).exec(source)?.[1] ?? "";
  const holds = {
    count: [/id="clip-limit"/],
    duration: [/value=\{duration\}/, /id="min-duration"/, /id="max-duration"/],
    format: [/value=\{ratio\}/, /value=\{resolution\}/],
    layout: [/value=\{renderMode\}/],
    subtitle: [/<LookPreview /, /value=\{captionStyle\}/, /\{offered\.positions && \(/, /\{offered\.sizes && \(/],
    hook: [/selected=\{coldOpen\}/, /selected=\{hookOverlay\}/],
    focus: [/<FocusField\b/, /id="time-ranges"/],
    language: [/value=\{videoLanguage\}/],
  };
  for (const [id, patterns] of Object.entries(holds)) {
    const body = chip(id);
    assert.ok(body, id);
    for (const pattern of patterns) assert.match(body, pattern, `${id}: ${pattern}`);
  }
  // Each chip reads its value; the accessible name is "{label}: {value}" (ChoiceChip.jsx).
  const component = await read("components/ChoiceChip.jsx");
  assert.match(component, /aria-label=\{`\$\{label\}: \$\{value\}`\}/);
  assert.match(component, /<Popover isOpen=\{isOpen\} onOpenChange=\{onOpenChange\}>/);
  // One popover at a time: the page keeps which chip is open.
  assert.match(source, /isOpen: openChip === id,/);
  // The first invalid field opens the chip it sits in, then takes the focus.
  assert.match(source, /focusField\(FIELD_IDS\[firstInvalid\], chipOfField\(firstInvalid\)\)/);
  assert.match(source, /focusField\(FOCUS_INPUT, chipOfField\("focus"\)\)/);
  assert.match(source, /if \(chip\) setOpenChip\(chip\);/);
  // Enter in a popover field sends the form, as in the link field.
  assert.match(source, /formRef\.current\?\.requestSubmit\(\);/);
  // Choices are read after hydration and written through the guarded helpers only.
  assert.match(source, /readStoredChoices\(browserStorage\(\)\)/);
  assert.match(source, /writeStoredChoices\(browserStorage\(\), /);
  assert.doesNotMatch(source, /localStorage/);
  // A file dropped anywhere in the window becomes the video (checked like a picked file).
  assert.match(source, /\["drop", drop\]/);
  assert.match(source, /window\.addEventListener\(name, listener\)/);
  assert.match(source, /videoFileCode\(file\)/);
  // Lime stays on Buat klip alone.
  const css = await read("app/dashboard/dashboard.module.css");
  const lime = css.replace(/\/\*[\s\S]*?\*\//g, "").match(/^[^{}]*\{[^}]*var\(--accent\)[^}]*\}/gm).map((rule) => rule.split("{")[0].trim());
  assert.deepEqual(lime.filter((selector) => !/progress/.test(selector)), [".submit"]);
  assert.match(source, /<Button type="submit" variant="primary" className=\{styles\.submit\}/);
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

test("the form's checks come as codes, and the Indonesian texts are those codes' texts", async () => {
  const { jobFormProblemCodes, problemText } = await import("../lib/dashboard-view.mjs");
  const valid = { sourceType: "youtube", youtubeUrl: "https://youtu.be/rBg0ZcwjVKQ", limit: "3", minDuration: "20", maxDuration: "60" };
  assert.deepEqual(jobFormProblemCodes(valid), {});
  assert.deepEqual(jobFormProblemCodes({ ...valid, youtubeUrl: " " }), { youtubeUrl: { code: "linkEmpty" } });
  assert.deepEqual(jobFormProblemCodes({ ...valid, youtubeUrl: "http://youtu.be/x" }), { youtubeUrl: { code: "linkInvalid" } });
  assert.deepEqual(jobFormProblemCodes({ ...valid, sourceType: "upload", video: null }), { video: { code: "videoMissing" } });
  assert.deepEqual(jobFormProblemCodes({ ...valid, sourceType: "upload", video: { name: "a.avi" } }), { video: { code: "videoFormat" } });
  for (const [subtitle, code] of [[{ name: "a.txt", size: 3 }, "srtType"], [{ name: "a.srt", size: 0 }, "srtEmpty"], [{ name: "a.srt", size: 3_000_000 }, "srtTooLarge"]]) {
    assert.deepEqual(jobFormProblemCodes({ ...valid, sourceType: "upload", video: { name: "a.mp4" }, subtitle }), { subtitle: { code } }, code);
  }
  assert.deepEqual(jobFormProblemCodes({ ...valid, limit: "11" }), { limit: { code: "count", values: { min: 1, max: 10 } } });
  assert.deepEqual(jobFormProblemCodes({ ...valid, minDuration: "4" }), { minDuration: { code: "seconds", values: { min: 5, max: 180 } } });
  assert.deepEqual(jobFormProblemCodes({ ...valid, minDuration: "60", maxDuration: "30" }), { maxDuration: { code: "durationOrder" } });
  const ranges = jobFormProblemCodes({ ...valid, timeRanges: "abc" }).timeRanges;
  assert.equal(ranges.code, "ranges");
  assert.equal(typeof ranges.text, "string");
  // Each descriptor reads as the message jobFormProblems has always given.
  for (const fields of [{ ...valid, youtubeUrl: "" }, { ...valid, limit: "0", maxDuration: "999" }, { ...valid, timeRanges: "abc" }]) {
    const codes = jobFormProblemCodes(fields);
    assert.deepEqual(jobFormProblems(fields), Object.fromEntries(Object.entries(codes).map(([field, problem]) => [field, problemText(problem)])));
  }
  assert.equal(durationProblem(60, 30), problemText({ code: "durationOrder" }));
});

test("the AI alert shows only when the AI needs setting up", async () => {
  const { aiAlert } = await import("../lib/dashboard-view.mjs");
  assert.equal(aiAlert({ state: "unconfigured" }), "missing");
  assert.equal(aiAlert({ state: "unusable" }), "notReady");
  assert.equal(aiAlert({ state: "invalid" }), "notReady");
  for (const status of [{ state: "active" }, { state: "disabled" }, AI_STATUS_UNREADABLE, null, undefined, { state: "weird" }]) {
    assert.equal(aiAlert(status), null, JSON.stringify(status));
  }
});

// The project page's stepper (lib/project-progress.mjs, tests/project-progress.test.mjs) shows
// where a running job is; Buat klip shows no job any more.
test("the project page shows the step beside the stage; Buat klip shows no job", async () => {
  const page = await readFile(path.join(WEB, "app", "dashboard", "page.jsx"), "utf8");
  assert.doesNotMatch(page, /jobStepText|activeJob/);
  const progress = await readFile(path.join(WEB, "components", "ProjectProgress.jsx"), "utf8");
  assert.match(progress, /const steps = progressSteps\(job\) \?\? \[\];/);
  assert.match(progress, /aria-current=\{step\.state === "current" \? "step" : undefined\}/);
});
