// Rentang waktu (plan 2026-10-20 P2): time ranges the person types are kept as clips. The
// dashboard and the job API read them with lib/time-ranges.mjs (the engine's grammar and
// messages, src/ai_clipper/time_ranges.py), the job stores them as whole seconds, and the
// worker hands them to the engine as --range and shows the engine's reason when one is refused.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { projectSource } from "./support/screen-sources.mjs";
import { promisify } from "node:util";

import { parseJobFormOptions } from "../app/api/jobs/route.js";
import { JOB_FORM_FIELDS, parseJobOptions, sanitizeManifestClipFields, sanitizeStoredClip, validatePersistedJobOptions } from "../lib/jobs.mjs";
import { claimNextJob } from "../lib/primary-job-queue.mjs";
import {
  RANGE_FAILURE_CODES,
  TIME_RANGE_LIMITS,
  TimeRangeError,
  formatClock,
  parseTime,
  parseTimeRange,
  parseTimeRanges,
  rangeLabel,
  timeRangesProblem,
  typedRangeCount,
} from "../lib/time-ranges.mjs";
import { buildClipperInvocation, engineRangeFailure, main } from "../scripts/run-job.mjs";

const run = promisify(execFile);
const pythonBin = () => process.env.PYTHON_BIN || "../.venv/bin/python";

const V3 = { renderMode: "fit-blur", limit: 3, minDuration: 20, maxDuration: 60, selectionMode: "v3", llmMode: "auto", coldOpen: true, hookOverlay: true, captionStyle: "karaoke" };
const FORM_V3 = { renderMode: "fit-blur", limit: "3", minDuration: "20", maxDuration: "60" };

function refusal(action) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof TimeRangeError, String(error));
    assert.equal(error.code, "time_range_invalid");
    return error.message;
  }
  assert.fail("expected a TimeRangeError");
}

// --- The grammar ----------------------------------------------------------------------------

test("times read as seconds, minutes.seconds or hours:minutes:seconds, with dots, colons or full-width digits", () => {
  const cases = [["0", 0], ["90", 90], ["10.30", 630], ["10:30", 630], ["75:30", 4530], ["1:02:10", 3730], ["1.02.10", 3730], ["１０．３０", 630], [" 10.30 ", 630]];
  for (const [text, seconds] of cases) assert.equal(parseTime(text), seconds, text);
  for (const text of ["", "10.3", "10.300", ":30", "1:2:3", "1:02:03:04", "abc", "10,30", "-5", "123456", "100:00:00", "1e3"]) {
    assert.match(refusal(() => parseTime(text)), /tidak dikenali/, text);
  }
  for (const text of ["10.75", "1:60:00", "0:61"]) assert.match(refusal(() => parseTime(text)), /00 sampai 59/, text);
});

test("a range takes any dash and explains what is wrong in Indonesian", () => {
  for (const text of ["10.30-12.05", "10:30 - 12:05", "10.30–12.05", "10.30—12.05", "10.30−12.05", "１０．３０－１２．０５", "630-725"]) {
    assert.deepEqual(parseTimeRange(text), { start: 630, end: 725 }, text);
  }
  assert.equal(refusal(() => parseTimeRange("abc-def")), "“abc-def” tidak dikenali. Contoh: 10.30-12.05 atau 1:02:10-1:03:00.");
  assert.equal(refusal(() => parseTimeRange("12.05-10.30")), "Rentang 12:05–10:30: waktu selesai harus setelah waktu mulai.");
  assert.equal(refusal(() => parseTimeRange("1.02.10-1.02.12")), "Rentang 1:02:10–1:02:12 terlalu pendek: minimal 5 detik.");
  assert.equal(refusal(() => parseTimeRange("10.00-13.01")), "Rentang 10:00–13:01 terlalu panjang: maksimal 180 detik (3 menit).");
  assert.match(refusal(() => parseTimeRange("x".repeat(80))), new RegExp(`“${"x".repeat(24)}…”`));
  assert.equal(parseTimeRange("10.00-10.05").end - parseTimeRange("10.00-10.05").start, TIME_RANGE_LIMITS.min);
});

