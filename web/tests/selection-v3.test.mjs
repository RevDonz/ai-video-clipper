import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { parseJobFormOptions } from "../app/api/jobs/route.js";
import { createLlmStatusHandler } from "../app/api/llm/status/route.js";
import {
  DEFAULT_V3_OPTIONS,
  clipSocialMetadata,
  enrichJobSocialMetadata,
  generateSocialMetadata,
  parseJobOptions,
  sanitizeLine,
  sanitizeManifestClipFields,
  sanitizeMultiline,
  sanitizeSelectionV3Summary,
  sanitizeStoredClip,
  serializePublicJob,
  validatePersistedJobOptions,
} from "../lib/jobs.mjs";
import { readLlmStatus } from "../lib/llm-status.mjs";
import { claimNextJob, LeaseLostError } from "../lib/primary-job-queue.mjs";
import {
  archetypeLabel,
  captionParts,
  clipCaptionText,
  isV3Job,
  llmStatusView,
  scoreRows,
  selectionSourceLabel,
  selectionV3SummaryView,
  tenPointScore,
} from "../lib/selection-v3-view.mjs";
import {
  CAPTION_LANGUAGES,
  ProcessTimeoutError,
  buildCaptionDownloads,
  buildClipperInvocation,
  captionsTimeoutMs,
  downloaderEnv,
  fetchYouTubeCaptions,
  findCaptionsDir,
  jobClipFromManifest,
  main,
  manifestJobPatch,
  runFencedProcess,
} from "../scripts/run-job.mjs";

const BASE = { renderMode: "fit-blur", limit: 3, minDuration: 20, maxDuration: 60 };
const V3 = { ...BASE, selectionMode: "v3", llmMode: "auto", coldOpen: true, hookOverlay: true, captionStyle: "karaoke" };
const V2 = { ...BASE, selectionMode: "v2-shadow", clipProfile: "standard", maxCandidates: 200, maxMediaCandidates: 12, mediaTimeout: 30 };
const JOB_ID = "923e4567-e89b-42d3-a456-426614174000";

// --- Options ------------------------------------------------------------------

test("V3 form options default to AI hook packaging and parse strict booleans", () => {
  assert.deepEqual(parseJobOptions({ selectionMode: "v3" }), {
    renderMode: "fit-blur", limit: 5, minDuration: 20, maxDuration: 60, selectionMode: "v3", ...DEFAULT_V3_OPTIONS,
  });
  assert.deepEqual(DEFAULT_V3_OPTIONS, { llmMode: "auto", coldOpen: true, hookOverlay: true, captionStyle: "karaoke" });
  assert.deepEqual(
    parseJobOptions({ ...BASE, selectionMode: "v3", llmMode: "off", coldOpen: "false", hookOverlay: "true", captionStyle: "classic" }),
    { ...BASE, selectionMode: "v3", llmMode: "off", coldOpen: false, hookOverlay: true, captionStyle: "classic" },
  );
  assert.deepEqual(parseJobOptions({ selectionMode: "v3", coldOpen: false, hookOverlay: false }).coldOpen, false);
  assert.deepEqual(parseJobOptions({ selectionMode: "v3", llmMode: "", captionStyle: null }).llmMode, "auto");
});

test("V3 form options reject unknown values and options of other modes", () => {
  for (const input of [
    { selectionMode: "v3", llmMode: "required" },
    { selectionMode: "v3", llmMode: "AUTO" },
    { selectionMode: "v3", llmMode: ["auto"] },
    { selectionMode: "v3", coldOpen: "yes" },
    { selectionMode: "v3", coldOpen: "on" },
    { selectionMode: "v3", coldOpen: 1 },
    { selectionMode: "v3", hookOverlay: "1" },
    { selectionMode: "v3", captionStyle: "neon" },
    { selectionMode: "v3", clipProfile: "standard" },
    { selectionMode: "v3", maxCandidates: "10" },
    { selectionMode: "v1", llmMode: "auto" },
    { selectionMode: "v1", coldOpen: "false" },
    { selectionMode: "v2-shadow", captionStyle: "karaoke" },
    { selectionMode: "v2-shadow", hookOverlay: "true" },
    { llmMode: "auto" },
    { coldOpen: "true" },
    { selectionMode: "V3" },
  ]) assert.throws(() => parseJobOptions(input), undefined, JSON.stringify(input));
});

test("job API form parsing forwards the V3 fields", () => {
  const form = new FormData();
  for (const [key, value] of Object.entries({
    renderMode: "face-track", limit: "4", minDuration: "25", maxDuration: "55",
    selectionMode: "v3", llmMode: "off", coldOpen: "true", hookOverlay: "false", captionStyle: "classic",
  })) form.set(key, value);
  assert.deepEqual(parseJobFormOptions(form), {
    renderMode: "face-track", limit: 4, minDuration: 25, maxDuration: 55,
    selectionMode: "v3", llmMode: "off", coldOpen: true, hookOverlay: false, captionStyle: "classic",
  });
});

test("persisted options: legacy, V1, V2 shadow and V3 validate strictly without coercion", () => {
  assert.deepEqual(validatePersistedJobOptions(BASE), BASE);
  assert.deepEqual(validatePersistedJobOptions({ ...BASE, selectionMode: "v1" }), { ...BASE, selectionMode: "v1" });
  assert.deepEqual(validatePersistedJobOptions(V2), V2);
  assert.deepEqual(validatePersistedJobOptions(V3), V3);
  assert.deepEqual(validatePersistedJobOptions({ ...V3, llmMode: "off", coldOpen: false, hookOverlay: false, captionStyle: "classic" }),
    { ...V3, llmMode: "off", coldOpen: false, hookOverlay: false, captionStyle: "classic" });
  for (const options of [
    { ...V3, llmMode: undefined },
    { ...V3, llmMode: "required" },
    { ...V3, coldOpen: "true" },
    { ...V3, coldOpen: 1 },
    { ...V3, hookOverlay: null },
    { ...V3, captionStyle: "Karaoke" },
    { ...V3, clipProfile: "standard" },
    { ...V2, llmMode: "auto" },
    { ...BASE, selectionMode: "v1", coldOpen: true },
    { ...BASE, selectionMode: "v3; rm -rf /" },
  ]) assert.throws(() => validatePersistedJobOptions(options), /persisted job options/i, JSON.stringify(options));
});

// --- Invocation -----------------------------------------------------------------

