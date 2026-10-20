// The worker's YouTube download: progress-read watchdog, stderr tail and the codes it stores
// on the job (scripts/run-job.mjs). The downloaders here are small fake node scripts.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { DownloadError } from "../lib/download-errors.mjs";
import { PROGRESS_TEMPLATE, createDownloadMonitor } from "../lib/download-monitor.mjs";
import { claimNextJob } from "../lib/primary-job-queue.mjs";
import { COOKIES_FILE_HEADER } from "../lib/youtube-cookies-file.mjs";
import { saveYoutubeCookies } from "../lib/youtube-cookies.mjs";
import { buildCaptionDownloads, buildVideoDownload, main, runFencedProcess } from "../scripts/run-job.mjs";

test("the video download reads progress line by line and keeps its format and output", () => {
  assert.deepEqual(buildVideoDownload("https://youtu.be/abc", "/j/input"), [
    "--no-playlist", "--js-runtimes", "node", "--newline", "--progress-template", PROGRESS_TEMPLATE,
    "--format", "bv*[height<=720]+ba/b[height<=720]",
    "--merge-output-format", "mp4", "--output", "/j/input/source.%(ext)s", "https://youtu.be/abc",
  ]);
});

test("a cookies copy goes to the video and caption downloads as --cookies, before the link", () => {
  const cookiesFile = "/tmp/potongin-yt-cookies-1-abcdef/cookies.txt";
  const video = buildVideoDownload("https://youtu.be/abc", "/j/input", { cookiesFile });
  assert.deepEqual(video.slice(-3), ["--cookies", cookiesFile, "https://youtu.be/abc"]);
  for (const download of buildCaptionDownloads("https://youtu.be/abc", "/j/input", "id", { cookiesFile })) {
    assert.deepEqual(download.args.slice(-3), ["--cookies", cookiesFile, "https://youtu.be/abc"], download.kind);
  }
  // Only an absolute path the worker wrote; anything else adds no flag.
  for (const value of [null, undefined, "", "cookies.txt", 42]) {
    assert.ok(!buildVideoDownload("https://youtu.be/abc", "/j/input", { cookiesFile: value }).includes("--cookies"), String(value));
    assert.ok(buildCaptionDownloads("https://youtu.be/abc", "/j/input", "id", { cookiesFile: value }).every((download) => !download.args.includes("--cookies")));
  }
});

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

test("a silent download is stopped through its process group with the stall code", async () => {
  const child = fakeChild(61234);
  const kills = [];
  const promise = runFencedProcess({
    command: "yt-dlp", args: [], env: {}, heartbeatMs: 60_000, progress: false,
    monitor: createDownloadMonitor({ stallMs: 120, log: () => {} }),
    spawnImpl: () => child,
    update: async () => ({}),
    killImpl: (pid, signal) => { kills.push([pid, signal]); queueMicrotask(() => child.emit("close", null, signal)); },
  });
  child.stdout.write("[download-progress] downloading 1024/5000\n");
  const error = await promise.then(() => null, (rejection) => rejection);
  assert.ok(error instanceof DownloadError, String(error));
  assert.equal(error.code, "download_stalled");
  assert.deepEqual(kills[0], [-61234, "SIGTERM"]);
});

test("a failed download passes stderr through and rejects with the classified code", async () => {
  const child = fakeChild(61235);
  const written = [];
  const original = process.stderr.write;
  process.stderr.write = function capture(chunk, ...rest) {
    written.push(String(chunk));
    return original.call(this, chunk, ...rest);
  };
  let error;
  try {
    const promise = runFencedProcess({
      command: "yt-dlp", args: [], env: {}, heartbeatMs: 60_000, progress: false,
      monitor: createDownloadMonitor({ stallMs: 60_000, log: () => {} }),
      spawnImpl: () => child,
      update: async () => ({}),
      killImpl: () => {},
    });
    child.stderr.write("ERROR: [youtube] AbCdEfGhIjK: Sign in to confirm your age. This video may be inappropriate for some users.\n");
    child.stdout.end();
    child.stderr.end();
    await new Promise((resolve) => setImmediate(resolve));
    child.emit("close", 1, null);
    error = await promise.then(() => null, (rejection) => rejection);
  } finally {
    process.stderr.write = original;
  }
  assert.ok(error instanceof DownloadError, String(error));
  assert.equal(error.code, "download_age_restricted");
  assert.match(written.join(""), /ERROR: \[youtube\] AbCdEfGhIjK: Sign in to confirm your age/);
});

test("a plain run without a monitor still inherits stdio and reports the exit", async () => {
  const child = fakeChild(61236);
  let options;
  const promise = runFencedProcess({
    command: "yt-dlp", args: [], env: {}, heartbeatMs: 60_000, progress: false,
    spawnImpl: (command, args, spawnOptions) => { options = spawnOptions; return child; },
    update: async () => ({}),
    killImpl: () => {},
  });
  child.emit("close", 1, null);
  await assert.rejects(promise, { message: "yt-dlp gagal (exit 1)" });
  assert.equal(options.stdio, "inherit");
});