test("several ranges keep their order; overlaps, too many and more than the clip count are refused", () => {
  assert.deepEqual(parseTimeRanges("5:00-5:30, 1:00-1:30;\n2:00-2:30\r\n"), [{ start: 300, end: 330 }, { start: 60, end: 90 }, { start: 120, end: 150 }]);
  assert.deepEqual(parseTimeRanges(" ,\n ; "), []);
  assert.deepEqual(parseTimeRanges("1:00-1:30, 1:30-2:00").length, 2);
  assert.equal(refusal(() => parseTimeRanges("1:00-1:30, 1:20-2:00")), "Rentang 1:00–1:30 dan 1:20–2:00 tumpang tindih.");
  const eleven = Array.from({ length: 11 }, (_, minute) => `${minute}:00-${minute}:10`).join(", ");
  assert.equal(refusal(() => parseTimeRanges(eleven)), "Maksimal 10 rentang waktu.");
  assert.equal(refusal(() => parseTimeRanges("1".repeat(501))), "Isian rentang waktu terlalu panjang.");
  assert.equal(refusal(() => parseTimeRanges("1:00-1:30, 2:00-2:30", 1)), "Ada 2 rentang waktu, tetapi jumlah klip 1. Naikkan jumlah klip atau kurangi rentang.");
});

test("the dashboard's problem text, count and clock labels", () => {
  assert.equal(timeRangesProblem("", 3), "");
  assert.equal(timeRangesProblem("10.30-12.05", 3), "");
  assert.equal(timeRangesProblem("10.30-12.05, 1:00-1:30", 1), "Ada 2 rentang waktu, tetapi jumlah klip 1. Naikkan jumlah klip atau kurangi rentang.");
  assert.equal(timeRangesProblem("10.30-12.05, 1:00-1:30", null), "", "no clip count to compare yet");
  assert.match(timeRangesProblem("besok", 3), /tidak dikenali/);
  assert.equal(typedRangeCount(""), 0);
  assert.equal(typedRangeCount(" 10.30-12.05,\n besok ; "), 2);
  assert.equal(formatClock(3499.9), "58:19");
  assert.equal(rangeLabel({ start: 3730, end: 3780 }), "1:02:10–1:03:00");
});

test("the grammar, the limits and every message agree with the engine", async () => {
  const inputs = [
    "10.30-12.05", "10:30 - 12:05, 1:02:10-1:03:00", "１０．３０－１２．０５", "630-725", "abc-def", "10.3-12.05",
    "10.75-11.00", "12.05-10.30", "10.00-10.02", "10.00-14.00", "1:00-1:30, 1:20-2:00", "5:00-5:30\n1:00-1:30;2:00-2:30",
    "x".repeat(60), "1".repeat(501), " , ", "59:50-1:00:20", "1:00:00-1:00:04", "10.30—12.05",
  ];
  const script = [
    "import json, sys",
    "from ai_clipper import time_ranges as t",
    "out = {'limits': [t.MIN_RANGE_SECONDS, t.MAX_RANGE_SECONDS, t.MAX_RANGES, t.MAX_RANGES_TEXT], 'results': []}",
    "for text in json.loads(sys.argv[1]):",
    "    try:",
    "        out['results'].append([[r.start, r.end] for r in t.parse_time_ranges(text, 2)])",
    "    except t.TimeRangeError as e:",
    "        out['results'].append({'code': e.code, 'message': str(e)})",
    "print(json.dumps(out, ensure_ascii=False))",
  ].join("\n");
  const { stdout } = await run(pythonBin(), ["-c", script, JSON.stringify(inputs)], { env: { PATH: process.env.PATH } });
  const engine = JSON.parse(stdout);
  assert.deepEqual(engine.limits, [TIME_RANGE_LIMITS.min, TIME_RANGE_LIMITS.max, TIME_RANGE_LIMITS.ranges, TIME_RANGE_LIMITS.text]);
  inputs.forEach((text, index) => {
    let mine;
    try {
      mine = parseTimeRanges(text, 2).map((range) => [range.start, range.end]);
    } catch (error) {
      mine = { code: error.code, message: error.message };
    }
    assert.deepEqual(mine, engine.results[index], text);
  });
});

// --- The job API ----------------------------------------------------------------------------

test("the job form's timeRanges become options.ranges in whole seconds; without them nothing is stored", () => {
  assert.ok(JOB_FORM_FIELDS.includes("timeRanges"));
  assert.deepEqual(parseJobOptions({ ...FORM_V3, timeRanges: "10.30-12.05, 1:02:10-1:03:00" }), {
    ...V3, ranges: [{ start: 630, end: 725 }, { start: 3730, end: 3780 }],
  });
  for (const timeRanges of [undefined, null, "", " ,\n "]) {
    assert.deepEqual(parseJobOptions({ ...FORM_V3, timeRanges }), V3, String(timeRanges));
  }
  const form = new FormData();
  form.set("youtubeUrl", "https://youtu.be/rBg0ZcwjVKQ");
  form.set("limit", "2");
  form.set("timeRanges", "１０．３０－１２．０５");
  assert.deepEqual(parseJobFormOptions(form).ranges, [{ start: 630, end: 725 }]);
});

