// Pengaturan "Tentang sistem": the server reader (web/lib/system-info.mjs), its view rows
// (web/lib/system-info-view.mjs), the route GET /api/settings/system, the commit wiring in
// compose.yaml and the Dockerfile, and the section on the page. A missing or odd source shows
// "tidak diketahui"; nothing here may throw, reach the network or show a path.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { GET as defaultGet, createSystemInfoRoute } from "../app/api/settings/system/route.js";
import { createSessionToken, isAuthorized } from "../lib/auth.mjs";
import { PYTHON_CLI_MODULES, PythonCliError, runPythonCli } from "../lib/python-cli.mjs";
import {
  SYSTEM_INFO_MODULE,
  appCommit,
  createYtDlpReader,
  readSystemInfo,
  toolchainVersions,
  upstreamVersion,
  whisperModel,
} from "../lib/system-info.mjs";
import { UNKNOWN, systemInfoRows } from "../lib/system-info-view.mjs";
import { settingsText } from "./support/settings-text.mjs";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const ROOT = path.resolve(WEB, "..");
const read = (relative) => readFile(path.join(WEB, relative), "utf8");

// The canonical bytes `python -m ai_clipper.edit_v2.toolchain write` produces for the image.
const TOOLCHAIN = `${JSON.stringify({
  apt_snapshot: "20260924T000000Z",
  base_image: `node:20-bookworm-slim@sha256:${"0".repeat(64)}`,
  packages: {
    fontconfig: "2.14.1-4",
    ffmpeg: "7:5.1.9-0+deb12u1",
    libass9: "1:0.17.1-1+deb12u1",
    libfreetype6: "2.12.1+dfsg-5+deb12u4",
    libfribidi0: "1.0.8-2.1",
    libharfbuzz0b: "6.0.0+dfsg-3",
  },
  schema: "potongin.toolchain/1",
}, null, 2)}\n`;

async function resourcesWith(t, content) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "system-info-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  if (content !== undefined) await writeFile(path.join(dir, "toolchain.json"), content);
  return dir;
}

// --- toolchain.json -------------------------------------------------------------------------

test("upstreamVersion drops the Debian epoch and revision", () => {
  assert.equal(upstreamVersion("7:5.1.9-0+deb12u1"), "5.1.9");
  assert.equal(upstreamVersion("1:0.17.1-1+deb12u1"), "0.17.1");
  assert.equal(upstreamVersion("2.14.1-4"), "2.14.1");
  assert.equal(upstreamVersion("5.1.9"), "5.1.9");
  assert.equal(upstreamVersion("1:2.3-rc1-4"), "2.3-rc1");
  for (const odd of ["", "-1", ":", "7:", "../../etc", "<b>1</b>", "1.0 beta", "9".repeat(80), null, undefined, 5, {}]) {
    assert.equal(upstreamVersion(odd), null, String(odd));
  }
});

test("the image's toolchain.json gives FFmpeg and libass", async (t) => {
  const dir = await resourcesWith(t, TOOLCHAIN);
  assert.deepEqual(await toolchainVersions(dir), { ffmpeg: "5.1.9", libass: "0.17.1" });
});

test("a missing, unreadable or odd toolchain.json gives null versions, never an error", async (t) => {
  const none = { ffmpeg: null, libass: null };
  assert.deepEqual(await toolchainVersions(await resourcesWith(t)), none, "no file (local runs)");
  assert.deepEqual(await toolchainVersions(path.join(os.tmpdir(), "potongin-no-such-dir")), none, "no directory");
  assert.deepEqual(await toolchainVersions(undefined), none, "no directory given");
  for (const content of [
    "", "not json", "[]", "null", "{}",
    JSON.stringify({ schema: "potongin.toolchain/2", packages: { ffmpeg: "7:5.1.9-0", libass9: "1:0.17.1-1" } }),
    JSON.stringify({ schema: "potongin.toolchain/1", packages: [] }),
    JSON.stringify({ schema: "potongin.toolchain/1", packages: { ffmpeg: 5, libass9: null } }),
    `${TOOLCHAIN}${" ".repeat(70 * 1024)}`,
  ]) {
    assert.deepEqual(await toolchainVersions(await resourcesWith(t, content)), none, content.slice(0, 40));
  }
  const directory = await resourcesWith(t);
  await mkdir(path.join(directory, "toolchain.json"));
  assert.deepEqual(await toolchainVersions(directory), none, "a directory in the file's place");
  const partial = JSON.parse(TOOLCHAIN);
  partial.packages.libass9 = "not a version!";
  assert.deepEqual(await toolchainVersions(await resourcesWith(t, JSON.stringify(partial))), { ffmpeg: "5.1.9", libass: null });
});

// --- Whisper model and commit ---------------------------------------------------------------