test("V3 invocation emits the contract flags after a single artifact root", () => {
  const { command, args } = buildClipperInvocation({ options: V3 }, "/in/source.mp4", "/data/jobs/id/.attempts/abc/output", {});
  assert.equal(command, "/app/.venv/bin/ai-clipper");
  assert.deepEqual(args, [
    "/in/source.mp4", "--output-dir", "/data/jobs/id/.attempts/abc/output",
    "--model", "small", "--device", "cpu", "--language", "id",
    "--min-duration", "20", "--max-duration", "60", "--limit", "3",
    "--width", "720", "--height", "1280", "--render-mode", "fit-blur",
    "--artifact-root", "/data/jobs/id/.attempts/abc",
    "--selection-mode", "v3", "--llm", "auto", "--cold-open", "--hook-overlay", "--caption-style", "karaoke",
  ]);
  assert.equal(args.filter((value) => value === "--artifact-root").length, 1);
  assert.ok(!args.includes("--clip-profile"));

  const off = buildClipperInvocation({ options: { ...V3, llmMode: "off", coldOpen: false, hookOverlay: false, captionStyle: "classic" } }, "/in", "/o/output", {}).args;
  assert.deepEqual(off.slice(off.indexOf("--selection-mode")), [
    "--selection-mode", "v3", "--llm", "off", "--no-cold-open", "--no-hook-overlay", "--caption-style", "classic",
  ]);
});

test("--captions-dir is passed only for V3 and only with an absolute directory", () => {
  const withCaptions = buildClipperInvocation({ options: V3 }, "/in", "/j/output", {}, { captionsDir: "/j/input/captions" }).args;
  assert.deepEqual(withCaptions.slice(-2), ["--captions-dir", "/j/input/captions"]);
  assert.equal(withCaptions.filter((value) => value === "--captions-dir").length, 1);
  for (const captionsDir of [null, undefined, "", "relative/captions", 42]) {
    assert.ok(!buildClipperInvocation({ options: V3 }, "/in", "/j/output", {}, { captionsDir }).args.includes("--captions-dir"));
  }
  for (const options of [BASE, { ...BASE, selectionMode: "v1" }, V2]) {
    const args = buildClipperInvocation({ options }, "/in", "/j/output", {}, { captionsDir: "/j/input/captions" }).args;
    assert.ok(!args.includes("--captions-dir"), JSON.stringify(options));
    assert.ok(!args.includes("--llm"));
  }
});

// --- Captions -------------------------------------------------------------------

test("caption downloads use two bounded json3 yt-dlp runs with the download conventions", () => {
  const [manual, auto] = buildCaptionDownloads("https://youtu.be/abc", "/j/input");
  assert.deepEqual(manual.args, [
    "--no-playlist", "--js-runtimes", "node", "--skip-download", "--ignore-errors",
    "--write-subs", "--no-write-auto-subs", "--sub-langs", "id,id-ID,in", "--sub-format", "json3",
    "--output", "/j/input/captions/manual/source.%(ext)s", "https://youtu.be/abc",
  ]);
  assert.deepEqual(auto.args, [
    "--no-playlist", "--js-runtimes", "node", "--skip-download", "--ignore-errors",
    "--write-auto-subs", "--no-write-subs", "--sub-langs", "id,id-orig", "--sub-format", "json3",
    "--output", "/j/input/captions/auto/source.%(ext)s", "https://youtu.be/abc",
  ]);
  assert.deepEqual(CAPTION_LANGUAGES, { manual: "id,id-ID,in", auto: "id,id-orig" });
  assert.equal(captionsTimeoutMs({}), 120_000);
  assert.equal(captionsTimeoutMs({ POTONGIN_CAPTIONS_TIMEOUT_MS: "30000" }), 30_000);
  for (const value of ["0", "-1", "1e9", "abc", "999999999"]) assert.equal(captionsTimeoutMs({ POTONGIN_CAPTIONS_TIMEOUT_MS: value }), 120_000);
});

test("caption failures are logged and never fail the job; a lease loss still aborts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clipper-captions-"));
  const calls = [];
  const logs = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    if (args.includes("--write-subs")) throw new Error("yt-dlp gagal (exit 1)");
    await writeFile(args[args.indexOf("--output") + 1].replace("%(ext)s", "id.json3"), '{"events":[]}');
  };
  const captionsDir = await fetchYouTubeCaptions({ url: "https://youtu.be/abc", inputRoot: root, run, timeoutMs: 5_000, log: (line) => logs.push(line) });
  assert.equal(captionsDir, path.join(root, "captions"));
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.command === "yt-dlp" && call.options.timeoutMs === 5_000));
  assert.match(logs.join("\n"), /manual.*dilewati/);

  const empty = await mkdtemp(path.join(os.tmpdir(), "clipper-captions-none-"));
  const failing = async () => { throw new Error("no captions"); };
  assert.equal(await fetchYouTubeCaptions({ url: "https://youtu.be/abc", inputRoot: empty, run: failing, log: () => {} }), null);

  await assert.rejects(
    fetchYouTubeCaptions({ url: "https://youtu.be/abc", inputRoot: empty, run: async () => { throw new LeaseLostError(); }, log: () => {} }),
    LeaseLostError,
  );
});

test("findCaptionsDir needs a non-empty regular .json3 file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clipper-find-captions-"));
  assert.equal(await findCaptionsDir(root), null);
  await mkdir(path.join(root, "captions", "auto"), { recursive: true });
  await writeFile(path.join(root, "captions", "auto", "source.id.vtt"), "WEBVTT");
  await writeFile(path.join(root, "captions", "auto", "source.id.json3"), "");
  await writeFile(path.join(root, "captions", "auto", ".hidden.json3"), "{}");
  assert.equal(await findCaptionsDir(root), null);
  await writeFile(path.join(root, "captions", "auto", "source.id-orig.json3"), "{}");
  assert.equal(await findCaptionsDir(root), path.join(root, "captions"));
});

test("yt-dlp never receives LLM keys or dashboard secrets", () => {
  const env = {
    PATH: "/usr/bin", HOME: "/home/app", JOBS_ROOT: "/data/jobs",
    POTONGIN_LLM_PROVIDERS: "gemini", POTONGIN_LLM_API_KEY: "k1", GEMINI_API_KEY: "k2", OPENROUTER_API_KEY: "k3",
    APP_PASSWORD: "p", APP_SESSION_SECRET: "s", WHISPER_MODEL: "small",
  };
  assert.deepEqual(downloaderEnv(env), { PATH: "/usr/bin", HOME: "/home/app", JOBS_ROOT: "/data/jobs", WHISPER_MODEL: "small" });
});