test("the job API refuses a range with the dashboard's Indonesian message", () => {
  assert.equal(refusal(() => parseJobOptions({ ...FORM_V3, timeRanges: "1:00-1:30, 2:00-2:30, 3:00-3:30, 4:00-4:30" })),
    "Ada 4 rentang waktu, tetapi jumlah klip 3. Naikkan jumlah klip atau kurangi rentang.");
  assert.match(refusal(() => parseJobOptions({ ...FORM_V3, timeRanges: "besok sore" })), /tidak dikenali/);
  assert.match(refusal(() => parseJobOptions({ ...FORM_V3, timeRanges: ["10.30-12.05"] })), /teks/);
});

test("stored ranges are checked like new ones and only for the current selection", () => {
  const ranges = [{ start: 630, end: 725 }, { start: 60, end: 90 }];
  assert.deepEqual(validatePersistedJobOptions({ ...V3, ranges }), { ...V3, ranges });
  assert.equal("ranges" in validatePersistedJobOptions(V3), false);
  for (const bad of [
    [], "630-725", [{ start: 630 }], [{ start: 630, end: 725, note: "x" }], [{ start: 630.5, end: 725 }],
    [{ start: "630", end: 725 }], [{ start: 725, end: 630 }], [{ start: 0, end: 4 }], [{ start: 0, end: 181 }],
    [{ start: 60, end: 90 }, { start: 80, end: 120 }], [{ start: 60, end: 90 }, { start: 100, end: 130 }, { start: 200, end: 230 }, { start: 300, end: 330 }],
    [{ start: -5, end: 30 }], [null],
  ]) {
    assert.throws(() => validatePersistedJobOptions({ ...V3, ranges: bad }), /persisted job options/i, JSON.stringify(bad));
  }
  const old = { renderMode: "fit-blur", limit: 3, minDuration: 20, maxDuration: 60 };
  assert.throws(() => validatePersistedJobOptions({ ...old, ranges }), /persisted job options/i);
  assert.throws(() => validatePersistedJobOptions({ ...old, selectionMode: "v1", ranges }), /persisted job options/i);
});

// --- The worker -----------------------------------------------------------------------------

test("the engine gets one --range per stored range, in order; jobs without ranges get none", () => {
  const job = (options) => ({ options });
  const { args } = buildClipperInvocation(job({ ...V3, ranges: [{ start: 630, end: 725 }, { start: 60, end: 90 }] }), "/in", "/o/output", {});
  assert.deepEqual(args.filter((value) => value.startsWith("--range")), ["--range=630-725", "--range=60-90"]);
  assert.equal(buildClipperInvocation(job(V3), "/in", "/o/output", {}).args.some((value) => value.startsWith("--range")), false);
  assert.throws(() => buildClipperInvocation(job({ ...V3, ranges: [{ start: 630, end: "725; rm" }] }), "/in", "/o/output", {}));
});

test("a range the engine refused is the job's reason, by code; other failures are not", () => {
  assert.deepEqual(RANGE_FAILURE_CODES, ["range_beyond_video", "range_no_speech"]);
  const message = "Rentang 1:02:10–1:03:00 melewati panjang video (58:20). Perbaiki rentangnya lalu buat job lagi.";
  assert.deepEqual(engineRangeFailure({ status: "failed", error_code: "range_beyond_video", error: message }), { code: "range_beyond_video", text: message });
  assert.deepEqual(engineRangeFailure({ status: "failed", error_code: "range_no_speech", error: "Rentang‮ 1:00–1:30\n tidak berisi ucapan." }), {
    code: "range_no_speech", text: "Rentang 1:00–1:30 tidak berisi ucapan.",
  });
  for (const manifest of [
    null, {}, { status: "failed", error: message }, { status: "failed", error_code: "pipeline", error: message },
    { status: "completed", error_code: "range_no_speech", error: message }, { status: "failed", error_code: "range_no_speech", error: "  " },
  ]) assert.equal(engineRangeFailure(manifest), null, JSON.stringify(manifest));
});

