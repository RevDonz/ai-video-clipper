import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { POST, streamPrimaryMultipart } from "../app/api/jobs/route.js";
import { createSessionToken } from "../lib/auth.mjs";
import { jobFormProblems, jobStageText, subtitleFileProblem } from "../lib/dashboard-view.mjs";
import { claimNextJob } from "../lib/primary-job-queue.mjs";
import { selectionNotices, selectionWarningLabel } from "../lib/selection-v3-view.mjs";
import { MAX_SUBTITLE_BYTES, SubtitleUploadError, validateSrt } from "../lib/srt.mjs";
import { stageSummaryRows } from "../lib/stage-summary.mjs";
import { buildClipperInvocation, main } from "../scripts/run-job.mjs";

const FIXTURES = fileURLToPath(new URL("../../tests/fixtures/srt/", import.meta.url));
const V3 = { renderMode: "fit-blur", limit: 3, minDuration: 20, maxDuration: 60, selectionMode: "v3", llmMode: "auto", coldOpen: true, hookOverlay: true, captionStyle: "karaoke" };
const FORM_V3 = { renderMode: "fit-blur", limit: "3", minDuration: "20", maxDuration: "60", selectionMode: "v3", llmMode: "auto", coldOpen: "true", hookOverlay: "true", captionStyle: "karaoke" };
const VALID = "1\n00:00:01,000 --> 00:00:03,000\nHalo semua.\n\n2\n00:00:04,000 --> 00:00:06,000\nSelamat datang.\n";

// --- validation (the same files and expectations as tests/test_srt_captions.py) ----------------

test("the shared .srt fixtures pass or fail the upload check as the engine reads them", async () => {
  const cases = JSON.parse(await readFile(path.join(FIXTURES, "cases.json"), "utf8"));
  for (const [name, expected] of Object.entries(cases)) {
    const bytes = await readFile(path.join(FIXTURES, name));
    if (expected.ok) {
      assert.equal(validateSrt(bytes).cues, expected.cues, name);
    } else {
      assert.throws(() => validateSrt(bytes), (error) => error instanceof SubtitleUploadError && error.code === expected.code, name);
    }
  }
});