test("a process that overruns its timeout is killed and rejects with ProcessTimeoutError", async () => {
  const child = new EventEmitter();
  child.pid = 54321;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const kills = [];
  const promise = runFencedProcess({
    command: "yt-dlp", args: [], env: {}, heartbeatMs: 60_000, progress: false, timeoutMs: 10,
    spawnImpl: () => child,
    update: async () => ({}),
    killImpl: (pid, signal) => { kills.push([pid, signal]); queueMicrotask(() => child.emit("close", null, signal)); },
  });
  await assert.rejects(promise, ProcessTimeoutError);
  assert.deepEqual(kills[0], [-54321, "SIGTERM"]);
});

// --- Manifest mapping ----------------------------------------------------------

const MANIFEST_CLIP = {
  index: 1, score: 8.4, start: 100, end: 140, duration: 44.5, text: "Kenapa  banyak orang\ngagal nabung? Karena gaji habis duluan.",
  output: "/x/output/clip-01.mp4", subtitles: "/x/output/clip-01.srt",
  title: "Gaji Habis Sebelum Akhir Bulan?", hook_text: "Gaji lo habis duluan karena ini",
  description: "Rahasia kenapa tabungan tidak pernah tumbuh.", hashtags: ["#keuangan", "tabungan", "#Gaji Pertama"],
  archetype: "relatable_pain", selection_source: "llm", reasons: ["Hook pertanyaan kuat", "Payoff jelas"],
  scores: { hook: 9, standalone: 8, payoff: 7.5, emotion: 6, shareability: 8.25 },
  cold_open: { start: 120.5, end: 124 }, source_start: 100, source_end: 140,
};

test("manifest V3 clip fields map into sanitized camelCase job clip fields", () => {
  const clip = jobClipFromManifest(MANIFEST_CLIP, JOB_ID);
  assert.deepEqual(clip, {
    index: 1, score: 8.4, start: 100, end: 140, duration: 44.5,
    text: "Kenapa banyak orang gagal nabung? Karena gaji habis duluan.",
    videoUrl: `/api/jobs/${JOB_ID}/files/output/clip-01.mp4`,
    downloadUrl: `/api/jobs/${JOB_ID}/files/output/clip-01.mp4?download=1`,
    subtitleUrl: `/api/jobs/${JOB_ID}/files/output/clip-01.srt?download=1`,
    title: "Gaji Habis Sebelum Akhir Bulan?",
    hookText: "Gaji lo habis duluan karena ini",
    description: "Rahasia kenapa tabungan tidak pernah tumbuh.\n\n#keuangan #tabungan #GajiPertama",
    hashtags: ["#keuangan", "#tabungan", "#GajiPertama"],
    archetype: "relatable_pain",
    selectionSource: "llm",
    reasons: ["Hook pertanyaan kuat", "Payoff jelas"],
    scores: { hook: 9, standalone: 8, payoff: 7.5, emotion: 6, shareability: 8.25 },
    coldOpen: { start: 120.5, end: 124 },
    sourceStart: 100,
    sourceEnd: 140,
    metadataVersion: 5,
  });
});

test("manifest strings are capped, stripped of control characters, and bad types are dropped", () => {
  const hostile = {
    ...MANIFEST_CLIP,
    title: `Judul\u0000 dengan\u001b[31m escape\u202e dan ${"panjang ".repeat(40)}`,
    hook_text: "x".repeat(500),
    description: `Baris satu\r\n\r\n\r\n\r\nBaris dua\u0007${"y".repeat(2000)}`,
    hashtags: ["#ok", "<script>", "#" + "a".repeat(41), 7, null, "#ok", "#Émoji_ok"],
    archetype: "Story-Twist",
    reasons: ["alasan", 5, { text: "obj" }, "", ..."abcdefghij".split("")],
    scores: { hook: 11, standalone: -1, payoff: "8", emotion: Number.NaN, shareability: 7, extra: 9 },
    cold_open: { start: 10, end: 9 },
    source_start: "100",
    source_end: 140,
    text: { toString: () => "not a string" },
    score: "9",
  };
  const clip = jobClipFromManifest(hostile, JOB_ID);
  assert.doesNotMatch(JSON.stringify(clip), /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u202e]/);
  assert.ok(Array.from(clip.title).length <= 100);
  assert.ok(clip.title.startsWith("Judul dengan[31m escape dan"));
  assert.ok(Array.from(clip.hookText).length <= 90 && clip.hookText.endsWith("…"));
  assert.ok(clip.description.startsWith("Baris satu\n\nBaris dua"));
  assert.deepEqual(clip.hashtags, ["#ok", "#Émoji_ok"]);
  assert.equal(clip.archetype, "story_twist");
  assert.equal(clip.selectionSource, "llm");
  assert.equal(clip.reasons.length, 8);
  assert.deepEqual(clip.reasons.slice(0, 2), ["alasan", "a"]);
  assert.deepEqual(clip.scores, { shareability: 7 });
  assert.equal(clip.coldOpen, undefined);
  assert.equal(clip.sourceStart, undefined);
  assert.equal(clip.text, "");
  assert.equal(clip.score, null);

  // Without a valid selection source the clip is not engine-packaged: the
  // transcript-derived social metadata applies exactly as for V1 clips.
  assert.deepEqual(sanitizeManifestClipFields({ selection_source: "gpt", scores: [], cold_open: [1, 2], hashtags: "#a" }), {});
  const unsourced = jobClipFromManifest({ ...hostile, selection_source: "gpt" }, JOB_ID);
  assert.equal(unsourced.selectionSource, undefined);
  assert.equal(unsourced.title, generateSocialMetadata("").title);
  assert.equal(unsourced.hookText, clip.hookText);
});

test("sanitizers are idempotent and keep newlines only where allowed", () => {
  const line = sanitizeLine(" a\tb\nc\u2028d\u200be\u00ade ", 100);
  assert.equal(line, "a b c dee");
  assert.equal(sanitizeLine(line, 100), line);
  const multi = sanitizeMultiline("satu\r\ndua\n\n\n\ntiga\u0000", 100);
  assert.equal(multi, "satu\ndua\n\ntiga");
  const long = sanitizeMultiline(`${"kata ".repeat(300)}`, 50);
  assert.equal(sanitizeMultiline(long, 50), long);
  assert.equal(sanitizeLine("\u0000\u0001", 10), null);
  assert.equal(sanitizeLine(42, 10), null);
  assert.equal(Array.from(sanitizeLine("😀".repeat(20), 10)).length, 10);
});