// The engine refuses the range the way src/ai_clipper/pipeline.py does: failed manifest, exit 1.
const REFUSING_ENGINE = `#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const output = process.argv[process.argv.indexOf("--output-dir") + 1];
await mkdir(output, { recursive: true });
await writeFile(path.join(output, "ranges.json"), JSON.stringify(process.argv.filter((value) => value.startsWith("--range"))));
await writeFile(path.join(output, "manifest.json"), JSON.stringify({
  status: "failed", error_code: "range_beyond_video",
  error: "Rentang 1:02:10–1:03:00 melewati panjang video (58:20). Perbaiki rentangnya lalu buat job lagi.",
}));
console.error("Error: Rentang 1:02:10–1:03:00 melewati panjang video (58:20).");
process.exit(1);
`;

test("a job whose range is past the video fails with the engine's reason and its code", async () => {
  const id = "d23e4567-e89b-42d3-a456-426614174000";
  const root = await mkdtemp(path.join(os.tmpdir(), "clipper-ranges-"));
  const jobRoot = path.join(root, id);
  await mkdir(path.join(jobRoot, "input"), { recursive: true });
  const sourcePath = path.join(jobRoot, "input", "source.mp4");
  await writeFile(sourcePath, "video");
  await writeFile(path.join(jobRoot, "job.json"), JSON.stringify({
    id, status: "queued", progress: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    source: { type: "upload", name: "source.mp4" }, sourcePath,
    options: { ...V3, ranges: [{ start: 60, end: 90 }, { start: 3730, end: 3780 }] }, clips: [],
  }));
  const bin = await mkdtemp(path.join(os.tmpdir(), "clipper-ranges-bin-"));
  const engine = path.join(bin, "refusing-engine.mjs");
  await writeFile(engine, REFUSING_ENGINE);
  await chmod(engine, 0o755);
  const env = { ...process.env, JOBS_ROOT: root, PRIMARY_LEASE_MS: "60000", AI_CLIPPER_BIN: engine, POTONGIN_SETTINGS_DIR: path.join(bin, "settings") };
  const claim = await claimNextJob({ jobsRoot: root, workerId: "worker", leaseMs: 60_000, maxAttempts: 1, legacyQuiescenceMs: 0 });
  const previousExitCode = process.exitCode;
  try {
    await main(["node", "run-job.mjs", id, claim.token], env);
  } finally {
    process.exitCode = previousExitCode;
  }
  const job = JSON.parse(await readFile(path.join(jobRoot, "job.json"), "utf8"));
  assert.equal(job.status, "failed");
  assert.equal(job.errorCode, "range_beyond_video");
  assert.equal(job.stageDetail, "Rentang 1:02:10–1:03:00 melewati panjang video (58:20). Perbaiki rentangnya lalu buat job lagi.");
  assert.match(job.error, /gagal \(exit 1\)/);
  const attempt = path.join(jobRoot, ".attempts", crypto.createHash("sha256").update(claim.token).digest("hex"));
  assert.deepEqual(JSON.parse(await readFile(path.join(attempt, "output", "ranges.json"), "utf8")), ["--range=60-90", "--range=3730-3780"]);
});

// --- Clips cut from a typed range ------------------------------------------------------------

test("a clip from a typed range keeps its manual mark; any other value is dropped", () => {
  assert.equal(sanitizeManifestClipFields({ selection_source: "heuristic", title: "Judul", manual: true }).manual, true);
  for (const manual of [false, "true", 1, null]) {
    assert.equal("manual" in sanitizeManifestClipFields({ selection_source: "heuristic", title: "Judul", manual }), false, String(manual));
  }
  const stored = sanitizeStoredClip({ index: 1, selectionSource: "heuristic", title: "Judul", manual: true }, "d23e4567-e89b-42d3-a456-426614174000");
  assert.equal(stored.manual, true);
  const forged = sanitizeStoredClip({ index: 1, selectionSource: "heuristic", title: "Judul", manual: "ya" }, "d23e4567-e89b-42d3-a456-426614174000");
  assert.equal("manual" in forged, false);
});

// --- On screen ------------------------------------------------------------------------------