test("every refusal is short Indonesian text that never repeats the file's text", () => {
  const refusals = [
    [Buffer.alloc(MAX_SUBTITLE_BYTES + 1, 0x61), "size", /maksimal 2 MB/],
    [Buffer.from([0x31, 0x0a, 0xe9, 0x0a]), "encoding", /UTF-8/],
    [Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nA\0B\n"), "encoding", /UTF-8/],
    [Buffer.from("teks-rahasia saja\n"), "structure", /ke-1/],
    [Buffer.from(`${VALID}\n3\n00:00:09,000 --> 00:00:08,000\nMundur.\n`), "timing", /ke-3/],
    [Buffer.from(`1\n00:00:01,000 --> 00:00:02,000\n${"kata ".repeat(2001)}\n`), "too_long", /ke-1/],
    [Buffer.from("\n\n"), "empty", /tidak berisi/],
  ];
  for (const [bytes, code, message] of refusals) {
    assert.throws(() => validateSrt(bytes), (error) => {
      assert.equal(error.code, code);
      assert.match(error.message, message);
      assert.ok(error.message.length <= 80, error.message);
      assert.doesNotMatch(error.message, /rahasia|kata kata/);
      return true;
    });
  }
  // 24 hours is the longest time a cue may end at.
  assert.throws(() => validateSrt(Buffer.from("1\n0:00:01,5 --> 100:00:00,25\nPanjang.\n")), { code: "timing" });
  assert.equal(validateSrt(Buffer.from("1\n0:00:01,5 --> 1:00:00,25\nPanjang.\n")).cues, 1);
});

test("the dashboard checks the picked file's name and size before sending it", () => {
  assert.equal(subtitleFileProblem(null), null);
  assert.equal(subtitleFileProblem({ name: "episode.srt", size: 1200 }), null);
  assert.equal(subtitleFileProblem({ name: "EPISODE.SRT", size: 1200 }), null);
  assert.match(subtitleFileProblem({ name: "episode.vtt", size: 1200 }), /\.srt/);
  assert.match(subtitleFileProblem({ name: "episode.srt", size: MAX_SUBTITLE_BYTES + 1 }), /2 MB/);
  assert.match(subtitleFileProblem({ name: "episode.srt", size: 0 }), /kosong/);
});

test("the form flags a wrong subtitle on the upload source only and sends it with the video", async () => {
  const valid = { sourceType: "upload", video: { name: "a.mp4" }, limit: "3", minDuration: "20", maxDuration: "60" };
  assert.deepEqual(jobFormProblems({ ...valid, subtitle: { name: "a.srt", size: 10 } }), {});
  assert.deepEqual(jobFormProblems({ ...valid, subtitle: { name: "a.txt", size: 10 } }), { subtitle: "Subtitle harus file .srt." });
  assert.deepEqual(jobFormProblems({ ...valid, sourceType: "youtube", youtubeUrl: "https://youtu.be/rBg0ZcwjVKQ", subtitle: { name: "a.txt", size: 10 } }), {});
  const source = await readFile(new URL("../app/dashboard/page.jsx", import.meta.url), "utf8");
  const submit = /async function submit\(event\) \{([\s\S]*?)\n  \}\n/.exec(source)[1];
  assert.match(submit, /else \{\n\s*data\.set\("video", video\);\n\s*if \(subtitle\) data\.set\("subtitle", subtitle\);/);
  assert.match(source, /id="subtitle-file"[\s\S]{0,200}accept="\.srt/);
});

// --- multipart and the job API ---------------------------------------------------------------

function multipart(boundary, parts) {
  const chunks = parts.flatMap(({ name, filename, body }) => [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"${filename ? `; filename="${filename}"` : ""}\r\n${filename ? "Content-Type: application/octet-stream\r\n" : ""}\r\n`),
    Buffer.isBuffer(body) ? body : Buffer.from(body),
    Buffer.from("\r\n"),
  ]);
  return Buffer.concat([...chunks, Buffer.from(`--${boundary}--\r\n`)]);
}

function streamed(body, boundary) {
  return {
    headers: new Headers({ "content-type": `multipart/form-data; boundary=${boundary}` }),
    body: new ReadableStream({ start(controller) { controller.enqueue(body); controller.close(); } }),
  };
}

test("a video and its .srt arrive in either order; the subtitle is stored next to the video", async () => {
  for (const order of [["video", "subtitle"], ["subtitle", "video"]]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "subtitle-stream-"));
    const parts = { video: { name: "video", filename: "clip.mp4", body: "video-bytes" }, subtitle: { name: "subtitle", filename: "clip.srt", body: VALID } };
    const parsed = await streamPrimaryMultipart(streamed(multipart("b", order.map((key) => parts[key])), "b"), root, 1000, 8192);
    assert.equal(parsed.upload.name, "clip.mp4");
    assert.deepEqual(parsed.subtitle, { name: "clip.srt", size: Buffer.byteLength(VALID), cues: 2, path: path.join(root, "subtitle.srt") });
    assert.equal(await readFile(parsed.subtitle.path, "utf8"), VALID);
    assert.equal((await stat(parsed.subtitle.path)).mode & 0o777, 0o600);
    await rm(root, { recursive: true, force: true });
  }
});

test("other files, a second subtitle and an invalid .srt are refused with the reason", async () => {
  const cases = [
    [[{ name: "subtitle", filename: "clip.vtt", body: VALID }], /harus file \.srt/],
    [[{ name: "subtitle", filename: "a.srt", body: VALID }, { name: "subtitle", filename: "b.srt", body: VALID }], /satu file \.srt/],
    [[{ name: "subtitle", filename: "clip.srt", body: "bukan subtitle\n" }], /tidak terbaca/],
    [[{ name: "subtitle", filename: "clip.srt", body: Buffer.alloc(MAX_SUBTITLE_BYTES + 10, 0x61) }], /maksimal 2 MB/],
  ];
  for (const [parts, message] of cases) {
    const root = await mkdtemp(path.join(os.tmpdir(), "subtitle-refuse-"));
    const body = multipart("b", [{ name: "video", filename: "clip.mp4", body: "video" }, ...parts]);
    await assert.rejects(streamPrimaryMultipart(streamed(body, "b"), root, 4 * 1024 * 1024, 8 * 1024 * 1024), (error) => {
      assert.ok(error instanceof SubtitleUploadError, String(error));
      assert.match(error.message, message);
      return true;
    });
    await rm(root, { recursive: true, force: true });
  }
});

async function withJobApi(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "subtitle-post-"));
  const auth = { APP_USERNAME: "admin", APP_PASSWORD: "secret-value", APP_SESSION_SECRET: "a-long-random-session-secret-value" };
  const env = {
    ...auth, JOBS_ROOT: root, PRIMARY_MAX_ACTIVE_JOBS: "8", PRIMARY_WORKER_CONCURRENCY: "1",
    PRIMARY_MAX_ATTEMPTS: "3", PRIMARY_LEASE_MS: "60000", MAX_UPLOAD_BYTES: "100000",
    JOBS_STORAGE_QUOTA_BYTES: "100000000", JOBS_STORAGE_MIN_FREE_BYTES: "0",
    JOBS_STORAGE_ACTIVE_RESERVE_BYTES: "1000", JOBS_STORAGE_SCAN_MAX_ENTRIES: "1000", JOBS_STORAGE_SCAN_MAX_DEPTH: "10",
    POTONGIN_SETTINGS_DIR: path.join(root, ".settings"),
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const token = createSessionToken(auth, 2_000_000_000);
  const post = async (parts) => {
    const body = multipart("subtitle-post", [...Object.entries(FORM_V3).map(([name, value]) => ({ name, body: value })), ...parts]);
    const response = await POST(new Request("http://clips.example/api/jobs", {
      method: "POST",
      headers: {
        Cookie: `potongin_session=${token}`, Origin: "http://clips.example", Host: "clips.example",
        "Sec-Fetch-Site": "same-origin", "Content-Length": String(body.length),
        "Content-Type": "multipart/form-data; boundary=subtitle-post",
      },
      body,
    }));
    return { status: response.status, payload: await response.json() };
  };
  try {
    await run({ root, post });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

test("POST /api/jobs keeps an uploaded video's .srt and names it on the job", async () => {
  await withJobApi(async ({ root, post }) => {
    const { status, payload } = await post([
      { name: "video", filename: "episode.mp4", body: "video-bytes" },
      { name: "subtitle", filename: "episode.srt", body: VALID },
    ]);
    assert.equal(status, 202, JSON.stringify(payload));
    const stored = JSON.parse(await readFile(path.join(root, payload.job.id, "job.json"), "utf8"));
    const subtitle = { name: "episode.srt", size: Buffer.byteLength(VALID), cues: 2 };
    assert.deepEqual(stored.subtitle, subtitle);
    assert.deepEqual(payload.job.subtitle, subtitle);
    assert.equal(await readFile(path.join(root, payload.job.id, "input", "subtitle.srt"), "utf8"), VALID);
    assert.doesNotMatch(JSON.stringify(payload), /input\/subtitle\.srt/);

    const plain = await post([{ name: "video", filename: "episode.mp4", body: "video-bytes" }]);
    assert.equal(plain.status, 202);
    assert.equal("subtitle" in plain.payload.job, false);
  });
});

test("POST /api/jobs refuses a bad .srt or one sent with a YouTube link, in Indonesian", async () => {
  await withJobApi(async ({ post }) => {
    const bad = await post([
      { name: "video", filename: "episode.mp4", body: "video-bytes" },
      { name: "subtitle", filename: "episode.srt", body: "1\n00:00:05,000 --> 00:00:04,000\nMundur.\n" },
    ]);
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.payload, { error: "Waktu subtitle ke-1 tidak valid.", code: "subtitle_invalid" });

    const youtube = await post([
      { name: "youtubeUrl", body: "https://youtu.be/rBg0ZcwjVKQ" },
      { name: "subtitle", filename: "episode.srt", body: VALID },
    ]);
    assert.equal(youtube.status, 400);
    assert.deepEqual(youtube.payload, { error: "Subtitle .srt hanya untuk video yang diunggah.", code: "subtitle_invalid" });
  });
});

// --- worker ----------------------------------------------------------------------------------

test("--subtitle-file is passed only for V3 and only with an absolute path", () => {
  const args = buildClipperInvocation({ options: V3 }, "/in", "/j/output", {}, { subtitleFile: "/j/input/subtitle.srt", captionsDir: "/j/input/captions" }).args;
  assert.deepEqual(args.slice(args.indexOf("--subtitle-file"), args.indexOf("--subtitle-file") + 2), ["--subtitle-file", "/j/input/subtitle.srt"]);
  for (const subtitleFile of [null, undefined, "", "input/subtitle.srt", 42]) {
    assert.ok(!buildClipperInvocation({ options: V3 }, "/in", "/j/output", {}, { subtitleFile }).args.includes("--subtitle-file"));
  }
  const old = buildClipperInvocation({ options: { renderMode: "fit-blur", limit: 3, minDuration: 20, maxDuration: 60 } }, "/in", "/j/output", {}, { subtitleFile: "/j/input/subtitle.srt" }).args;
  assert.ok(!old.includes("--subtitle-file"));
});

const ENGINE = `#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const output = arg("--output-dir");
await mkdir(output, { recursive: true });
await writeFile(path.join(output, "argv.json"), JSON.stringify(process.argv.slice(2)));
await writeFile(path.join(output, "clip-01.mp4"), "mp4");
await writeFile(path.join(output, "manifest.json"), JSON.stringify({ status: "completed", clips: [{
  index: 1, start: 10, end: 40, duration: 30, score: 0.8, text: "Halo", output: path.join(output, "clip-01.mp4"), subtitles: path.join(output, "clip-01.srt"),
}] }));
`;

test("an uploaded video's .srt reaches the engine and the stage line says so", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "subtitle-worker-"));
  const id = "923e4567-e89b-42d3-a456-426614174099";
  const jobRoot = path.join(root, id);
  await mkdir(path.join(jobRoot, "input"), { recursive: true });
  await writeFile(path.join(jobRoot, "input", "source.mp4"), "video");
  await writeFile(path.join(jobRoot, "input", "subtitle.srt"), VALID);
  await writeFile(path.join(jobRoot, "job.json"), JSON.stringify({
    id, status: "queued", progress: 0, createdAt: "2026-10-21T00:00:00.000Z", updatedAt: "2026-10-21T00:00:00.000Z",
    source: { type: "upload", name: "episode.mp4", size: 5 }, sourcePath: path.join(jobRoot, "input", "source.mp4"),
    subtitle: { name: "episode.srt", size: Buffer.byteLength(VALID), cues: 2 }, options: V3, clips: [],
  }));
  const bin = await mkdtemp(path.join(os.tmpdir(), "subtitle-worker-bin-"));
  await writeFile(path.join(bin, "engine.mjs"), ENGINE);
  await chmod(path.join(bin, "engine.mjs"), 0o755);
  const env = { ...process.env, JOBS_ROOT: root, PRIMARY_LEASE_MS: "60000", AI_CLIPPER_BIN: path.join(bin, "engine.mjs"), POTONGIN_SETTINGS_DIR: path.join(bin, "settings") };
  const updates = [];
  try {
    const claim = await claimNextJob({ jobsRoot: root, workerId: "worker", leaseMs: 60_000, maxAttempts: 3, legacyQuiescenceMs: 0 });
    const watcher = setInterval(async () => {
      try { updates.push(JSON.parse(await readFile(path.join(jobRoot, "job.json"), "utf8")).stageDetail); } catch { /* mid-write */ }
    }, 1);
    try { await main(["node", "run-job.mjs", id, claim.token], env); } finally { clearInterval(watcher); }
    const persisted = JSON.parse(await readFile(path.join(jobRoot, "job.json"), "utf8"));
    assert.equal(persisted.status, "completed", persisted.error);
    const argv = JSON.parse(await readFile(path.join(jobRoot, "output", "argv.json"), "utf8"));
    assert.equal(argv[argv.indexOf("--subtitle-file") + 1], path.join(jobRoot, "input", "subtitle.srt"));
    assert.ok(updates.includes("Memakai subtitle .srt yang diunggah"), JSON.stringify([...new Set(updates)]));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
  }
});