test("V1 manifests from the new engine keep transcript metadata and gain only valid fields", () => {
  const v1 = {
    index: 2, score: 13, start: 0, end: 60, duration: 60, text: "Cerita sepeda custom yang menarik sekali.",
    output: "/x/clip-02.mp4", subtitles: "/x/clip-02.srt",
    title: null, hook_text: null, description: null, hashtags: [], archetype: null,
    selection_source: "v1", reasons: [], scores: null, cold_open: null, source_start: 0, source_end: 60,
  };
  const clip = jobClipFromManifest(v1, JOB_ID);
  const generated = generateSocialMetadata(v1.text);
  assert.equal(clip.title, generated.title);
  assert.equal(clip.description, generated.description);
  assert.deepEqual(clip.hashtags, generated.hashtags);
  assert.equal(clip.selectionSource, "v1");
  assert.equal(clip.score, 13);
  for (const key of ["hookText", "archetype", "reasons", "scores", "coldOpen"]) assert.equal(clip[key], undefined, key);
});

test("old manifests map to exactly the historical job clip shape", () => {
  const clip = jobClipFromManifest({
    index: 1, score: 9, start: 0, end: 30, duration: 30, text: "V1 exact result",
    output: "/o/clip.mp4", subtitles: "/o/clip.srt",
  }, JOB_ID);
  assert.deepEqual(clip, {
    index: 1, score: 9, start: 0, end: 30, duration: 30, text: "V1 exact result",
    videoUrl: `/api/jobs/${JOB_ID}/files/output/clip.mp4`,
    downloadUrl: `/api/jobs/${JOB_ID}/files/output/clip.mp4?download=1`,
    subtitleUrl: `/api/jobs/${JOB_ID}/files/output/clip.srt?download=1`,
    ...generateSocialMetadata("V1 exact result"),
  });
});

test("packaged clips missing a description or hashtags are filled from the transcript", () => {
  const partial = jobClipFromManifest({ ...MANIFEST_CLIP, description: "", hashtags: [] }, JOB_ID);
  const generated = generateSocialMetadata(partial.text);
  assert.equal(partial.title, "Gaji Habis Sebelum Akhir Bulan?");
  assert.deepEqual(partial.hashtags, generated.hashtags);
  assert.equal(partial.description, generated.description);

  const noTags = jobClipFromManifest({ ...MANIFEST_CLIP, hashtags: [] }, JOB_ID);
  assert.ok(noTags.description.startsWith("Rahasia kenapa tabungan tidak pernah tumbuh.\n\n#fyp"));
  assert.deepEqual(clipSocialMetadata(noTags), { title: noTags.title, description: noTags.description, hashtags: noTags.hashtags, metadataVersion: 5 });
});

// --- Selection V3 summary --------------------------------------------------------

const SUMMARY = {
  mode: "v3", status: "completed", source: "llm", provider: "ollama-cloud", model: "gpt-oss:120b",
  prompt_version: "hooks-v3.1", warnings: ["no_word_timestamps", "llm_error:openrouter/qwen/qwen3.8-27b:free:rate_limited"],
  artifact: "analysis/selection.v3.json", transcript_source: "youtube-captions",
};

test("selection_v3 summaries pass an explicit allowlist", () => {
  const raw = { ...SUMMARY, api_key: "sk-secret", usage: { input_tokens: 5 }, sourcePath: "/private/source.mp4" };
  assert.deepEqual(sanitizeSelectionV3Summary(raw), SUMMARY);
  assert.doesNotMatch(JSON.stringify(sanitizeSelectionV3Summary(raw)), /secret|private|usage/);
  assert.deepEqual(sanitizeSelectionV3Summary({ mode: "v3", status: "fallback", source: "heuristic", prompt_version: "hooks-v3.1", warnings: ["llm_unavailable"] }), {
    mode: "v3", status: "fallback", source: "heuristic", provider: null, model: null, prompt_version: "hooks-v3.1",
    warnings: ["llm_unavailable"], artifact: null, transcript_source: null,
  });
  assert.equal(sanitizeSelectionV3Summary({ mode: "v3", status: "failed" }).source, null);
});

test("selection_v3 summaries drop invalid structure and unsafe descriptive values", () => {
  for (const raw of [
    null, [], "v3", { ...SUMMARY, mode: "v2-shadow" }, { ...SUMMARY, status: "done" },
    { ...SUMMARY, source: "gpt" }, { ...SUMMARY, source: undefined },
    { ...SUMMARY, status: "fallback", source: "llm" },
    { ...SUMMARY, artifact: "/private/selection.v3.json" }, { ...SUMMARY, warnings: "llm_unavailable" },
  ]) assert.equal(sanitizeSelectionV3Summary(raw), null, JSON.stringify(raw));

  const cleaned = sanitizeSelectionV3Summary({
    ...SUMMARY,
    provider: "Ollama Cloud; rm -rf",
    model: "model with spaces",
    prompt_version: "x".repeat(65),
    transcript_source: "subtitles",
    warnings: [
      "llm_unavailable", "api_key=sk-secret", "Error: request failed with key sk-123", "x".repeat(161),
      "UPPER_case", 42, null, "llm_unavailable", ...Array.from({ length: 60 }, (_, index) => `code_${index}`),
    ],
  });
  assert.equal(cleaned.provider, null);
  assert.equal(cleaned.model, null);
  assert.equal(cleaned.prompt_version, null);
  assert.equal(cleaned.transcript_source, null);
  assert.equal(cleaned.warnings[0], "llm_unavailable");
  assert.equal(cleaned.warnings.length, 50);
  assert.doesNotMatch(JSON.stringify(cleaned), /secret|sk-123|UPPER|rm -rf/);
});

test("manifestJobPatch persists selection_v3 next to selection_v2 and on failure", () => {
  const clips = [{ index: 1 }];
  assert.deepEqual(manifestJobPatch({ status: "completed", selection_v3: SUMMARY }, clips), { selectionV3: SUMMARY, clips });
  assert.deepEqual(manifestJobPatch({ status: "failed", selection_v3: { ...SUMMARY, status: "failed" } }), { selectionV3: { ...SUMMARY, status: "failed" } });
  assert.deepEqual(manifestJobPatch({ status: "completed", selection_v3: { ...SUMMARY, mode: "v1" } }, clips), { clips });
});