test("the dashboard checks the field before anything is sent, against the clip count it shows", async () => {
  const view = await import("../lib/dashboard-view.mjs");
  const { textsOf } = await import("./support/catalog-t.mjs");
  const jobFormProblems = (fields) => textsOf(view.jobFormProblems(fields));
  const valid = { sourceType: "youtube", youtubeUrl: "https://youtu.be/rBg0ZcwjVKQ", video: null, limit: "3", minDuration: "20", maxDuration: "60" };
  assert.deepEqual(jobFormProblems({ ...valid, timeRanges: "" }), {});
  assert.deepEqual(jobFormProblems({ ...valid, timeRanges: "10.30-12.05, 1:02:10-1:03:00" }), {});
  assert.deepEqual(jobFormProblems({ ...valid, timeRanges: "besok" }), { timeRanges: "“besok” tidak dikenali. Contoh: 10.30-12.05 atau 1:02:10-1:03:00." });
  assert.deepEqual(jobFormProblems({ ...valid, limit: "1", timeRanges: "1:00-1:30, 2:00-2:30" }), {
    timeRanges: "Ada 2 rentang waktu, tetapi jumlah klip 1. Naikkan jumlah klip atau kurangi rentang.",
  });
  // A clip count still being typed is its own problem; the ranges are checked on their own.
  assert.deepEqual(jobFormProblems({ ...valid, limit: "", timeRanges: "1:00-1:30, 2:00-2:30" }), { limit: "Isi 1 sampai 10 klip" });
});

test("the folded options' summary counts the typed ranges", async () => {
  const choicesView = await import("../lib/dashboard-choices.mjs");
  const { textsOf } = await import("./support/catalog-t.mjs");
  const { DEFAULT_CHOICES } = choicesView;
  const choicesSummary = (...args) => textsOf(choicesView.choicesSummary(...args)).join(" · ");
  assert.equal(choicesSummary(DEFAULT_CHOICES, { ranges: 2, focusTerms: 1 }), "3 klip · Otomatis 20–60 detik · Latar blur · Karaoke · Bahasa Indonesia · 2 rentang waktu · fokus 1 kata kunci");
  assert.equal(choicesSummary(DEFAULT_CHOICES, { ranges: 0 }), choicesSummary(DEFAULT_CHOICES));
});

test("the moments row says how many clips came from the typed ranges", async () => {
  const { sanitizeStageSummary, stageSummaryRows } = await import("../lib/stage-summary.mjs");
  const text = (moments) => stageSummaryRows({ stageSummary: { moments } })[0]?.text;
  assert.equal(text({ count: 5, source: "llm", ranges: 2 }), "2 dari rentang waktu · 3 dipilih AI");
  assert.equal(text({ count: 4, source: "heuristic", ranges: 1 }), "1 dari rentang waktu · 3 dipilih");
  assert.equal(text({ count: 2, source: "heuristic", ranges: 2 }), "2 dari rentang waktu");
  assert.equal(text({ count: 5, source: "llm" }), "5 dipilih AI");
  for (const ranges of [0, 6, 1.5, "2", null]) {
    assert.deepEqual(sanitizeStageSummary({ moments: { count: 5, source: "llm", ranges } }), { moments: { count: 5, source: "llm" } }, String(ranges));
  }
});

test("a job made only of typed ranges is not called a job made without AI", async () => {
  const view = await import("../lib/selection-v3-view.mjs");
  const { textsOf } = await import("./support/catalog-t.mjs");
  const clipRangeChip = (clip) => textsOf(view.clipRangeChip(clip));
  const selectionNotices = (job) => textsOf(view.selectionNotices(job));
  const summary = { mode: "v3", status: "completed", source: "heuristic", warnings: [] };
  const job = (clips) => ({ options: { llmMode: "auto" }, selectionV3: summary, clips });
  assert.deepEqual(selectionNotices(job([{ index: 1, manual: true }, { index: 2, manual: true }])), []);
  assert.equal(selectionNotices(job([{ index: 1, manual: true }, { index: 2 }]))[0].title, "Dibuat tanpa AI");
  assert.equal(selectionNotices(job([]))[0].title, "Dibuat tanpa AI");
  assert.equal(clipRangeChip({ manual: true }), "Rentang waktu kamu");
  for (const clip of [{}, { manual: "true" }, null]) assert.equal(clipRangeChip(clip), null);
});

test("the dashboard field and the project chip are wired", async () => {
  const dashboard = await readFile(new URL("../app/dashboard/page.jsx", import.meta.url), "utf8");
  assert.match(dashboard, /htmlFor="time-ranges"/);
  assert.match(dashboard, /data\.set\("timeRanges"/);
  assert.match(dashboard, /timeRanges: "time-ranges"/, "the field takes focus when it is the first problem");
  const project = await projectSource();
  assert.match(project, /clipRangeChip\(clip\)/);
});