// --- End to end through main() --------------------------------------------------------------

const FAKE_ENGINE = `#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const output = arg("--output-dir");
await mkdir(output, { recursive: true });
await writeFile(path.join(output, "manifest.json"), JSON.stringify({
  status: "completed",
  clips: [{ index: 1, score: 9, start: 0, end: 30, duration: 30, text: "Klip uji", output: path.join(output, "clip-01.mp4"), subtitles: path.join(output, "clip-01.srt") }],
}));
`;

// FAKE_YT_DLP_MODE: "hang" prints the same progress forever, "merge" merges quietly for
// FAKE_MERGE_MS, "private" fails like a private video; anything else downloads at once.
// FAKE_YT_DLP_RECORD: a file that gets one JSON line per run: the --cookies path, the copy's and
// its folder's modes and text, and whether a sealing secret reached the process.
const FAKE_YT_DLP = `#!/usr/bin/env node
import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
const argv = process.argv.slice(2);
const template = argv[argv.indexOf("--output") + 1];
if (process.env.FAKE_YT_DLP_RECORD) {
  const at = argv.indexOf("--cookies");
  const cookies = at >= 0 ? argv[at + 1] : null;
  const entry = { cookies, secretSeen: Boolean(process.env.APP_SESSION_SECRET || process.env.POTONGIN_SETTINGS_SECRET) };
  if (cookies) {
    entry.mode = (await stat(cookies)).mode & 0o777;
    entry.dirMode = (await stat(path.dirname(cookies))).mode & 0o777;
    entry.text = await readFile(cookies, "utf8");
  }
  await appendFile(process.env.FAKE_YT_DLP_RECORD, JSON.stringify(entry) + "\\n");
}
const video = () => writeFile(template.replace("%(ext)s", "mp4"), Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(20)]));
const mode = process.env.FAKE_YT_DLP_MODE;
if (process.env.FAKE_YT_DLP_PID) await writeFile(process.env.FAKE_YT_DLP_PID, String(process.pid));
console.log("[youtube] AbCdEfGhIjK: Downloading webpage");
if (mode === "hang") {
  console.log("[download-progress] downloading 1024/5000");
  setInterval(() => console.log("[download-progress] downloading 1024/5000"), 40);
} else if (mode === "merge") {
  console.log("[download-progress] downloading 2500/5000");
  console.log("[download-progress] finished 5000/5000");
  console.log('[Merger] Merging formats into "' + template.replace("%(ext)s", "mp4") + '"');
  setTimeout(async () => { await video(); process.exit(0); }, Number(process.env.FAKE_MERGE_MS));
} else if (mode === "private") {
  console.error("WARNING: [youtube] AbCdEfGhIjK: Sign in to confirm you’re not a bot");
  console.error("ERROR: [youtube] AbCdEfGhIjK: Private video. Sign in if you've been granted access to this video. Use --cookies-from-browser or --cookies for the authentication.");
  process.exit(1);
} else {
  await video();
}
`;

async function youtubeJob(prefix, extraEnv = {}) {
  const id = "c23e4567-e89b-42d3-a456-426614174000";
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const jobRoot = path.join(root, id);
  await mkdir(path.join(jobRoot, "input"), { recursive: true });
  await writeFile(path.join(jobRoot, "job.json"), JSON.stringify({
    id, status: "queued", progress: 0,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    source: { type: "youtube", url: "https://youtu.be/AbCdEfGhIjK" }, sourcePath: null,
    options: { renderMode: "fit-blur", limit: 1, minDuration: 20, maxDuration: 60 },
    clips: [],
  }));
  const bin = await mkdtemp(path.join(os.tmpdir(), "clipper-download-bin-"));
  await writeFile(path.join(bin, "engine.mjs"), FAKE_ENGINE);
  await writeFile(path.join(bin, "yt-dlp"), FAKE_YT_DLP);
  await chmod(path.join(bin, "engine.mjs"), 0o755);
  await chmod(path.join(bin, "yt-dlp"), 0o755);
  const env = {
    ...process.env, JOBS_ROOT: root, PRIMARY_LEASE_MS: "60000", AI_CLIPPER_BIN: path.join(bin, "engine.mjs"),
    // A window long enough that a slow process start never looks stalled; stall tests shorten it.
    PATH: `${bin}${path.delimiter}${process.env.PATH}`, POTONGIN_DOWNLOAD_STALL_MS: "60000", ...extraEnv,
  };
  const claim = await claimNextJob({ jobsRoot: root, workerId: "worker", leaseMs: 60_000, maxAttempts: 3, legacyQuiescenceMs: 0 });
  const previousExitCode = process.exitCode;
  try {
    await main(["node", "run-job.mjs", id, claim.token], env);
  } finally {
    process.exitCode = previousExitCode;
  }
  return { bin, job: JSON.parse(await readFile(path.join(jobRoot, "job.json"), "utf8")) };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}