// --- Public serialization --------------------------------------------------------

test("public jobs keep engine packaging and re-sanitize stored V3 fields", () => {
  const packaged = jobClipFromManifest(MANIFEST_CLIP, JOB_ID);
  const publicJob = serializePublicJob({
    id: JOB_ID, sourcePath: "/private/source.mp4", options: V3, clips: [packaged],
    selectionV3: { ...SUMMARY, api_key: "sk-secret" }, selection_v3: SUMMARY,
  });
  assert.deepEqual(publicJob.clips[0], packaged);
  assert.deepEqual(publicJob.selectionV3, SUMMARY);
  assert.equal(publicJob.selection_v3, undefined);
  assert.doesNotMatch(JSON.stringify(publicJob), /private|secret/);

  const tampered = serializePublicJob({
    id: JOB_ID, options: V3,
    clips: [{ ...packaged, title: "Judul\u0000\u202e", hookText: 7, scores: { hook: 99 }, coldOpen: "yes", reasons: "bukan array", selectionSource: "llm" }],
    selectionV3: { mode: "v3", status: "weird" },
  });
  assert.equal(tampered.clips[0].title, "Judul");
  assert.equal(tampered.clips[0].hookText, undefined);
  assert.equal(tampered.clips[0].scores, undefined);
  assert.equal(tampered.clips[0].coldOpen, undefined);
  assert.equal(tampered.clips[0].reasons, undefined);
  assert.equal(tampered.selectionV3, undefined);
});

test("enrichJobSocialMetadata keeps LLM and heuristic packaging but regenerates stale V1 metadata", () => {
  const llm = { text: "Cerita sepeda custom yang menarik", title: "Judul dari LLM", description: "Deskripsi LLM\n\n#sepeda", hashtags: ["#sepeda"], selectionSource: "llm" };
  const heuristic = { ...llm, title: "Judul heuristik", selectionSource: "heuristic" };
  const job = enrichJobSocialMetadata({ clips: [llm, heuristic, { text: llm.text, title: "Judul lama", description: "Lama", hashtags: ["#old"] }] });
  assert.equal(job.clips[0].title, "Judul dari LLM");
  assert.equal(job.clips[0].description, "Deskripsi LLM\n\n#sepeda");
  assert.deepEqual(job.clips[0].hashtags, ["#sepeda"]);
  assert.equal(job.clips[1].title, "Judul heuristik");
  assert.notEqual(job.clips[2].title, "Judul lama");
  // V1-sourced or title-less clips are not engine packaging.
  const v1 = enrichJobSocialMetadata({ clips: [{ ...llm, selectionSource: "v1" }, { ...llm, title: "  " }] });
  assert.notEqual(v1.clips[0].title, "Judul dari LLM");
  assert.notEqual(v1.clips[1].title, "  ");
});

test("legacy jobs serialize exactly as before Selection V3", () => {
  const legacyClip = {
    index: 1, score: 9, start: 0, end: 30, duration: 30, text: "Klip lama",
    videoUrl: "/v", downloadUrl: "/d", subtitleUrl: "/s", ...generateSocialMetadata("Klip lama"),
  };
  const legacy = { id: "old", status: "completed", options: BASE, clips: [legacyClip], sourcePath: "/private" };
  const serialized = serializePublicJob(legacy);
  assert.deepEqual(serialized, { id: "old", status: "completed", options: { ...BASE, selectionMode: "v1" }, clips: [legacyClip] });
  assert.equal(sanitizeStoredClip(legacyClip), legacyClip);
  assert.equal(isV3Job(serialized), false);
  assert.equal(clipCaptionText(legacyClip), `${legacyClip.title}\n\n${legacyClip.description}`);
});

// --- View helpers --------------------------------------------------------------

test("view helpers label archetypes, sources and scores in Indonesian", () => {
  assert.equal(archetypeLabel("relatable_pain"), "Masalah yang relate");
  assert.equal(archetypeLabel("brand_new_code"), "Lainnya");
  assert.equal(archetypeLabel(null), null);
  assert.equal(selectionSourceLabel("llm"), "AI/LLM");
  assert.equal(selectionSourceLabel("heuristic"), "Heuristik");
  assert.equal(selectionSourceLabel("v1"), "V1");
  assert.equal(selectionSourceLabel("x"), null);
  assert.equal(tenPointScore(13), null);
  assert.equal(tenPointScore(8.4), 8.4);
  assert.deepEqual(scoreRows({ hook: 9, payoff: 11, emotion: 6 }).map((row) => [row.label, row.percent]), [["Hook", 90], ["Emosi", 60]]);
  assert.equal(isV3Job({ options: { selectionMode: "v3" } }), true);
  assert.equal(isV3Job({ options: {}, selectionV3: SUMMARY }), true);
});

test("caption parts separate the hashtag line and copy text stays complete", () => {
  const clip = jobClipFromManifest(MANIFEST_CLIP, JOB_ID);
  assert.deepEqual(captionParts(clip), { body: "Rahasia kenapa tabungan tidak pernah tumbuh.", hashtags: ["#keuangan", "#tabungan", "#GajiPertama"] });
  assert.equal(clipCaptionText(clip), `${clip.title}\n\n${clip.description}`);
  const detached = { title: "T", description: "Isi", hashtags: ["#a", "#b"] };
  assert.deepEqual(captionParts(detached), { body: "Isi", hashtags: ["#a", "#b"] });
  assert.equal(clipCaptionText(detached), "T\n\nIsi\n\n#a #b");
});

test("selection summary view explains fallback in plain Indonesian", () => {
  assert.equal(selectionV3SummaryView(null), null);
  const ok = selectionV3SummaryView(SUMMARY);
  assert.equal(ok.tone, "ok");
  assert.match(ok.detail, /ollama-cloud \/ gpt-oss:120b/);
  assert.equal(ok.transcript, "Transkrip dari subtitle YouTube");
  const fallback = selectionV3SummaryView({ ...SUMMARY, status: "fallback", source: "heuristic" });
  assert.equal(fallback.tone, "warning");
  assert.match(fallback.detail, /LLM gagal atau tidak tersedia/);
  assert.equal(selectionV3SummaryView({ ...SUMMARY, status: "failed" }).tone, "error");
  assert.match(selectionV3SummaryView({ ...SUMMARY, source: "heuristic", provider: null, model: null }).detail, /heuristik/);
});