// --- what the pages show ---------------------------------------------------------------------

test("the pages name the .srt as the transcript source and explain a refused file", () => {
  const job = { status: "processing", stage: "captions", subtitle: { name: "a.srt", size: 10, cues: 2 }, source: { type: "upload" }, options: V3 };
  assert.equal(jobStageText(job), "Membaca subtitle .srt");
  assert.equal(jobStageText({ ...job, subtitle: undefined }), "Mengambil subtitle YouTube");
  const rows = stageSummaryRows({ ...job, stageSummary: { transcript: { words: 1200, source: "srt-upload", language: "id" } } });
  assert.deepEqual(rows.find((row) => row.key === "transcript").text, "1.200 kata · dari subtitle .srt");

  for (const code of ["subtitle_rejected:invalid", "subtitle_rejected:empty", "subtitle_rejected:duration_mismatch"]) {
    assert.match(selectionWarningLabel(code), /\.srt/);
    assert.match(selectionWarningLabel(code), /audio/);
  }
  assert.equal(selectionWarningLabel("subtitle_rejected:other"), null);
  const summary = { mode: "v3", status: "completed", source: "llm", warnings: ["subtitle_rejected:duration_mismatch"] };
  const notices = selectionNotices({ options: V3, selectionV3: summary });
  assert.equal(notices.length, 1);
  assert.equal(notices[0].tone, "warning");
  assert.match(notices[0].text, /lebih panjang dari video/);
});