test("a download whose progress stops moving fails as 'Unduhan macet' and its process is gone", async () => {
  const pidFile = path.join(await mkdtemp(path.join(os.tmpdir(), "clipper-download-pid-")), "pid");
  const { job } = await youtubeJob("clipper-download-stall-", { FAKE_YT_DLP_MODE: "hang", FAKE_YT_DLP_PID: pidFile, POTONGIN_DOWNLOAD_STALL_MS: "300" });
  assert.equal(job.status, "failed");
  assert.equal(job.errorCode, "download_stalled");
  assert.equal(job.stageDetail, "Unduhan macet.");
  assert.match(job.error, /tidak bergerak/);
  const pid = Number(await readFile(pidFile, "utf8"));
  for (let wait = 0; wait < 50 && alive(pid); wait += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(alive(pid), false, "the stalled downloader was terminated");
});

test("merging takes longer than the stall window without failing the download", async () => {
  const { job } = await youtubeJob("clipper-download-merge-", { FAKE_YT_DLP_MODE: "merge", FAKE_MERGE_MS: "1600", POTONGIN_DOWNLOAD_STALL_MS: "1000" });
  assert.equal(job.status, "completed", job.error);
  assert.equal(job.errorCode, undefined);
});

test("a private video stores its code, the reason in Indonesian and a short technical line", async () => {
  const { job } = await youtubeJob("clipper-download-private-", { FAKE_YT_DLP_MODE: "private" });
  assert.equal(job.status, "failed");
  assert.equal(job.errorCode, "download_private");
  assert.equal(job.stageDetail, "Video ini privat.");
  assert.equal(job.error, "[youtube] AbCdEfGhIjK: Private video. Sign in if you've been granted access to this video.");
  assert.doesNotMatch(JSON.stringify(job), /cookies/);
});

test("a failure outside the download stores no download code", async () => {
  const { job } = await youtubeJob("clipper-download-engine-", { AI_CLIPPER_BIN: "/nonexistent/ai-clipper" });
  assert.equal(job.status, "failed");
  assert.equal(job.errorCode, null);
  assert.equal(job.stageDetail, "Proses berhenti karena terjadi kesalahan");
});

// --- Cookies YouTube --------------------------------------------------------------------------

const COOKIE_SECRET = "worker-cookies-".padEnd(48, "w");
const LOGIN_COOKIE = [".youtube.com", "TRUE", "/", "TRUE", "4102444800", "LOGIN_INFO", "nilai-login-uji"].join("\t");

async function cookiesSetup({ store = true } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "clipper-download-cookies-"));
  const settings = path.join(base, "settings");
  const record = path.join(base, "record.jsonl");
  const extra = { POTONGIN_SETTINGS_DIR: settings, APP_SESSION_SECRET: COOKIE_SECRET, FAKE_YT_DLP_RECORD: record };
  if (store) await saveYoutubeCookies(Buffer.from(`${COOKIES_FILE_HEADER}\n${LOGIN_COOKIE}\n`), { env: { JOBS_ROOT: path.join(base, "jobs"), ...extra } });
  const runs = async () => (await readFile(record, "utf8")).trim().split("\n").map((entry) => JSON.parse(entry));
  return { base, extra, runs };
}

async function gone(target) {
  await assert.rejects(lstat(target), { code: "ENOENT" }, target);
}

test("stored cookies reach yt-dlp as a private 0600 copy that is gone after the download", async () => {
  const { base, extra, runs } = await cookiesSetup();
  try {
    const { job } = await youtubeJob("clipper-download-cookies-ok-", extra);
    assert.equal(job.status, "completed", job.error);
    const [run] = await runs();
    assert.ok(path.isAbsolute(run.cookies));
    assert.equal(run.mode, 0o600);
    assert.equal(run.dirMode, 0o700);
    assert.equal(run.text, `${COOKIES_FILE_HEADER}\n${LOGIN_COOKIE}\n`);
    assert.equal(run.secretSeen, false, "yt-dlp gets the copy, never the secret that seals it");
    await gone(run.cookies);
    await gone(path.dirname(run.cookies));
    assert.doesNotMatch(JSON.stringify(job), /nilai-login-uji|LOGIN_INFO|potongin-yt-cookies/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("the cookies copy is deleted when the download fails, too", async () => {
  const { base, extra, runs } = await cookiesSetup();
  try {
    const { job } = await youtubeJob("clipper-download-cookies-fail-", { ...extra, FAKE_YT_DLP_MODE: "private" });
    assert.equal(job.status, "failed");
    assert.equal(job.errorCode, "download_private");
    const [run] = await runs();
    assert.ok(run.cookies);
    await gone(path.dirname(run.cookies));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("without stored cookies yt-dlp runs without --cookies", async () => {
  const { base, extra, runs } = await cookiesSetup({ store: false });
  try {
    const { job } = await youtubeJob("clipper-download-cookies-none-", extra);
    assert.equal(job.status, "completed", job.error);
    assert.deepEqual(await runs(), [{ cookies: null, secretSeen: false }]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