test("LLM badge view reflects the job's LLM choice and the configured status", () => {
  assert.deepEqual(llmStatusView(null), { tone: "muted", label: "Memeriksa status LLM…" });
  assert.equal(llmStatusView({ state: "active", label: "LLM aktif: groq" }).tone, "ok");
  assert.equal(llmStatusView({ state: "unusable", label: "LLM belum siap — memakai heuristik" }).tone, "warning");
  assert.equal(llmStatusView({ state: "unconfigured", label: "LLM belum dikonfigurasi — memakai heuristik" }).tone, "muted");
  assert.match(llmStatusView({ state: "active", label: "LLM aktif: groq" }, "off").label, /tidak dipakai/);
});

test("dashboard defaults to V3, keeps V1 and V2 shadow under Mode lama, and reads the LLM status", async () => {
  const source = await readFile(new URL("../app/dashboard/page.jsx", import.meta.url), "utf8");
  assert.match(source, /useState\("v3"\)/);
  assert.match(source, /AI Hook \(V3\)/);
  assert.match(source, /<summary>Mode lama<\/summary>/);
  assert.match(source, /Klasik V1/);
  assert.match(source, /V2 shadow/);
  assert.match(source, /fetch\("\/api\/llm\/status", \{ cache: "no-store"/);
  for (const field of ["llmMode", "coldOpen", "hookOverlay", "captionStyle"]) assert.match(source, new RegExp(`data\\.set\\("${field}"`));
  assert.match(source, /Buka dengan kalimat terkuat/);
  assert.match(source, /Teks hook 4 detik pertama/);
  assert.match(source, /Tanpa LLM \(heuristik\)/);
  assert.match(source, /clipCaptionText\(clip\)/);
  // V3 never sends a clip profile; only V2 shadow does.
  assert.match(source, /else if \(selectionMode === "v2-shadow"\) \{\s*data\.set\("clipProfile"/);
});

test("project page shows V3 packaging only for V3 jobs and keeps the legacy layout for old jobs", async () => {
  const source = await readFile(new URL("../app/projects/[id]/page.jsx", import.meta.url), "utf8");
  assert.match(source, /const v3 = isV3Job\(job\)/);
  assert.match(source, /<SelectionV3Summary summary=\{job\.selectionV3\} \/>/);
  assert.match(source, /\{!v3 && <section className="legacySection shell" aria-labelledby="legacy-title">/);
  assert.match(source, /\{v3 \? "Klip" : "Klip lama"\}/);
  assert.match(source, /clipCaptionText\(clip\)/);
  for (const text of ["Teks hook", "Kenapa dipilih", "Salin caption", "Cold open"]) assert.ok(source.includes(text), text);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
});

// --- LLM status -------------------------------------------------------------------

const SECRET_ENV = {
  POTONGIN_LLM_PROVIDERS: "ollama-cloud,openrouter,gemini,groq,deepseek",
  POTONGIN_LLM_FREE_ONLY: "1",
  OLLAMA_API_KEY: "ollama-secret-value-123",
  OPENROUTER_API_KEY: "sk-or-v1-secret-value-456",
  DEEPSEEK_API_KEY: "sk-deepseek-secret-789",
  POTONGIN_LLM_GEMINI_MODEL: "gemini-3.8-flash",
  POTONGIN_LLM_BASE_URL: "https://user:pass@proxy.example/v1",
};

test("LLM status reports order, keys, FREE_ONLY and model names without leaking secrets", () => {
  const status = readLlmStatus(SECRET_ENV);
  assert.equal(status.state, "active");
  assert.deepEqual(status.order, ["ollama-cloud", "openrouter"]);
  assert.equal(status.freeOnly, true);
  assert.equal(status.label, "LLM aktif: ollama-cloud → openrouter (hanya model gratis)");
  const byName = Object.fromEntries(status.providers.map((item) => [item.name, item]));
  assert.equal(byName.gemini.reason, "missing_api_key");
  assert.equal(byName.gemini.modelOverride, "gemini-3.8-flash");
  assert.equal(byName.deepseek.reason, "not_free");
  assert.equal(byName.deepseek.keySet, true);
  const serialized = JSON.stringify(status);
  for (const secret of ["secret", "pass@", "proxy.example", "23", "456", "789"]) assert.ok(!serialized.includes(secret), secret);
  for (const item of status.providers) {
    assert.deepEqual(Object.keys(item).sort(), ["custom", "displayName", "fallbackOverride", "keySet", "known", "local", "modelOverride", "name", "paid", "reason", "usable"]);
  }
});

test("LLM status covers off, unconfigured, unusable and invalid configurations", () => {
  assert.equal(readLlmStatus({}).label, "LLM belum dikonfigurasi — memakai heuristik");
  assert.equal(readLlmStatus({}).state, "unconfigured");
  assert.equal(readLlmStatus({ ...SECRET_ENV, POTONGIN_LLM: "off" }).state, "disabled");
  assert.deepEqual(readLlmStatus({ ...SECRET_ENV, POTONGIN_LLM: "OFF" }).providers, []);
  const unusable = readLlmStatus({ POTONGIN_LLM_PROVIDER: "gemini" });
  assert.equal(unusable.state, "unusable");
  assert.match(unusable.label, /gemini: API key belum diisi/);
  assert.equal(readLlmStatus({ POTONGIN_LLM_PROVIDERS: "gemini,groq" }).label, "LLM belum siap — memakai heuristik");
  assert.equal(readLlmStatus({ POTONGIN_LLM_PROVIDERS: "gemini", GEMINI_API_KEY: "k", POTONGIN_LLM_FREE_ONLY: "maybe" }).state, "invalid");
  assert.equal(readLlmStatus({ POTONGIN_LLM_PROVIDERS: "gemini!" }).state, "invalid");
  assert.equal(readLlmStatus({ POTONGIN_LLM_PROVIDERS: "custom" }).state, "invalid");
  assert.equal(readLlmStatus({ POTONGIN_LLM_PROVIDERS: "ollama" }).state, "active");
  assert.equal(readLlmStatus({ POTONGIN_LLM_PROVIDER: "groq", POTONGIN_LLM_PROVIDERS: "gemini", GROQ_API_KEY: "k" }).order[0], "groq");
  // The shared key only counts for the first provider in the list.
  assert.deepEqual(readLlmStatus({ POTONGIN_LLM_PROVIDERS: "gemini,groq", POTONGIN_LLM_API_KEY: "k" }).order, ["gemini"]);
  const freeRouter = readLlmStatus({ POTONGIN_LLM_PROVIDERS: "openrouter", OPENROUTER_API_KEY: "k", POTONGIN_LLM_FREE_ONLY: "1", POTONGIN_LLM_MODEL: "openai/gpt-5", POTONGIN_LLM_FALLBACK_MODELS: "none" });
  assert.equal(freeRouter.providers[0].reason, "not_free");
  const badModel = readLlmStatus({ POTONGIN_LLM_PROVIDERS: "gemini", GEMINI_API_KEY: "k", POTONGIN_LLM_MODEL: "has space" });
  assert.equal(badModel.state, "invalid");
  assert.doesNotMatch(JSON.stringify(badModel), /has space/);
});

test("LLM status mirrors the worker's strict parsing of URLs, models and tuning values", () => {
  const base = { POTONGIN_LLM_PROVIDERS: "gemini", GEMINI_API_KEY: "k" };
  assert.equal(readLlmStatus(base).state, "active");
  // Accepted by llm.py: any non-space model ID, local http, numeric tuning within range.
  const lenient = readLlmStatus({ ...base, POTONGIN_LLM_MODEL: "models/gemini~exp", POTONGIN_LLM_TIMEOUT: "90.5", POTONGIN_LLM_RPM: "off", POTONGIN_LLM_REASONING_EFFORT: "LOW" });
  assert.equal(lenient.state, "active");
  assert.equal(lenient.providers[0].modelOverride, null, "only plain identifiers are displayed");
  assert.equal(readLlmStatus({ POTONGIN_LLM_PROVIDERS: "custom", POTONGIN_LLM_BASE_URL: "http://host.docker.internal:1234/v1", POTONGIN_LLM_MODEL: "local" }).state, "active");
  assert.equal(readLlmStatus({ POTONGIN_LLM_PROVIDERS: "ollama", POTONGIN_LLM_BASE_URL: "http://[::1]:11434/v1" }).state, "active");
  for (const [name, value] of [
    ["POTONGIN_LLM_BASE_URL", "http://remote.example/v1"],
    ["POTONGIN_LLM_BASE_URL", "ftp://files.example"],
    ["POTONGIN_LLM_BASE_URL", "not a url"],
    ["POTONGIN_LLM_TIMEOUT", "0"],
    ["POTONGIN_LLM_TIMEOUT", "0x10"],
    ["POTONGIN_LLM_MAX_RETRIES", "11"],
    ["POTONGIN_LLM_CONTEXT_TOKENS", "100"],
    ["POTONGIN_LLM_MAX_OUTPUT_TOKENS", "1.5"],
    ["POTONGIN_LLM_TEMPERATURE", "3"],
    ["POTONGIN_LLM_JSON_MODE", "maybe"],
    ["POTONGIN_LLM_REASONING_EFFORT", "extreme"],
    ["POTONGIN_LLM_RPM", "-5"],
    ["POTONGIN_LLM_GEMINI_TIMEOUT", "never"],
  ]) {
    const status = readLlmStatus({ ...base, [name]: value });
    assert.equal(status.state, "invalid", `${name}=${value}`);
    assert.ok(!JSON.stringify(status).includes(value), `${name} value must not be echoed`);
  }
  // A missing key is reported before a bad fallback list, exactly like the worker.
  const skipped = readLlmStatus({ POTONGIN_LLM_PROVIDERS: "gemini,groq", GROQ_API_KEY: "k", POTONGIN_LLM_FALLBACK_MODELS: "bad model" });
  assert.equal(skipped.state, "active");
  assert.deepEqual(skipped.order, ["groq"]);
});

test("stored clips that claim engine packaging but fail validation regenerate their metadata", () => {
  const stale = { index: 1, text: "Cerita sepeda custom yang menarik", selectionSource: "llm", title: "\u0000\u202e", description: "x", hashtags: ["#x"], metadataVersion: 5 };
  const [served] = serializePublicJob({ id: JOB_ID, options: V3, clips: [stale] }).clips;
  const generated = generateSocialMetadata(stale.text);
  assert.equal(served.title, generated.title);
  assert.equal(served.description, generated.description);
  assert.equal(served.selectionSource, "llm");
});

test("LLM status route is authenticated and never cached", async () => {
  const denied = await createLlmStatusHandler({
    authorize: () => Response.json({ error: "no" }, { status: 401 }),
    env: SECRET_ENV,
  })(new Request("http://local/api/llm/status"));
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get("cache-control"), "no-store");

  const response = await createLlmStatusHandler({ authorize: () => null, env: SECRET_ENV })(new Request("http://local/api/llm/status"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.text();
  assert.match(body, /ollama-cloud/);
  assert.doesNotMatch(body, /secret|pass@/);

  const real = await createLlmStatusHandler({ env: SECRET_ENV })(new Request("http://local/api/llm/status"));
  assert.equal(real.status, 401);
  assert.equal(real.headers.get("cache-control"), "no-store");
});

// --- Worker integration ------------------------------------------------------------

const FAKE_V3_ENGINE = `#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const output = arg("--output-dir");
await mkdir(output, { recursive: true });
await mkdir(path.join(arg("--artifact-root"), "analysis"), { recursive: true });
await writeFile(path.join(arg("--artifact-root"), "analysis", "selection.v3.json"), "{}");
await writeFile(path.join(output, "argv.json"), JSON.stringify(process.argv.slice(2)));
await writeFile(path.join(output, "env.json"), JSON.stringify({ gemini: process.env.GEMINI_API_KEY || null }));
await writeFile(path.join(output, "manifest.json"), JSON.stringify({
  status: "completed",
  selection_v3: ${JSON.stringify({ ...SUMMARY, status: "fallback", source: "heuristic", secret: "do-not-copy" })},
  clips: [${JSON.stringify({ ...MANIFEST_CLIP, title: "Judul\u0007 hook", selection_source: "heuristic" })}].map((clip) => ({
    ...clip, output: path.join(output, "clip-01.mp4"), subtitles: path.join(output, "clip-01.srt"),
  })),
}));
`;

// Writes the video for the download run; the caption runs record their env and
// write a json3 file for auto captions only (manual subtitles "do not exist").
const FAKE_CAPTION_YT_DLP = `#!/usr/bin/env node
import { appendFile, writeFile } from "node:fs/promises";
const argv = process.argv.slice(2);
const template = argv[argv.indexOf("--output") + 1];
await appendFile(process.env.YT_DLP_LOG, JSON.stringify({ argv, gemini: process.env.GEMINI_API_KEY || null }) + "\\n");
if (!argv.includes("--skip-download")) {
  await writeFile(template.replace("%(ext)s", "mp4"), Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(20)]));
} else if (argv.includes("--write-auto-subs")) {
  await writeFile(template.replace("%(ext)s", "id.json3"), '{"events":[]}');
} else {
  console.error("ERROR: There are no subtitles for the requested languages");
  process.exit(1);
}
`;

async function v3Fixture(prefix, { options = V3, captions = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const jobRoot = path.join(root, JOB_ID);
  await mkdir(path.join(jobRoot, "input"), { recursive: true });
  await writeFile(path.join(jobRoot, "job.json"), JSON.stringify({
    id: JOB_ID, status: "queued", progress: 0,
    createdAt: "2026-09-24T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z",
    source: { type: "youtube", url: "https://youtu.be/abc" }, sourcePath: null, options, clips: [],
  }));
  const bin = await mkdtemp(path.join(os.tmpdir(), "clipper-v3-bin-"));
  await writeFile(path.join(bin, "engine.mjs"), FAKE_V3_ENGINE);
  await writeFile(path.join(bin, "yt-dlp"), captions ? FAKE_CAPTION_YT_DLP : FAKE_CAPTION_YT_DLP.replace("argv.includes(\"--write-auto-subs\")", "false"));
  await chmod(path.join(bin, "engine.mjs"), 0o755);
  await chmod(path.join(bin, "yt-dlp"), 0o755);
  const log = path.join(bin, "yt-dlp.log");
  const env = {
    ...process.env, JOBS_ROOT: root, PRIMARY_LEASE_MS: "60000", AI_CLIPPER_BIN: path.join(bin, "engine.mjs"),
    PATH: `${bin}${path.delimiter}${process.env.PATH}`, YT_DLP_LOG: log, GEMINI_API_KEY: "gemini-secret-for-engine",
  };
  return { root, jobRoot, env, log };
}

test("a V3 YouTube job fetches captions, passes --captions-dir, and persists sanitized V3 results", async () => {
  const { root, jobRoot, env, log } = await v3Fixture("clipper-v3-worker-");
  const claim = await claimNextJob({ jobsRoot: root, workerId: "worker", leaseMs: 60_000, maxAttempts: 3, legacyQuiescenceMs: 0 });
  await main(["node", "run-job.mjs", JOB_ID, claim.token], env);

  const runs = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(runs.length, 3);
  assert.ok(runs.every((run) => run.gemini === null), "yt-dlp must not see LLM keys");
  assert.ok(runs[1].argv.includes("--write-subs") && runs[2].argv.includes("--write-auto-subs"));

  const persisted = JSON.parse(await readFile(path.join(jobRoot, "job.json"), "utf8"));
  assert.equal(persisted.status, "completed");
  const argv = JSON.parse(await readFile(path.join(jobRoot, "output", "argv.json"), "utf8"));
  const attemptInput = path.dirname(path.dirname(argv[0]));
  assert.equal(argv[argv.indexOf("--captions-dir") + 1], path.join(attemptInput, "input", "captions"));
  assert.equal(argv.filter((value) => value === "--artifact-root").length, 1);
  assert.deepEqual(argv.slice(argv.indexOf("--selection-mode"), argv.indexOf("--captions-dir")), [
    "--selection-mode", "v3", "--llm", "auto", "--cold-open", "--hook-overlay", "--caption-style", "karaoke",
  ]);
  assert.deepEqual(JSON.parse(await readFile(path.join(jobRoot, "output", "env.json"), "utf8")), { gemini: "gemini-secret-for-engine" });
  // Captions are published with the rest of input/.
  assert.equal(await readFile(path.join(jobRoot, "input", "captions", "auto", "source.id.json3"), "utf8"), '{"events":[]}');
  assert.equal(persisted.sourcePath, path.join(jobRoot, "input", "source.mp4"));

  assert.deepEqual(persisted.selectionV3, { ...SUMMARY, status: "fallback", source: "heuristic" });
  const [clip] = persisted.clips;
  assert.equal(clip.title, "Judul hook");
  assert.equal(clip.selectionSource, "heuristic");
  assert.equal(clip.hookText, "Gaji lo habis duluan karena ini");
  assert.deepEqual(clip.coldOpen, { start: 120.5, end: 124 });
  assert.doesNotMatch(JSON.stringify(persisted), /do-not-copy|gemini-secret/);
});

test("a V3 YouTube job without any captions runs Whisper (no --captions-dir) and still completes", async () => {
  const { root, jobRoot, env } = await v3Fixture("clipper-v3-nocaptions-", { captions: false });
  const claim = await claimNextJob({ jobsRoot: root, workerId: "worker", leaseMs: 60_000, maxAttempts: 3, legacyQuiescenceMs: 0 });
  await main(["node", "run-job.mjs", JOB_ID, claim.token], env);
  const persisted = JSON.parse(await readFile(path.join(jobRoot, "job.json"), "utf8"));
  assert.equal(persisted.status, "completed");
  const argv = JSON.parse(await readFile(path.join(jobRoot, "output", "argv.json"), "utf8"));
  assert.ok(!argv.includes("--captions-dir"));
});

test("V1 and V2 YouTube jobs never fetch captions", async () => {
  for (const options of [BASE, V2]) {
    const { root, jobRoot, env, log } = await v3Fixture("clipper-v3-legacy-", { options });
    const claim = await claimNextJob({ jobsRoot: root, workerId: "worker", leaseMs: 60_000, maxAttempts: 3, legacyQuiescenceMs: 0 });
    await main(["node", "run-job.mjs", JOB_ID, claim.token], env);
    const runs = (await readFile(log, "utf8")).trim().split("\n");
    assert.equal(runs.length, 1, JSON.stringify(options));
    await assert.rejects(lstat(path.join(jobRoot, "input", "captions")), { code: "ENOENT" });
  }
});
