import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { claimNextJob } from "../lib/primary-job-queue.mjs";
import { videoLanguageNotice } from "../lib/source-language.mjs";
import { VIDEO_LANGUAGE_FILE, buildVideoDownload, main, readVideoLanguage } from "../scripts/run-job.mjs";

const V3 = { renderMode: "fit-blur", limit: 3, minDuration: 20, maxDuration: 60, selectionMode: "v3", llmMode: "auto", coldOpen: true, hookOverlay: true, captionStyle: "karaoke" };
const youtube = (sourceLanguage, videoLanguage) => ({
  status: "processing", source: { type: "youtube", url: "https://youtu.be/abc" },
  ...(sourceLanguage === undefined ? {} : { sourceLanguage }),
  options: videoLanguage === undefined ? V3 : { ...V3, videoLanguage },
});

test("the video download writes the language YouTube reports next to the video", () => {
  const args = buildVideoDownload("https://youtu.be/abc", "/j/input");
  const at = args.indexOf("--print-to-file");
  assert.deepEqual(args.slice(at, at + 3), ["--print-to-file", "video:%(language)s", path.join("/j/input", VIDEO_LANGUAGE_FILE)]);
  assert.ok(at < args.indexOf("https://youtu.be/abc"));
  assert.ok(!VIDEO_LANGUAGE_FILE.startsWith("source."), "the worker finds the video by its source. prefix");
});

