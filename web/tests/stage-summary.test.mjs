// What each finished stage of a job found (lib/stage-summary.mjs), as the dashboard and the
// project page list it under the progress bar. Numbers come only from the job file.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { sanitizeStageSummary, stageSummaryRows } from "../lib/stage-summary.mjs";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFile(path.join(WEB, relative), "utf8");

const FULL = Object.freeze({
  video: { duration: 2892.4 },
  transcript: { words: 2304, source: "youtube-captions", language: "id" },
  moments: { count: 5, source: "llm" },
});

test("a running job lists what each finished stage found, numbers in Indonesian format", () => {
  const job = { status: "processing", stageSummary: { video: FULL.video, transcript: FULL.transcript } };
  assert.deepEqual(stageSummaryRows(job), [
    { key: "video", label: "Video", text: "48:12" },
    { key: "transcript", label: "Transkrip", text: "2.304 kata · dari subtitle YouTube" },
  ]);
});

test("a finished job keeps every stage and adds the clips it rendered", () => {
  const clips = [1, 2, 3, 4, 5].map((index) => ({ index }));
  assert.deepEqual(stageSummaryRows({ status: "completed", stageSummary: FULL, clips }), [
    { key: "video", label: "Video", text: "48:12" },
    { key: "transcript", label: "Transkrip", text: "2.304 kata · dari subtitle YouTube" },
    { key: "moments", label: "Momen", text: "5 dipilih AI" },
    { key: "clips", label: "Klip", text: "5 siap" },
  ]);
});

test("the transcript names Whisper as the audio and moments without AI say only the count", () => {
  const job = {
    status: "processing",
    stageSummary: { transcript: { words: 12345, source: "whisper" }, moments: { count: 3, source: "heuristic" } },
  };
  assert.deepEqual(stageSummaryRows(job).map((row) => row.text), ["12.345 kata · dari audio", "3 dipilih"]);
  assert.deepEqual(stageSummaryRows({ stageSummary: { transcript: { words: 999 } } })[0].text, "999 kata");
  assert.deepEqual(stageSummaryRows({ stageSummary: { transcript: { source: "whisper" } } })[0].text, "dari audio");
  assert.deepEqual(stageSummaryRows({ stageSummary: { moments: { count: 1 } } })[0].text, "1 dipilih");
});

test("a transcript from Groq says it came from the audio through Groq", () => {
  const job = { stageSummary: { transcript: { words: 2304, source: "groq", language: "id" } } };
  assert.equal(stageSummaryRows(job)[0].text, "2.304 kata · dari audio lewat Groq");
  assert.equal(sanitizeStageSummary(job.stageSummary).transcript.source, "groq");
});

test("the detected language is shown only when the owner asked for detection", () => {
  const detected = (language) => ({
    options: { videoLanguage: "auto" },
    stageSummary: { transcript: { words: 2304, source: "whisper", language } },
  });
  assert.equal(stageSummaryRows(detected("en"))[0].text, "2.304 kata · dari audio · bahasa Inggris");
  assert.equal(stageSummaryRows(detected("id"))[0].text, "2.304 kata · dari audio · bahasa Indonesia");
  assert.equal(stageSummaryRows(detected("zz"))[0].text, "2.304 kata · dari audio", "a code without a name is left out");
  for (const options of [{ videoLanguage: "id" }, { videoLanguage: "en" }, {}, undefined]) {
    assert.equal(stageSummaryRows({ ...detected("en"), options })[0].text, "2.304 kata · dari audio", JSON.stringify(options));
  }
});

test("a long video keeps its hours", () => {
  assert.equal(stageSummaryRows({ stageSummary: { video: { duration: 3723.9 } } })[0].text, "1:02:03");
});

test("jobs without summaries show nothing, a finished old job only its clips", () => {
  for (const job of [null, undefined, {}, { status: "processing" }, { status: "queued", stageSummary: null }]) {
    assert.deepEqual(stageSummaryRows(job), [], JSON.stringify(job));
  }
  assert.deepEqual(stageSummaryRows({ status: "completed", clips: [{ index: 1 }, { index: 2 }] }), [
    { key: "clips", label: "Klip", text: "2 siap" },
  ]);
  for (const job of [
    { status: "completed", clips: [] },
    { status: "failed", clips: [{ index: 1 }] },
    { status: "processing", clips: [{ index: 1 }] },
  ]) {
    assert.deepEqual(stageSummaryRows(job), [], JSON.stringify(job));
  }
});

test("values that are not real counts never reach the screen", () => {
  const junk = {
    video: { duration: -1 },
    transcript: { words: "2304", source: "subtitle", language: "Indonesia" },
    moments: { count: 1.5, source: "llm" },
    clips: { count: 9 },
  };
  assert.deepEqual(stageSummaryRows({ status: "processing", stageSummary: junk }), []);
  assert.deepEqual(stageSummaryRows({ stageSummary: { video: { duration: Number.POSITIVE_INFINITY } } }), []);
  assert.deepEqual(stageSummaryRows({ stageSummary: [FULL] }), []);
});

test("the sanitizer keeps known kinds and fields, and only real values", () => {
  assert.deepEqual(sanitizeStageSummary(FULL), FULL);
  assert.deepEqual(sanitizeStageSummary({
    video: { duration: 12.5, extra: "x" },
    transcript: { words: 0, source: "whisper", language: "EN", path: "/data/jobs/x" },
    moments: { count: 2, source: "gpt" },
    secrets: { key: "abc" },
  }), {
    video: { duration: 12.5 },
    transcript: { words: 0, source: "whisper" },
    moments: { count: 2 },
  });
  for (const raw of [null, undefined, "x", 3, [], [FULL], {}, { video: null }, { moments: { source: "llm" } }, { transcript: { language: "id" } }]) {
    assert.equal(sanitizeStageSummary(raw), null, JSON.stringify(raw));
  }
  for (const words of [-1, 1.5, 10_000_001, Number.NaN, true, "12"]) {
    assert.equal(sanitizeStageSummary({ transcript: { words } }), null, String(words));
  }
  for (const count of [-1, 0.5, 1001, false]) {
    assert.equal(sanitizeStageSummary({ moments: { count } }), null, String(count));
  }
  for (const duration of [0, -2, 604_801, Number.NaN, "60"]) {
    assert.equal(sanitizeStageSummary({ video: { duration } }), null, String(duration));
  }
});

test("both pages list the summaries under the progress bar", async () => {
  const dashboard = await read("app/dashboard/page.jsx");
  const project = await read("app/projects/[id]/page.jsx");
  // Dashboard: every job, running or finished, right under its bar and live line.
  assert.match(dashboard, /role="progressbar"[\s\S]*?<StageSummary job=\{activeJob\}/);
  // Project page: inside the progress panel, which shows only while the job runs.
  assert.match(project, /<section className=\{styles\.progressPanel\}[\s\S]*?<StageSummary job=\{job\}[\s\S]*?<\/section>/);
  const component = await read("components/StageSummary.jsx");
  assert.match(component, /stageSummaryRows\(job\)/);
  assert.match(component, /<dl\b/);
  assert.doesNotMatch(component, /—/);
});