test("the Whisper model is WHISPER_MODEL, small when unset, and a path is only called custom", () => {
  assert.deepEqual(whisperModel({}), { model: "small", custom: false });
  assert.deepEqual(whisperModel({ WHISPER_MODEL: "" }), { model: "small", custom: false });
  assert.deepEqual(whisperModel({ WHISPER_MODEL: "  medium " }), { model: "medium", custom: false });
  assert.deepEqual(whisperModel({ WHISPER_MODEL: "large-v3-turbo" }), { model: "large-v3-turbo", custom: false });
  assert.deepEqual(whisperModel(undefined), { model: "small", custom: false });
  for (const value of ["/home/someone/models/small", "Systran/faster-whisper-small", "C:\\models\\small", "~/m", "../m", "a b", "x".repeat(65)]) {
    assert.deepEqual(whisperModel({ WHISPER_MODEL: value }), { model: null, custom: true }, value);
  }
});

test("the app commit is POTONGIN_APP_COMMIT's first seven hex digits, else null", () => {
  assert.equal(appCommit({ POTONGIN_APP_COMMIT: "0123456789abcdef0123456789abcdef01234567" }), "0123456");
  assert.equal(appCommit({ POTONGIN_APP_COMMIT: "ABCDEF1" }), "abcdef1");
  for (const value of [undefined, "", "latest", "ci-0123456789abcdef", "abc12", "g123456", "0".repeat(41), " 0123456"]) {
    assert.equal(appCommit({ POTONGIN_APP_COMMIT: value }), null, String(value));
  }
  assert.equal(appCommit(undefined), null);
});

// --- yt-dlp through the python-cli helper ---------------------------------------------------

function fakeRun(answers) {
  const calls = [];
  const run = async (module, op, payload, options) => {
    calls.push({ module, op, payload, options });
    const next = answers.length > 1 ? answers.shift() : answers[0];
    if (next instanceof Error) throw next;
    return next;
  };
  return { run, calls };
}

test("the system-info CLI is one of the helper's allowed modules", () => {
  assert.equal(SYSTEM_INFO_MODULE, "ai_clipper.system_info");
  assert.ok(PYTHON_CLI_MODULES.includes(SYSTEM_INFO_MODULE));
});

test("yt-dlp's version is asked once and cached; concurrent readers share one call", async () => {
  const clock = { now: 1_000 };
  const { run, calls } = fakeRun([{ exitCode: 0, json: { yt_dlp: "2026.8.19" } }]);
  const ytDlp = createYtDlpReader({ run, now: () => clock.now });
  assert.deepEqual(await Promise.all([ytDlp(), ytDlp(), ytDlp()]), ["2026.8.19", "2026.8.19", "2026.8.19"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].module, "ai_clipper.system_info");
  assert.equal(calls[0].op, "versions");
  assert.deepEqual(calls[0].payload, {});
  assert.ok(calls[0].options.timeoutMs <= 15_000, "a short timeout");
  assert.ok(calls[0].options.maxStdoutBytes <= 4096, "a small answer");
  clock.now += 9 * 60_000;
  assert.equal(await ytDlp(), "2026.8.19");
  assert.equal(calls.length, 1, "still cached inside the TTL");
  clock.now += 2 * 60_000;
  assert.equal(await ytDlp(), "2026.8.19");
  assert.equal(calls.length, 2, "asked again after the TTL");
});

test("a failed or odd answer is null, cached briefly, then asked again", async () => {
  const clock = { now: 0 };
  const { run, calls } = fakeRun([
    new PythonCliError("spawn_failed"),
    { exitCode: 0, json: { yt_dlp: "2026.9.1" } },
  ]);
  const ytDlp = createYtDlpReader({ run, now: () => clock.now });
  assert.equal(await ytDlp(), null);
  assert.equal(await ytDlp(), null);
  assert.equal(calls.length, 1, "a failure is not retried on every page load");
  clock.now += 61_000;
  assert.equal(await ytDlp(), "2026.9.1");
  assert.equal(calls.length, 2);

  for (const answer of [
    { exitCode: 3, json: { yt_dlp: "2026.8.19" } },
    { exitCode: 0, json: { yt_dlp: null } },
    { exitCode: 0, json: {} },
    { exitCode: 0, json: { yt_dlp: 2026 } },
    { exitCode: 0, json: { yt_dlp: "2026.8.19\n/home/x" } },
    { exitCode: 0, json: { yt_dlp: "1".repeat(41) } },
    null,
    new Error("anything"),
  ]) {
    const odd = createYtDlpReader({ run: fakeRun([answer]).run, now: () => 0 });
    assert.equal(await odd(), null, JSON.stringify(answer));
  }
});