test("only a plain language code is read back; yt-dlp's NA and anything else are unknown", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-language-"));
  try {
    const cases = [["en\n", "en"], ["en-US\n", "en"], ["pt_BR", "pt"], ["ID\n", "id"], ["NA\n", null], ["", null], ["english please\n", null], ["e\n", null], ["<script>\n", null]];
    for (const [content, expected] of cases) {
      await writeFile(path.join(root, VIDEO_LANGUAGE_FILE), content);
      assert.equal(await readVideoLanguage(root), expected, JSON.stringify(content));
    }
    await writeFile(path.join(root, VIDEO_LANGUAGE_FILE), `en\n${"x".repeat(5000)}`);
    assert.equal(await readVideoLanguage(root), null, "an oversized file is ignored");
    await rm(path.join(root, VIDEO_LANGUAGE_FILE));
    assert.equal(await readVideoLanguage(root), null, "no file: unknown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a known non-Indonesian language on a detected or Indonesian job gets a short note", () => {
  assert.deepEqual(videoLanguageNotice(youtube("en", "auto")), {
    tone: "info", text: "Bahasa video terdeteksi: Inggris. Hasil caption mengikuti bahasa ini.",
  });
  const indonesian = videoLanguageNotice(youtube("en", "id"));
  assert.equal(indonesian.tone, "warning");
  assert.equal(indonesian.text, "Bahasa video terdeteksi: Inggris, tetapi Bahasa video diatur ke Indonesia. Caption bisa meleset; pilih Deteksi otomatis di Buat klip.");
  // A job from before "Bahasa video" was Indonesian.
  assert.deepEqual(videoLanguageNotice(youtube("ja", undefined)).tone, "warning");
  assert.match(videoLanguageNotice(youtube("ja", "auto")).text, /terdeteksi: Jepang\./);
  for (const text of [videoLanguageNotice(youtube("en", "auto")).text, indonesian.text]) assert.ok(text.length <= 140, text);
});

test("no note for Indonesian, an unknown language, an English job, an upload or a stored oddity", () => {
  for (const job of [
    youtube("id", "auto"), youtube("in", "id"), youtube(undefined, "auto"), youtube(null, "id"),
    youtube("en", "en"), youtube("<b>x</b>", "auto"), youtube("NA", "auto"), youtube(42, "id"),
    { ...youtube("en", "auto"), source: { type: "upload", name: "a.mp4" } }, null, {},
  ]) {
    assert.equal(videoLanguageNotice(job), null, JSON.stringify(job));
  }
});

const ENGINE = `#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const output = arg("--output-dir");
await mkdir(output, { recursive: true });
await writeFile(path.join(output, "clip-01.mp4"), "mp4");
await writeFile(path.join(output, "manifest.json"), JSON.stringify({ status: "completed", clips: [{
  index: 1, start: 10, end: 40, duration: 30, score: 0.8, text: "Hello", output: path.join(output, "clip-01.mp4"), subtitles: path.join(output, "clip-01.srt"),
}] }));
`;

// The video run writes the file --print-to-file names, as yt-dlp does; caption runs find none.
const YT_DLP = `#!/usr/bin/env node
import { appendFile, writeFile } from "node:fs/promises";
const argv = process.argv.slice(2);
if (argv.includes("--skip-download")) process.exit(0);
const at = argv.indexOf("--print-to-file");
if (at >= 0) await appendFile(argv[at + 2], process.env.FAKE_LANGUAGE + "\\n");
await writeFile(argv[argv.indexOf("--output") + 1].replace("%(ext)s", "mp4"), "video");
`;

test("the worker stores the reported language on the job while it runs", async () => {
  for (const [reported, expected] of [["en", "en"], ["NA", undefined]]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "video-language-worker-"));
    const bin = await mkdtemp(path.join(os.tmpdir(), "video-language-bin-"));
    const id = "923e4567-e89b-42d3-a456-426614174077";
    const jobRoot = path.join(root, id);
    try {
      await mkdir(path.join(jobRoot, "input"), { recursive: true });
      await writeFile(path.join(jobRoot, "job.json"), JSON.stringify({
        id, status: "queued", progress: 0, createdAt: "2026-10-21T00:00:00.000Z", updatedAt: "2026-10-21T00:00:00.000Z",
        source: { type: "youtube", url: "https://youtu.be/abc" }, sourcePath: null, options: { ...V3, videoLanguage: "auto" }, clips: [],
      }));
      await writeFile(path.join(bin, "engine.mjs"), ENGINE);
      await writeFile(path.join(bin, "yt-dlp"), YT_DLP);
      await chmod(path.join(bin, "engine.mjs"), 0o755);
      await chmod(path.join(bin, "yt-dlp"), 0o755);
      const env = {
        ...process.env, JOBS_ROOT: root, PRIMARY_LEASE_MS: "60000", AI_CLIPPER_BIN: path.join(bin, "engine.mjs"),
        PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_LANGUAGE: reported, POTONGIN_SETTINGS_DIR: path.join(bin, "settings"),
      };
      const claim = await claimNextJob({ jobsRoot: root, workerId: "worker", leaseMs: 60_000, maxAttempts: 3, legacyQuiescenceMs: 0 });
      await main(["node", "run-job.mjs", id, claim.token], env);
      const persisted = JSON.parse(await readFile(path.join(jobRoot, "job.json"), "utf8"));
      assert.equal(persisted.status, "completed", persisted.error);
      assert.equal(persisted.sourceLanguage, expected, reported);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(bin, { recursive: true, force: true });
    }
  }
});

// Buat klip has no job panel any more (05 §2 P4): the note is on the project page, where every
// job lands after Buat klip.
test("the project page shows the note; Buat klip shows no job", async () => {
  const project = await readFile(new URL("../app/projects/[id]/page.jsx", import.meta.url), "utf8");
  assert.match(project, /const languageNotice = videoLanguageNotice\(job\);/);
  assert.match(project, /const notices = \[\.\.\.\(languageNotice \? \[languageNotice\] : \[\]\), \.\.\.selectionNotices\(job, \{ label: \(code\) => warningText\(tAll, code\) \}\)\];/);
  assert.match(project, /notices\.map\(\(notice\) => <Notice key=/);
  const dashboard = await readFile(new URL("../app/dashboard/page.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(dashboard, /videoLanguageNotice|activeJob/);
  assert.match(dashboard, /window\.location\.assign\(next\)/);
});
