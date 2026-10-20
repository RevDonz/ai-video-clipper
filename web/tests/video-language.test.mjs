// "Bahasa video" (plan 2026-10-20 P1 #6): a job may name the spoken language. The job API
// validates it, the worker passes it to the engine's --language and asks YouTube for captions
// in it. Jobs without the option run exactly as before.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseJobFormOptions } from "../app/api/jobs/route.js";
import { JOB_FORM_FIELDS, VIDEO_LANGUAGES, parseJobOptions, validatePersistedJobOptions } from "../lib/jobs.mjs";
import {
  CAPTION_LANGUAGES,
  buildCaptionDownloads,
  buildClipperInvocation,
  captionLanguages,
  fetchYouTubeCaptions,
} from "../scripts/run-job.mjs";

const BASE = { renderMode: "fit-blur", limit: 3, minDuration: 20, maxDuration: 60 };
const V3 = { ...BASE, selectionMode: "v3", llmMode: "auto", coldOpen: true, hookOverlay: true, captionStyle: "karaoke" };
const languageArg = (args) => args[args.indexOf("--language") + 1];

test("the job API accepts Indonesian, English and detection, and nothing else", () => {
  assert.deepEqual(VIDEO_LANGUAGES, ["id", "en", "auto"]);
  assert.ok(JOB_FORM_FIELDS.includes("videoLanguage"));
  for (const videoLanguage of VIDEO_LANGUAGES) {
    assert.equal(parseJobOptions({ videoLanguage }).videoLanguage, videoLanguage);
  }
  // A job that does not name it keeps today's behaviour: nothing is stored.
  for (const videoLanguage of [undefined, null, ""]) {
    assert.equal("videoLanguage" in parseJobOptions({ videoLanguage }), false, String(videoLanguage));
  }
  for (const videoLanguage of ["fr", "EN", "Inggris", "auto; rm -rf /", " en", ["en"], 1, true]) {
    assert.throws(() => parseJobOptions({ videoLanguage }), /video language/i, JSON.stringify(videoLanguage));
  }
});

test("the job form's videoLanguage field reaches the stored options", () => {
  const form = new FormData();
  form.set("youtubeUrl", "https://youtu.be/rBg0ZcwjVKQ");
  form.set("videoLanguage", "en");
  assert.equal(parseJobFormOptions(form).videoLanguage, "en");
  form.set("videoLanguage", "jp");
  assert.throws(() => parseJobFormOptions(form), /video language/i);
});

test("stored options keep a valid language for the current selection and refuse any other", () => {
  for (const videoLanguage of VIDEO_LANGUAGES) {
    assert.deepEqual(validatePersistedJobOptions({ ...V3, videoLanguage }), { ...V3, videoLanguage });
  }
  assert.equal("videoLanguage" in validatePersistedJobOptions(V3), false);
  for (const options of [
    { ...V3, videoLanguage: "de" },
    { ...V3, videoLanguage: null },
    { ...V3, videoLanguage: ["id"] },
    { ...BASE, videoLanguage: "en" },
    { ...BASE, selectionMode: "v1", videoLanguage: "en" },
  ]) assert.throws(() => validatePersistedJobOptions(options), /persisted job options/i, JSON.stringify(options));
});

test("the engine gets the job's language; jobs without one keep WHISPER_LANGUAGE or id", () => {
  const job = (options) => ({ options });
  assert.equal(languageArg(buildClipperInvocation(job(V3), "/in", "/o/output", {}).args), "id");
  assert.equal(languageArg(buildClipperInvocation(job(V3), "/in", "/o/output", { WHISPER_LANGUAGE: "jv" }).args), "jv");
  for (const videoLanguage of VIDEO_LANGUAGES) {
    const { args } = buildClipperInvocation(job({ ...V3, videoLanguage }), "/in", "/o/output", { WHISPER_LANGUAGE: "jv" });
    assert.equal(languageArg(args), videoLanguage);
    assert.equal(args.filter((value) => value === "--language").length, 1);
  }
  assert.throws(() => buildClipperInvocation(job({ ...V3, videoLanguage: "--model" }), "/in", "/o/output", {}));
});

test("captions are asked for in the job's language; a detected language asks only for the original track", () => {
  assert.deepEqual(captionLanguages(undefined), CAPTION_LANGUAGES);
  assert.deepEqual(captionLanguages("id"), { manual: "id,id-ID,in", auto: "id,id-orig" });
  assert.deepEqual(captionLanguages("en"), { manual: "en,en-US,en-GB", auto: "en,en-orig" });
  assert.deepEqual(captionLanguages("auto"), { manual: null, auto: ".*-orig" });
  for (const value of ["fr", null, "", "AUTO"]) assert.throws(() => captionLanguages(value), /video language/i, String(value));

  const subLangs = (downloads) => downloads.map((download) => [download.kind, download.args[download.args.indexOf("--sub-langs") + 1]]);
  assert.deepEqual(subLangs(buildCaptionDownloads("https://youtu.be/abc", "/j/input")), [["manual", "id,id-ID,in"], ["auto", "id,id-orig"]]);
  assert.deepEqual(subLangs(buildCaptionDownloads("https://youtu.be/abc", "/j/input", "id")), [["manual", "id,id-ID,in"], ["auto", "id,id-orig"]]);
  assert.deepEqual(subLangs(buildCaptionDownloads("https://youtu.be/abc", "/j/input", "en")), [["manual", "en,en-US,en-GB"], ["auto", "en,en-orig"]]);
  const [auto, ...rest] = buildCaptionDownloads("https://youtu.be/abc", "/j/input", "auto");
  assert.deepEqual(rest, []);
  assert.deepEqual(auto.args, [
    "--no-playlist", "--js-runtimes", "node", "--skip-download", "--ignore-errors",
    "--write-auto-subs", "--no-write-subs", "--sub-langs", ".*-orig", "--sub-format", "json3",
    "--output", "/j/input/captions/auto/source.%(ext)s", "https://youtu.be/abc",
  ]);
});

test("a detected-language job makes one caption run and finds the original track", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clipper-language-captions-"));
  const calls = [];
  const run = async (command, args) => {
    calls.push(args);
    await writeFile(args[args.indexOf("--output") + 1].replace("%(ext)s", "en-orig.json3"), '{"events":[]}');
  };
  const captionsDir = await fetchYouTubeCaptions({ url: "https://youtu.be/abc", inputRoot: root, run, timeoutMs: 5_000, videoLanguage: "auto", log: () => {} });
  assert.equal(captionsDir, path.join(root, "captions"));
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("--write-auto-subs"));
});