test("the real CLI answers through the helper", { skip: !existsSync(path.join(ROOT, ".venv/bin/python")) && "no .venv here" }, async () => {
  const result = await runPythonCli(SYSTEM_INFO_MODULE, "versions", {}, {
    pythonBin: path.join(ROOT, ".venv/bin/python"), env: { PATH: process.env.PATH }, timeoutMs: 30_000,
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(Object.keys(result.json), ["yt_dlp"]);
  assert.ok(result.json.yt_dlp === null || typeof result.json.yt_dlp === "string");
});

// --- readSystemInfo -------------------------------------------------------------------------

test("readSystemInfo collects every value and never throws", async (t) => {
  const dir = await resourcesWith(t, TOOLCHAIN);
  const full = await readSystemInfo({
    env: { WHISPER_MODEL: "large-v3-turbo", POTONGIN_APP_COMMIT: "becb71226bcbf879f43714b677119d0e47b2f0c7" },
    resources: dir,
    ytDlp: async () => "2026.8.19",
  });
  assert.deepEqual(full, {
    ytDlp: "2026.8.19", ffmpeg: "5.1.9", libass: "0.17.1",
    whisperModel: "large-v3-turbo", whisperModelCustom: false, commit: "becb712",
  });

  const empty = await readSystemInfo({
    env: {},
    resources: path.join(os.tmpdir(), "potongin-no-such-dir"),
    ytDlp: async () => { throw new Error("python missing"); },
  });
  assert.deepEqual(empty, {
    ytDlp: null, ffmpeg: null, libass: null, whisperModel: "small", whisperModelCustom: false, commit: null,
  });
});

// --- The view -------------------------------------------------------------------------------

test("every row shows 'tidak diketahui' for a value nobody could read", () => {
  assert.deepEqual(UNKNOWN, { key: "system.unknown" });
  assert.equal(settingsText(UNKNOWN), "tidak diketahui");
  for (const info of [undefined, null, {}, { ytDlp: null, ffmpeg: null, libass: null, whisperModel: null, commit: null }]) {
    const rows = systemInfoRows(info);
    assert.deepEqual(rows.map((row) => row.id), ["ytDlp", "ffmpeg", "libass", "whisper", "commit"]);
    for (const row of rows) {
      assert.equal(row.value, UNKNOWN, `${row.id} of ${JSON.stringify(info)}`);
      assert.equal(row.known, false);
    }
  }
});

test("the rows carry the values, a custom Whisper model by name only", () => {
  const rows = systemInfoRows({
    ytDlp: "2026.8.19", ffmpeg: "5.1.9", libass: "0.17.1", whisperModel: "small", whisperModelCustom: false, commit: "becb712",
  });
  assert.deepEqual(rows.map((row) => [row.label, row.value, row.known]), [
    ["yt-dlp", "2026.8.19", true],
    ["FFmpeg", "5.1.9", true],
    ["libass", "0.17.1", true],
    ["Whisper", "small", true],
    ["Build", "becb712", true],
  ]);
  for (const code of ["id", "en"]) {
    for (const row of rows) {
      const hint = settingsText(row.hint, code);
      assert.ok(hint.length > 0 && hint.length <= 32, `${code}: ${hint}`);
    }
  }
  assert.equal(settingsText(rows[0].hint), "Pengunduh video");
  const custom = systemInfoRows({ whisperModel: null, whisperModelCustom: true }).find((row) => row.id === "whisper");
  assert.deepEqual([settingsText(custom.value), custom.known], ["Model kustom", true]);
  // A value the server did not vouch for is not shown as is.
  const odd = systemInfoRows({ ytDlp: 42, ffmpeg: "x".repeat(200), commit: ["becb712"] });
  for (const row of odd) assert.equal(row.value, UNKNOWN, row.id);
});

test("the rows carry no version wording, no em dash and no 'kamu'", () => {
  for (const code of ["id", "en"]) {
    const rows = [...systemInfoRows({}), ...systemInfoRows({ whisperModelCustom: true })];
    const text = rows.map((row) => `${row.label} ${settingsText(row.hint, code)} ${settingsText(row.value, code)}`).join("\n");
    assert.doesNotMatch(text, /\bversi\b|\bmesin\b|\bV[1-3]\b|—|\bkamu\b/i);
  }
});

// --- The route ------------------------------------------------------------------------------

const AUTH = Object.freeze({ APP_USERNAME: "admin", APP_PASSWORD: "pw-secret-value", APP_SESSION_SECRET: "session-secret-".padEnd(48, "z") });

function authorize(request) {
  return isAuthorized(request, AUTH) ? null : Response.json({ error: "Sesi login tidak valid" }, { status: 401, headers: { "Cache-Control": "no-store" } });
}

function request({ cookie = true } = {}) {
  const headers = { Host: "local" };
  if (cookie) headers.Cookie = `potongin_session=${createSessionToken(AUTH)}`;
  return new Request("http://local/api/settings/system", { headers });
}

test("GET /api/settings/system needs a session and never runs the reader without one", async () => {
  let reads = 0;
  const route = createSystemInfoRoute({ authorize, read: async () => { reads += 1; return {}; } });
  const denied = await route.GET(request({ cookie: false }));
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get("cache-control"), "no-store");
  assert.equal(reads, 0);
  const fallback = await defaultGet(request({ cookie: false }));
  assert.equal(fallback.status, 401, "the exported GET checks the session itself");
});

test("GET /api/settings/system answers the reader's values, uncached, without a server path", async (t) => {
  const dir = await resourcesWith(t, TOOLCHAIN);
  const route = createSystemInfoRoute({
    authorize,
    read: () => readSystemInfo({ env: { POTONGIN_APP_COMMIT: "becb712" }, resources: dir, ytDlp: async () => "2026.8.19" }),
  });
  const answer = await route.GET(request());
  assert.equal(answer.status, 200);
  assert.equal(answer.headers.get("cache-control"), "no-store");
  const text = await answer.text();
  assert.ok(!text.includes(dir) && !text.includes(os.tmpdir()), "no server path");
  assert.deepEqual(JSON.parse(text), {
    ytDlp: "2026.8.19", ffmpeg: "5.1.9", libass: "0.17.1", whisperModel: "small", whisperModelCustom: false, commit: "becb712",
  });

  const failing = createSystemInfoRoute({ authorize, read: async () => { throw new Error(`/srv/secret/${dir}`); } });
  const failed = await failing.GET(request());
  assert.equal(failed.status, 500);
  assert.equal(failed.headers.get("cache-control"), "no-store");
  const failedText = await failed.text();
  assert.ok(!failedText.includes("/srv/secret"), "the error stays in the server");
  assert.match(JSON.parse(failedText).error, /^Info sistem/);
});

// --- Commit wiring --------------------------------------------------------------------------

test("compose hands the deployed commit to the image build, and the Dockerfile keeps it last", async () => {
  const compose = await readFile(path.join(ROOT, "compose.yaml"), "utf8");
  const app = compose.slice(compose.indexOf("\n  app:\n"), compose.indexOf("\n  primary-worker:\n"));
  assert.match(app, /^ {4}build:\n(?: {6}.*\n)*? {6}args:\n {8}POTONGIN_APP_COMMIT: \$\{IMAGE_TAG:-\}$/m);
  const dockerfile = await readFile(path.join(ROOT, "Dockerfile"), "utf8");
  const arg = dockerfile.indexOf("\nARG POTONGIN_APP_COMMIT=\n");
  const env = dockerfile.indexOf("\nENV POTONGIN_APP_COMMIT=${POTONGIN_APP_COMMIT}\n");
  assert.ok(arg > 0 && env > arg, "ARG then ENV");
  // After the last RUN, so a new commit rebuilds no layer of the image.
  assert.ok(arg > dockerfile.lastIndexOf("\nRUN "), "after the last RUN");
});

// --- The page -------------------------------------------------------------------------------

test("Pengaturan shows Tentang sistem from the route, with loading and error states", async () => {
  // Tab Sistem (05 §6.10): the card is its own component, its words come from the catalog.
  const page = await read("app/settings/page.jsx");
  assert.match(page, /<Tabs\.Panel id="sistem" shouldForceMount[^>]*>\s*<SystemCard \/>/);
  const card = await read("app/settings/SystemCard.jsx");
  assert.match(card, /"\/api\/settings\/system"/);
  assert.match(card, /systemInfoRows\(/);
  assert.match(card, /<h2 id="system-title"[^>]*>\{t\("system\.about"\)\}<\/h2>/);
  assert.match(card, /aria-labelledby="system-title"/);
  assert.match(card, /<dl className="settingsSystemList">/);
  assert.match(card, /system\.phase === "loading" && <CardLoading label=\{t\("common\.loading"\)\}/);
  assert.match(card, /t\("system\.loadFailed"\)/);
  // The retry is the load error's secondary button: lime stays on Simpan.
  assert.match(card, /<CardLoadError message=\{system\.error\} onRetry=\{loadSystem\} \/>/);
  const state = await read("app/settings/CardState.jsx");
  assert.match(state, /<Button variant="secondary" onPress=\{onRetry\}>\{tCommon\("retry"\)\}<\/Button>/);
  const id = JSON.parse(await read("messages/id/settings.json"));
  assert.equal(id.system.about, "Tentang sistem");
  assert.equal(id.system.loadFailed, "Info sistem tidak bisa dimuat.");
  assert.equal(JSON.parse(await read("messages/id/common.json")).retry, "Coba lagi");
});
