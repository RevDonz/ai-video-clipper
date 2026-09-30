// Editor V3 uploads and the job asset store (plan §9.2, §4.2 "POST /assets", "GET /assets/:sha";
// T3.1): web/lib/asset-upload.mjs (the two routes), web/lib/editor/upload-client.mjs (the browser
// helper of Appendix A.2 `uploadAsset`) and the route files. Unit cases use a recording CLI
// runner; the integration cases run the real `python -m ai_clipper.edit_v2.assets` through
// web/lib/python-cli.mjs, with wrappers that record every child's /proc/self/environ (E11).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import * as uploadRouteModule from "../app/api/jobs/[id]/assets/route.js";
import * as fileRouteModule from "../app/api/jobs/[id]/assets/[sha]/route.js";
import { createSessionToken, isAuthorized } from "../lib/auth.mjs";
import {
  ASSET_KINDS,
  ASSET_MESSAGES,
  ASSET_MODULE,
  FORMATS,
  MAX_ASSET_NAME_CHARS,
  UploadRequestError,
  assetDto,
  createAssetFileRoute,
  createAssetUploadRoute,
  decodeAssetNameHeader,
  normaliseAssetName,
  parseUploadRequest,
  sniffAsset,
  uploadsEnabled,
} from "../lib/asset-upload.mjs";
import {
  UPLOAD_RULES,
  UploadError,
  assetUrl,
  canonicalType,
  createUploadClient,
  displayName,
  uploadAsset,
  uploadMessage,
} from "../lib/editor/upload-client.mjs";
import { createFakeUploadClient } from "../components/editor/__dev__/fakes.mjs";
import { CHILD_ENV_ALLOWLIST, PythonCliError } from "../lib/python-cli.mjs";
import { createEditorRateLimits } from "../lib/rate-limit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const AUTH = Object.freeze({ APP_USERNAME: "admin", APP_PASSWORD: "pw-secret-value", APP_SESSION_SECRET: "session-secret-".padEnd(48, "z") });
const JOB_ID = "8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55";
const KEY = "00000000-0000-4000-8000-000000000001";
const SHA = "ab".repeat(32);
const SECRETS = Object.freeze({
  APP_PASSWORD: AUTH.APP_PASSWORD, APP_SESSION_SECRET: AUTH.APP_SESSION_SECRET,
  POTONGIN_SETTINGS_SECRET: "settings-secret-value", OPENROUTER_API_KEY: "sk-or-secret-value",
  POTONGIN_LLM_CUSTOM_API_KEY: "custom-secret-value", GEMINI_API_KEY: "gemini-secret-value",
});
const FFMPEG_ENV = new Set(["PATH", "LANG", "LC_ALL", "HOME", "TMPDIR"]);

function python() {
  const configured = process.env.PYTHON_BIN;
  if (configured) return configured.includes(path.sep) ? path.resolve(configured) : configured;
  return path.join(REPO, ".venv", "bin", "python");
}

function have(tool) {
  return spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).status === 0;
}

function authorize(request) {
  return isAuthorized(request, AUTH) ? null
    : Response.json({ error: "Sesi login tidak valid" }, { status: 401, headers: { "Cache-Control": "no-store" } });
}

function env(extra = {}) {
  return { ...AUTH, PATH: process.env.PATH, JOBS_ROOT: "/data/jobs", POTONGIN_EDITOR_V3: "on", POTONGIN_EDITOR_UPLOADS: "on", ...extra };
}

function upload(body, { kind = "logo", type = "image/png", key = KEY, name, length, origin = "http://local", cookie = true,
  job = JOB_ID, headers = {} } = {}) {
  const all = { Host: "local", "X-Asset-Kind": kind, "Content-Type": type, "Idempotency-Key": key, ...headers };
  if (origin) all.Origin = origin;
  if (cookie) all.Cookie = `potongin_session=${createSessionToken(AUTH)}`;
  if (name !== undefined) all["X-Asset-Name"] = name;
  const bytes = body instanceof Uint8Array ? body : Buffer.from(body ?? "");
  if (length !== null) all["Content-Length"] = String(length ?? bytes.length);
  for (const [header, value] of Object.entries(all)) if (value === undefined) delete all[header];
  return new Request(`http://local/api/jobs/${job}/assets`, { method: "POST", headers: all, body: bytes, duplex: "half" });
}

function get(sha, { part, cookie = true, job = JOB_ID, method = "GET", range } = {}) {
  const headers = { Host: "local" };
  if (cookie) headers.Cookie = `potongin_session=${createSessionToken(AUTH)}`;
  if (range) headers.Range = range;
  const query = part === undefined ? "" : `?part=${part}`;
  return new Request(`http://local/api/jobs/${job}/assets/${sha}${query}`, { method, headers });
}

function context(params) {
  return { params: Promise.resolve(params) };
}

async function read(response) {
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body, text, headers: response.headers };
}

// A 2x2 RGBA PNG (node:zlib only) and a PCM WAV.
function chunk(kind, body) {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(kind, 4, "latin1");
  body.copy(out, 8);
  out.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(kind, "latin1"), body])) >>> 0, 8 + body.length);
  return out;
}
function pngBytes(width = 2, height = 2) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + 4 * width);
    for (let x = 0; x < width; x += 1) row.set([(x * 97) & 255, (y * 57) & 255, 128, 255], 1 + 4 * x);
    rows.push(row);
  }
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr),
    chunk("tEXt", Buffer.from("Comment\0secret-metadata")), chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0))]);
}
function wavBytes({ seconds = 1, rate = 8000, channels = 1 } = {}) {
  const frames = Math.round(seconds * rate);
  const data = Buffer.alloc(frames * channels * 2);
  for (let n = 0; n < frames; n += 1) {
    const value = Math.round(3000 * Math.sin((2 * Math.PI * 440 * n) / rate));
    for (let c = 0; c < channels; c += 1) data.writeInt16LE(value, (n * channels + c) * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// A recording runner: `results` maps op → {exitCode, json} | Error | function(payload).
function recorder(results = {}) {
  const calls = [];
  const runCli = async (module, op, payload, options) => {
    calls.push({ module, op, payload, options });
    const result = results[op];
    if (result instanceof Error) throw result;
    if (typeof result === "function") return result(payload);
    if (!result) throw new Error(`unexpected op ${op}`);
    return result;
  };
  return { calls, runCli };
}

function storage() {
  const reserved = [];
  const released = [];
  return {
    reserved,
    released,
    reserve: async (_root, options) => {
      reserved.push(options);
      return { reservationId: options.reservationId, token: "tok", reservedBytes: String(options.declaredBytes + 1n) };
    },
    release: async (_root, reservationId, token, state) => { released.push({ reservationId, token, state }); return true; },
  };
}

async function jobsRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-upload-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, JOB_ID, "analysis"), { recursive: true });
  return root;
}

function logoAsset(overrides = {}) {
  return { sha256: SHA, kind: "logo", mime: "image/png", w: 2, h: 2, durationMs: null, lufsC: null, name: null, ...overrides };
}

function deps(root, extra = {}) {
  const store = storage();
  return {
    authorize, env: env({ JOBS_ROOT: root }), jobsRoot: root, limits: createEditorRateLimits(),
    reserve: store.reserve, release: store.release, storageConfig: {}, store, ...extra,
  };
}

// --- shared rules (the same vectors as tests/test_edit_v2_assets.py) --------------------------------

test("the transport rules of plan §9.2", () => {
  assert.deepEqual(ASSET_KINDS.logo.types, ["image/png", "image/jpeg", "image/webp"]);
  assert.deepEqual(ASSET_KINDS.music.types, ["audio/mpeg", "audio/mp4", "audio/wav", "audio/ogg", "audio/flac"]);
  assert.equal(ASSET_KINDS.logo.maxBytes, 10 * 1024 * 1024);
  assert.equal(ASSET_KINDS.music.maxBytes, 50 * 1024 * 1024);
  assert.equal(MAX_ASSET_NAME_CHARS, 80);
  assert.equal(ASSET_MODULE, "ai_clipper.edit_v2.assets");
  assert.deepEqual(FORMATS, {
    "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp", "audio/mpeg": "mp3", "audio/mp4": "mp4",
    "audio/wav": "wav", "audio/ogg": "ogg", "audio/flac": "flac",
  });
  assert.deepEqual(UPLOAD_RULES, { logo: ASSET_KINDS.logo, music: ASSET_KINDS.music });
  for (const [code, message] of Object.entries(ASSET_MESSAGES)) assert.ok(message && message === message.trim(), code);
  assert.equal(uploadsEnabled({}), false);
  assert.equal(uploadsEnabled({ POTONGIN_EDITOR_UPLOADS: "off" }), false);
  assert.equal(uploadsEnabled({ POTONGIN_EDITOR_UPLOADS: "on" }), true);
});

const hex = (value) => Buffer.from(value, "hex");
const SNIFF_OK = [
  [Buffer.concat([hex("89504e470d0a1a0a0000000d49484452"), Buffer.alloc(20)]), "png"],
  [hex("ffd8ffe000104a46494600"), "jpeg"],
  [hex("ffd8ffe100104578696600"), "jpeg"],
  [Buffer.concat([Buffer.from("RIFF\x10\x00\x00\x00WEBPVP8 ", "latin1"), Buffer.alloc(8)]), "webp"],
  [Buffer.concat([Buffer.from("RIFF\x10\x00\x00\x00WEBPVP8L", "latin1"), Buffer.alloc(8)]), "webp"],
  [Buffer.concat([Buffer.from("RIFF\x10\x00\x00\x00WEBPVP8X", "latin1"), Buffer.alloc(8)]), "webp"],
  [Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00", "latin1"), "mp3"],
  [hex("fffb906400000000"), "mp3"],
  [hex("fff348c400000000"), "mp3"],
  [hex("ffe318c400000000"), "mp3"],
  [Buffer.from("\x00\x00\x00\x20ftypM4A \x00\x00\x02\x00", "latin1"), "mp4"],
  [Buffer.from("\x00\x00\x00\x1cftypisom\x00\x00\x02\x00", "latin1"), "mp4"],
  [Buffer.from("\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00", "latin1"), "mp4"],
  [Buffer.from("RIFF\x24\x00\x00\x00WAVEfmt ", "latin1"), "wav"],
  [Buffer.concat([Buffer.from("OggS\x00\x02", "latin1"), Buffer.alloc(20)]), "ogg"],
  [Buffer.from("fLaC\x00\x00\x00\x22", "latin1"), "flac"],
];
const SNIFF_NO = [
  "", "GIF89a\x01\x00\x01\x00", "<?xml version='1.0'?><svg xmlns='http://www.w3.org/2000/svg'>",
  "<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'>",
  "\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heic", "\x00\x00\x00\x18ftypmif1\x00\x00\x00\x00mif1heic",
  "\x00\x00\x00\x1cftypavif\x00\x00\x00\x00avifmif1", "%PDF-1.7\n", "PK\x03\x04\x14\x00\x00\x00",
  "OTTO\x00\x0a\x00\x80", "\x00\x01\x00\x00\x00\x0f\x00\x80", "wOFF\x00\x01\x00\x00", "#EXTM3U\n#EXT-X-VERSION:3\n",
  "ffconcat version 1.0\nfile '/etc/passwd'\n", "\x1a\x45\xdf\xa3\x9f\x42\x86\x81\x01",
  "<!DOCTYPE html><html><script>alert(1)</script>", "\xff\xf1\x50\x80\x02\x1f\xfc", "\xff\xfd\x90\x64",
  "\xff\xfb\xf0\x64", "\xff\xfb\x9c\x64", "\xff\xeb\x90\x64", "RIFF\x24\x00\x00\x00AVI LIST", "\xff\xd8\xfe",
].map((text) => Buffer.from(text, "latin1"));

test("the sniff recognises exactly the allowed formats", () => {
  for (const [head, format] of SNIFF_OK) assert.equal(sniffAsset(head), format, head.toString("hex"));
  for (const head of SNIFF_NO) assert.equal(sniffAsset(head), null, head.toString("hex"));
});

const NAME_VECTORS = [
  [null, null], ["", null], ["logo.png", "logo.png"], ["../../../etc/passwd", "passwd"],
  ["C:\\Users\\ria\\lagu.mp3", "lagu.mp3"], ["/", null], ["..", null], [".", null], ["  spasi.png  ", "spasi.png"],
  ["e\u0301.png", "\u00e9.png"], ["lagu 🎵.mp3", "lagu 🎵.mp3"], ["x".repeat(80), "x".repeat(80)],
];
const NAME_INVALID = ["a\u0000b.png", "a\nb.png", "tab\t.png", "\u007f.png", "x".repeat(81), "\ud800.png", 7];

test("display names are normalised exactly like the Python ingest", () => {
  for (const [raw, expected] of NAME_VECTORS) assert.equal(normaliseAssetName(raw), expected, JSON.stringify(raw));
  for (const raw of NAME_INVALID) assert.throws(() => normaliseAssetName(raw), UploadRequestError, JSON.stringify(raw));
  assert.equal(decodeAssetNameHeader(null), null);
  assert.equal(decodeAssetNameHeader(encodeURIComponent("Logo Toko é.png")), "Logo Toko é.png");
  assert.equal(decodeAssetNameHeader(encodeURIComponent("../../etc/passwd")), "passwd");
  for (const bad of ["%E0%A4%A", "%ED%A0%80.png", "%00", "a%0Ab", "%"]) {
    assert.throws(() => decodeAssetNameHeader(bad), UploadRequestError, bad);
  }
});

test("upload headers are parsed strictly", () => {
  const headers = (extra) => new Headers({ "X-Asset-Kind": "music", "Content-Type": "audio/mpeg", "Idempotency-Key": KEY, "Content-Length": "100", ...extra });
  assert.deepEqual(parseUploadRequest(headers({ "X-Asset-Name": "lagu%20saya.mp3" })), {
    kind: "music", mime: "audio/mpeg", format: "mp3", length: 100, name: "lagu saya.mp3", idempotencyKey: KEY,
  });
  assert.equal(parseUploadRequest(headers({ "Content-Type": "AUDIO/MPEG" })).mime, "audio/mpeg");
  const refused = (extra, status, code) => {
    try {
      parseUploadRequest(headers(extra));
    } catch (error) {
      assert.ok(error instanceof UploadRequestError);
      assert.equal(error.status, status, JSON.stringify(extra));
      assert.equal(error.code, code, JSON.stringify(extra));
      return;
    }
    assert.fail(`accepted ${JSON.stringify(extra)}`);
  };
  refused({ "X-Asset-Kind": "video" }, 400, "invalid_request");
  refused({ "X-Asset-Kind": "" }, 400, "invalid_request");
  refused({ "Content-Type": "image/png" }, 415, "asset_type_unsupported");
  refused({ "Content-Type": "audio/mpeg; charset=binary" }, 415, "asset_type_unsupported");
  refused({ "Content-Type": "audio/x-mpegurl" }, 415, "asset_type_unsupported");
  refused({ "Content-Type": "multipart/form-data; boundary=x" }, 415, "asset_type_unsupported");
  refused({ "Idempotency-Key": "nope" }, 400, "invalid_request");
  refused({ "Content-Length": "0" }, 400, "asset_empty");
  refused({ "Content-Length": "-1" }, 400, "invalid_request");
  refused({ "Content-Length": "1e3" }, 400, "invalid_request");
  refused({ "Content-Length": String(50 * 1024 * 1024 + 1) }, 413, "asset_too_large");
  refused({ "X-Asset-Name": "a%00b" }, 400, "invalid_request");
  refused({ "X-Asset-Name": "x".repeat(81) }, 400, "invalid_request");
  const noLength = new Headers({ "X-Asset-Kind": "logo", "Content-Type": "image/png", "Idempotency-Key": KEY });
  assert.throws(() => parseUploadRequest(noLength), (error) => error.status === 411 && error.code === "length_required");
});

test("the DTO carries the peaks URL for music only", () => {
  assert.deepEqual(assetDto(JOB_ID, logoAsset()), { ...logoAsset(), peaksUrl: null });
  const music = { sha256: SHA, kind: "music", mime: "audio/mp4", w: null, h: null, durationMs: 95000, lufsC: -1620, name: "a.mp3" };
  assert.deepEqual(assetDto(JOB_ID, music), { ...music, peaksUrl: `/api/jobs/${JOB_ID}/assets/${SHA}?part=peaks` });
});

// --- POST: gates, transport, quarantine, mapping -------------------------------------------------------

test("route modules export their handlers and run on node", () => {
  assert.equal(typeof uploadRouteModule.POST, "function");
  assert.equal(uploadRouteModule.GET, undefined);
  assert.equal(typeof fileRouteModule.GET, "function");
  assert.equal(typeof fileRouteModule.HEAD, "function");
  assert.equal(fileRouteModule.POST, undefined);
  for (const module of [uploadRouteModule, fileRouteModule]) {
    assert.equal(module.runtime, "nodejs");
    assert.equal(module.dynamic, "force-dynamic");
  }
});

test("session, flags, origin and ids are checked before anything is read or spawned", async (t) => {
  const root = await jobsRoot(t);
  const { calls, runCli } = recorder();
  const make = (extra = {}) => createAssetUploadRoute(deps(root, { runCli, ...extra }));
  const png = pngBytes();
  const cases = [
    [make(), upload(png, { cookie: false }), 401, undefined],
    [make({ env: env({ JOBS_ROOT: root, POTONGIN_EDITOR_V3: "off" }) }), upload(png), 404, "editor_disabled"],
    [make({ env: env({ JOBS_ROOT: root, POTONGIN_EDITOR_UPLOADS: undefined }) }), upload(png), 404, "uploads_disabled"],
    [make({ env: env({ JOBS_ROOT: root, POTONGIN_EDITOR_UPLOADS: "off" }) }), upload(png), 404, "uploads_disabled"],
    [make(), upload(png, { origin: null }), 403, "csrf_rejected"],
    [make(), upload(png, { origin: "http://evil" }), 403, "csrf_rejected"],
    [make(), upload(png, { headers: { "Sec-Fetch-Site": "cross-site" } }), 403, "csrf_rejected"],
  ];
  for (const [route, request, status, code] of cases) {
    const result = await read(await route.POST(request, context({ id: JOB_ID })));
    assert.equal(result.status, status, result.text);
    if (code) assert.equal(result.body.code, code);
  }
  for (const id of ["../etc", "8F0C2A1E-5B7D-4C3A-9E21-6D4F0B8A7C55", "x"]) {
    const result = await read(await make().POST(upload(png, { job: "x" }), context({ id })));
    assert.equal(result.status, 400);
  }
  const unknown = randomUUID();
  const missing = await read(await make().POST(upload(png, { job: unknown }), context({ id: unknown })));
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "not_found");
  assert.equal(calls.length, 0);
  assert.deepEqual(await readdir(path.join(root, JOB_ID, "analysis")), []);
});

test("transport refusals happen before the quarantine is written", async (t) => {
  const root = await jobsRoot(t);
  const { calls, runCli } = recorder();
  const setup = deps(root, { runCli });
  const route = createAssetUploadRoute(setup);
  const png = pngBytes();
  const cases = [
    [upload(png, { kind: "video" }), 400, "invalid_request"],
    [upload(png, { type: "image/gif" }), 415, "asset_type_unsupported"],
    [upload(png, { type: "image/svg+xml" }), 415, "asset_type_unsupported"],
    [upload(png, { kind: "music" }), 415, "asset_type_unsupported"],
    [upload(png, { key: "not-a-uuid" }), 400, "invalid_request"],
    [upload(png, { length: null }), 411, "length_required"],
    [upload(Buffer.alloc(0)), 400, "asset_empty"],
    [upload(png, { length: 10 * 1024 * 1024 + 1 }), 413, "asset_too_large"],
    [upload(png, { name: "a%0Ab.png" }), 400, "invalid_request"],
  ];
  for (const [request, status, code] of cases) {
    const result = await read(await route.POST(request, context({ id: JOB_ID })));
    assert.equal(result.status, status, result.text);
    assert.equal(result.body.code, code);
    assert.equal(result.body.messageId, `edit.${code}`);
    assert.equal(result.body.error, ASSET_MESSAGES[code]);
    assert.equal(result.headers.get("cache-control"), "no-store");
    assert.equal(result.headers.get("x-content-type-options"), "nosniff");
  }
  assert.equal(calls.length, 0);
  assert.equal(setup.store.reserved.length, 0);
});

test("the sniff refuses a body that does not match its type, without spawning", async (t) => {
  const root = await jobsRoot(t);
  const { calls, runCli } = recorder();
  const setup = deps(root, { runCli });
  const route = createAssetUploadRoute(setup);
  const bodies = [
    [Buffer.from("GIF89a\x01\x00\x01\x00\x80\x00\x00", "latin1"), "logo", "image/png"],
    [Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'></svg>"), "logo", "image/png"],
    [pngBytes(), "logo", "image/jpeg"],
    [Buffer.from("#EXTM3U\n#EXTINF:1,\nfile:///etc/passwd\n"), "music", "audio/mp4"],
    [Buffer.from("ffconcat version 1.0\nfile '/etc/passwd'\n"), "music", "audio/mpeg"],
    [Buffer.from("\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heic", "latin1"), "music", "audio/mp4"],
    [wavBytes(), "music", "audio/mpeg"],
    [Buffer.from("ID3"), "music", "audio/mpeg"], // shorter than 64 bytes: sniffed at the end, too short to be a tag
  ];
  for (const [body, kind, type] of bodies) {
    const result = await read(await route.POST(upload(body, { kind, type }), context({ id: JOB_ID })));
    assert.equal(result.status, 415, `${type}: ${result.text}`);
    assert.equal(result.body.code, "asset_type_unsupported");
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(await readdir(path.join(root, JOB_ID, "analysis", "assets", ".incoming")), []);
  assert.equal(setup.store.released.length, setup.store.reserved.length);
  assert.ok(setup.store.released.every((item) => item.state === "failed"));
});

test("after a sniff mismatch the rest of the body is read and dropped before the 415", async (t) => {
  // Answering in the middle of an upload would reset the connection: the browser would show a
  // network error instead of "Jenis file tidak didukung".
  const root = await jobsRoot(t);
  const { calls, runCli } = recorder();
  const route = createAssetUploadRoute(deps(root, { runCli }));
  const chunks = [Buffer.from(`GIF89a${"x".repeat(100)}`), Buffer.alloc(1024 * 1024, 7), Buffer.alloc(1024 * 1024, 9)];
  let pulled = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (pulled < chunks.length) controller.enqueue(chunks[pulled++]);
      else controller.close();
    },
  });
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const request = new Request(`http://local/api/jobs/${JOB_ID}/assets`, {
    method: "POST", duplex: "half", body,
    headers: { Host: "local", Origin: "http://local", Cookie: `potongin_session=${createSessionToken(AUTH)}`,
      "X-Asset-Kind": "logo", "Content-Type": "image/png", "Idempotency-Key": KEY, "Content-Length": String(total) },
  });
  const result = await read(await route.POST(request, context({ id: JOB_ID })));
  assert.equal(result.status, 415);
  assert.equal(result.body.code, "asset_type_unsupported");
  assert.equal(pulled, chunks.length);
  assert.equal(calls.length, 0);
  assert.deepEqual(await readdir(path.join(root, JOB_ID, "analysis", "assets", ".incoming")), []);
});

function countingBody(chunks) {
  const state = { pulled: 0 };
  state.stream = new ReadableStream({
    pull(controller) {
      if (state.pulled < chunks.length) controller.enqueue(chunks[state.pulled++]);
      else controller.close();
    },
  });
  return state;
}

function streamed(state, length, headers = {}) {
  return new Request(`http://local/api/jobs/${JOB_ID}/assets`, {
    method: "POST", duplex: "half", body: state.stream,
    headers: { Host: "local", Origin: "http://local", Cookie: `potongin_session=${createSessionToken(AUTH)}`,
      "X-Asset-Kind": "logo", "Content-Type": "image/png", "Idempotency-Key": KEY, "Content-Length": String(length), ...headers },
  });
}

test("a refusal after the session checks reads the declared body first, so the client sees the answer", async (t) => {
  // Over HTTP, answering while the client is still sending closes the connection: the browser
  // reports a network error instead of "file too large", "quota reached" or "disk full".
  const root = await jobsRoot(t);
  const { calls, runCli } = recorder();
  const mb = () => Buffer.alloc(1024 * 1024, 1);
  const oversize = countingBody([mb(), mb(), mb()]);
  let result = await read(await createAssetUploadRoute(deps(root, { runCli })).POST(
    streamed(oversize, 10 * 1024 * 1024 + 1), context({ id: JOB_ID })));
  assert.equal(result.status, 413);
  assert.equal(oversize.pulled, 3);
  const wrongType = countingBody([mb(), mb()]);
  result = await read(await createAssetUploadRoute(deps(root, { runCli })).POST(
    streamed(wrongType, 2 * 1024 * 1024, { "Content-Type": "image/gif" }), context({ id: JOB_ID })));
  assert.equal(result.status, 415);
  assert.equal(wrongType.pulled, 2);
  const full = countingBody([pngBytes(), mb()]);
  const failing = createAssetUploadRoute(deps(root, { runCli, reserve: async () => {
    throw Object.assign(new Error("full"), { code: "storage_free_space_low" });
  } }));
  result = await read(await failing.POST(streamed(full, pngBytes().length + 1024 * 1024), context({ id: JOB_ID })));
  assert.equal(result.status, 507);
  assert.equal(full.pulled, 2);
  const store = path.join(root, JOB_ID, "analysis", "assets");
  for (let i = 0; i < 50; i += 1) await writeFile(path.join(store, `${String(i).padStart(64, "0")}.json`), "{}");
  const quota = countingBody([pngBytes(), mb()]);
  result = await read(await createAssetUploadRoute(deps(root, { runCli })).POST(
    streamed(quota, pngBytes().length + 1024 * 1024), context({ id: JOB_ID })));
  assert.equal(result.status, 409);
  assert.equal(quota.pulled, 2);
  // Beyond 64 MiB declared, nothing is read: the answer comes at once.
  const huge = countingBody([mb(), mb(), mb()]);
  result = await read(await createAssetUploadRoute(deps(root, { runCli })).POST(
    streamed(huge, 65 * 1024 * 1024), context({ id: JOB_ID })));
  assert.equal(result.status, 413);
  assert.ok(huge.pulled < 3, "not consumed"); // a stream pre-pulls one chunk by itself
  // Before the session checks nothing is read either.
  const anonymous = countingBody([mb(), mb(), mb()]);
  const request = streamed(anonymous, 3 * 1024 * 1024, { Cookie: "" });
  assert.equal((await createAssetUploadRoute(deps(root, { runCli })).POST(request, context({ id: JOB_ID }))).status, 401);
  assert.ok(anonymous.pulled < 3, "not consumed");
  assert.equal(calls.length, 0);
});

test("the body is streamed to a private quarantine file, counted and removed afterwards", async (t) => {
  const root = await jobsRoot(t);
  const png = pngBytes(3, 3);
  let seen = null;
  const { calls, runCli } = recorder({
    ingest: async (payload) => {
      const file = path.join(root, JOB_ID, "analysis", "assets", ".incoming", payload.incomingId);
      const info = await lstat(file);
      seen = { mode: info.mode & 0o777, bytes: await readFile(file), dirMode: (await stat(path.dirname(file))).mode & 0o777,
        storeMode: (await stat(path.dirname(path.dirname(file)))).mode & 0o777 };
      return { exitCode: 0, json: { asset: logoAsset({ w: 3, h: 3, name: "passwd" }), created: true } };
    },
  });
  const setup = deps(root, { runCli });
  const route = createAssetUploadRoute(setup);
  const result = await read(await route.POST(upload(png, { name: encodeURIComponent("../../etc/passwd") }), context({ id: JOB_ID })));
  assert.equal(result.status, 201, result.text);
  assert.deepEqual(result.body, { ...logoAsset({ w: 3, h: 3, name: "passwd" }), peaksUrl: null });
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.deepEqual(seen, { mode: 0o600, bytes: png, dirMode: 0o700, storeMode: 0o700 });
  assert.equal(calls.length, 1);
  const [{ module, op, payload, options }] = calls;
  assert.equal(module, "ai_clipper.edit_v2.assets");
  assert.equal(op, "ingest");
  assert.deepEqual(Object.keys(payload).sort(), ["idempotencyKey", "incomingId", "jobId", "kind", "mime", "name"]);
  assert.deepEqual({ ...payload, incomingId: "x" }, { jobId: JOB_ID, incomingId: "x", kind: "logo", mime: "image/png", name: "passwd", idempotencyKey: KEY });
  assert.ok(options.timeoutMs >= 20_000 && options.timeoutMs <= 60_000);
  assert.deepEqual(await readdir(path.join(root, JOB_ID, "analysis", "assets", ".incoming")), []);
  assert.equal(setup.store.reserved.length, 1);
  assert.equal(setup.store.reserved[0].jobId, JOB_ID);
  assert.ok(setup.store.reserved[0].declaredBytes >= BigInt(png.length));
  assert.deepEqual(setup.store.released.map((item) => item.state), ["completed"]);
});

test("a body longer or shorter than its Content-Length is refused and nothing is kept", async (t) => {
  const root = await jobsRoot(t);
  const { calls, runCli } = recorder();
  const setup = deps(root, { runCli });
  const route = createAssetUploadRoute(setup);
  const png = pngBytes();
  for (const length of [png.length - 1, png.length + 1]) {
    const result = await read(await route.POST(upload(png, { length }), context({ id: JOB_ID })));
    assert.equal(result.status, length < png.length ? 413 : 400, result.text);
  }
  const huge = new ReadableStream({
    start(controller) {
      controller.enqueue(pngBytes());
      for (let i = 0; i < 12; i += 1) controller.enqueue(new Uint8Array(1024 * 1024));
      controller.close();
    },
  });
  const request = new Request(`http://local/api/jobs/${JOB_ID}/assets`, {
    method: "POST", duplex: "half", body: huge,
    headers: { Host: "local", Origin: "http://local", Cookie: `potongin_session=${createSessionToken(AUTH)}`,
      "X-Asset-Kind": "logo", "Content-Type": "image/png", "Idempotency-Key": KEY, "Content-Length": String(1024) },
  });
  const result = await read(await route.POST(request, context({ id: JOB_ID })));
  assert.equal(result.status, 413);
  assert.equal(result.body.code, "asset_too_large");
  assert.equal(calls.length, 0);
  assert.deepEqual(await readdir(path.join(root, JOB_ID, "analysis", "assets", ".incoming")), []);
  assert.ok(setup.store.released.every((item) => item.state === "failed"));
});

test("a body larger than 10 MB is streamed whole to the ingest (no buffering cap in the route)", async (t) => {
  const root = await jobsRoot(t);
  const wav = wavBytes({ seconds: 330, rate: 16000, channels: 1 }); // 10.6 MB
  assert.ok(wav.length > 10 * 1024 * 1024);
  let hash = null;
  const { runCli } = recorder({
    ingest: async (payload) => {
      const file = path.join(root, JOB_ID, "analysis", "assets", ".incoming", payload.incomingId);
      hash = createHash("sha256").update(await readFile(file)).digest("hex");
      return { exitCode: 0, json: { asset: { sha256: SHA, kind: "music", mime: "audio/mp4", w: null, h: null, durationMs: 330000, lufsC: -2100, name: null }, created: true } };
    },
  });
  const route = createAssetUploadRoute(deps(root, { runCli }));
  const result = await read(await route.POST(upload(wav, { kind: "music", type: "audio/wav" }), context({ id: JOB_ID })));
  assert.equal(result.status, 201, result.text);
  assert.equal(hash, createHash("sha256").update(wav).digest("hex"));
  assert.equal(result.body.peaksUrl, `/api/jobs/${JOB_ID}/assets/${SHA}?part=peaks`);
});

test("ingest outcomes map to fixed codes; nothing of the backend leaks", async (t) => {
  const root = await jobsRoot(t);
  const png = pngBytes();
  const outcomes = [
    [{ exitCode: 0, json: { asset: logoAsset(), created: false } }, 200, null],
    [{ exitCode: 3, json: { error: { code: "asset_type_unsupported", ref: null } } }, 415, "asset_type_unsupported"],
    [{ exitCode: 3, json: { error: { code: "asset_too_large", ref: null } } }, 413, "asset_too_large"],
    [{ exitCode: 3, json: { error: { code: "asset_rejected", ref: "dimensions" } } }, 422, "asset_rejected"],
    [{ exitCode: 3, json: { error: { code: "asset_rejected", ref: "/etc/passwd" } } }, 422, "asset_rejected"],
    [{ exitCode: 3, json: { error: { code: "asset_quota_exceeded", ref: null } } }, 409, "asset_quota_exceeded"],
    [{ exitCode: 3, json: { error: { code: "something_else", ref: null } } }, 422, "asset_rejected"],
    [{ exitCode: 9, json: { error: { code: "idempotency_conflict" } } }, 409, "idempotency_conflict"],
    [{ exitCode: 4, json: { error: { code: "not_found" } } }, 404, "not_found"],
    [{ exitCode: 0, json: { asset: logoAsset({ sha256: "../x" }), created: true } }, 503, "backend_unavailable"],
    [{ exitCode: 0, json: { asset: logoAsset({ kind: "music" }), created: true } }, 503, "backend_unavailable"],
    [{ exitCode: 0, json: { asset: logoAsset({ path: "/data/jobs/x" }), created: true } }, 503, "backend_unavailable"],
    [new PythonCliError("timeout"), 503, "backend_unavailable"],
    [new PythonCliError("backend_failed"), 503, "backend_unavailable"],
  ];
  for (const [outcome, status, code] of outcomes) {
    const setup = deps(root, recorder({ ingest: outcome }));
    const result = await read(await createAssetUploadRoute(setup).POST(upload(png), context({ id: JOB_ID })));
    assert.equal(result.status, status, `${JSON.stringify(outcome)} → ${result.text}`);
    if (code) {
      assert.equal(result.body.code, code);
      assert.equal(result.body.error, ASSET_MESSAGES[code]);
    }
    if (code === "asset_rejected") assert.equal(result.body.reason, outcome.json.error.ref === "dimensions" ? "dimensions" : undefined);
    assert.ok(!result.text.includes(root) && !result.text.includes("/etc/passwd") && !result.text.includes("/data/jobs"));
    assert.deepEqual(setup.store.released.map((item) => item.state), [status < 300 ? "completed" : "failed"]);
  }
});

test("uploads are rate limited per session (30 per minute)", async (t) => {
  const root = await jobsRoot(t);
  let now = 0;
  const limits = createEditorRateLimits({ now: () => now });
  const route = createAssetUploadRoute(deps(root, { limits, ...recorder({ ingest: { exitCode: 0, json: { asset: logoAsset(), created: false } } }) }));
  for (let i = 0; i < 30; i += 1) assert.equal((await route.POST(upload(pngBytes()), context({ id: JOB_ID }))).status, 200);
  const limited = await read(await route.POST(upload(pngBytes()), context({ id: JOB_ID })));
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, "rate_limited");
  assert.equal(limited.headers.get("retry-after"), "2");
  now += 2000;
  assert.equal((await route.POST(upload(pngBytes()), context({ id: JOB_ID }))).status, 200);
});

test("the per-job quota and the storage reservation are checked before streaming", async (t) => {
  const root = await jobsRoot(t);
  const store = path.join(root, JOB_ID, "analysis", "assets");
  await mkdir(store, { recursive: true, mode: 0o700 });
  for (let i = 0; i < 50; i += 1) await writeFile(path.join(store, `${String(i).padStart(64, "0")}.json`), "{}");
  const { calls, runCli } = recorder();
  const full = await read(await createAssetUploadRoute(deps(root, { runCli })).POST(upload(pngBytes()), context({ id: JOB_ID })));
  assert.equal(full.status, 409);
  assert.equal(full.body.code, "asset_quota_exceeded");
  await rm(store, { recursive: true });
  const failures = [
    [Object.assign(new Error("quota"), { code: "storage_quota_exhausted" }), 507],
    [Object.assign(new Error("low"), { code: "storage_free_space_low" }), 507],
    [Object.assign(new Error("x"), { code: "storage_admission_unavailable" }), 503],
    [new Error("anything"), 503],
  ];
  for (const [error, status] of failures) {
    const route = createAssetUploadRoute(deps(root, { runCli, reserve: async () => { throw error; } }));
    const result = await read(await route.POST(upload(pngBytes()), context({ id: JOB_ID })));
    assert.equal(result.status, status);
  }
  assert.equal(calls.length, 0);
});

test("symlinked job, analysis, store or quarantine directories are refused", async (t) => {
  const root = await jobsRoot(t);
  const elsewhere = await mkdtemp(path.join(os.tmpdir(), "asset-elsewhere-"));
  t.after(() => rm(elsewhere, { recursive: true, force: true }));
  const { calls, runCli } = recorder();
  const route = createAssetUploadRoute(deps(root, { runCli }));
  const analysis = path.join(root, JOB_ID, "analysis");
  await symlink(elsewhere, path.join(analysis, "assets"));
  let result = await read(await route.POST(upload(pngBytes()), context({ id: JOB_ID })));
  assert.equal(result.status, 404);
  await rm(path.join(analysis, "assets"));
  await mkdir(path.join(analysis, "assets"), { mode: 0o700 });
  await symlink(elsewhere, path.join(analysis, "assets", ".incoming"));
  result = await read(await route.POST(upload(pngBytes()), context({ id: JOB_ID })));
  assert.equal(result.status, 404);
  const other = randomUUID();
  await symlink(path.join(root, JOB_ID), path.join(root, other));
  result = await read(await route.POST(upload(pngBytes(), { job: other }), context({ id: other })));
  assert.equal(result.status, 404);
  assert.equal(calls.length, 0);
  assert.deepEqual(await readdir(elsewhere), []);
});

// --- GET /assets/:sha ------------------------------------------------------------------------------------

async function storeAsset(root, { kind = "image", bytes = pngBytes(), name = "logo.png" } = {}) {
  const dir = path.join(root, JOB_ID, "analysis", "assets");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const sha = createHash("sha256").update(bytes).digest("hex");
  const meta = kind === "image" ? { kind, mime: "image/png", w: 2, h: 2, name } : { kind, mime: "audio/mp4", duration_ms: 1000, lufs_c: -2000, name };
  await writeFile(path.join(dir, `${sha}.${kind === "image" ? "png" : "m4a"}`), bytes, { mode: 0o600 });
  await writeFile(path.join(dir, `${sha}.json`), JSON.stringify(meta), { mode: 0o600 });
  if (kind === "audio") await writeFile(path.join(dir, `${sha}.peaks.bin`), Buffer.from([0xff, 0x01, 0xfe, 0x02]), { mode: 0o600 });
  return { dir, sha };
}

test("GET serves the normalised bytes with the §9.2 headers and Range", async (t) => {
  const root = await jobsRoot(t);
  const png = pngBytes();
  const { sha } = await storeAsset(root, { bytes: png });
  const route = createAssetFileRoute(deps(root));
  const full = await route.GET(get(sha), context({ id: JOB_ID, sha }));
  assert.equal(full.status, 200);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), png);
  assert.equal(full.headers.get("content-type"), "image/png");
  assert.equal(full.headers.get("x-content-type-options"), "nosniff");
  assert.equal(full.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  assert.equal(full.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(full.headers.get("content-disposition"), 'inline; filename="asset.png"');
  assert.equal(full.headers.get("cache-control"), "private, max-age=31536000, immutable");
  assert.equal(full.headers.get("accept-ranges"), "bytes");
  const part = await route.GET(get(sha, { range: "bytes=0-7" }), context({ id: JOB_ID, sha }));
  assert.equal(part.status, 206);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), png.subarray(0, 8));
  const head = await route.HEAD(get(sha, { method: "HEAD" }), context({ id: JOB_ID, sha }));
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(png.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const meta = await read(await route.GET(get(sha, { part: "meta" }), context({ id: JOB_ID, sha })));
  assert.equal(meta.status, 200);
  assert.deepEqual(meta.body, { sha256: sha, kind: "logo", mime: "image/png", w: 2, h: 2, durationMs: null, lufsC: null, name: "logo.png", peaksUrl: null });
  assert.equal((await route.GET(get(sha, { part: "peaks" }), context({ id: JOB_ID, sha }))).status, 404);
});

test("GET serves music and its peaks", async (t) => {
  const root = await jobsRoot(t);
  const m4a = Buffer.concat([Buffer.from("\x00\x00\x00\x18ftypM4A ", "latin1"), Buffer.alloc(32)]);
  const { sha } = await storeAsset(root, { kind: "audio", bytes: m4a, name: null });
  const route = createAssetFileRoute(deps(root));
  const full = await route.GET(get(sha), context({ id: JOB_ID, sha }));
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-type"), "audio/mp4");
  assert.equal(full.headers.get("content-disposition"), 'inline; filename="asset.m4a"');
  const peaks = await route.GET(get(sha, { part: "peaks" }), context({ id: JOB_ID, sha }));
  assert.equal(peaks.status, 200);
  assert.equal(peaks.headers.get("content-type"), "application/octet-stream");
  assert.equal(peaks.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  assert.deepEqual([...Buffer.from(await peaks.arrayBuffer())], [0xff, 0x01, 0xfe, 0x02]);
  const meta = await read(await route.GET(get(sha, { part: "meta" }), context({ id: JOB_ID, sha })));
  assert.deepEqual(meta.body, { sha256: sha, kind: "music", mime: "audio/mp4", w: null, h: null, durationMs: 1000, lufsC: -2000, name: null,
    peaksUrl: `/api/jobs/${JOB_ID}/assets/${sha}?part=peaks` });
});

test("GET refuses bad ids, unknown parts, symlinks and anything outside the store", async (t) => {
  const root = await jobsRoot(t);
  const { dir, sha } = await storeAsset(root);
  const route = createAssetFileRoute(deps(root));
  const status = async (request, params) => (await route.GET(request, context(params))).status;
  assert.equal(await status(get(sha, { cookie: false }), { id: JOB_ID, sha }), 401);
  const off = createAssetFileRoute(deps(root, { env: env({ JOBS_ROOT: root, POTONGIN_EDITOR_V3: "off" }) }));
  assert.equal((await off.GET(get(sha), context({ id: JOB_ID, sha }))).status, 404);
  // uploads off: stored assets are still served to the editor
  const noUploads = createAssetFileRoute(deps(root, { env: env({ JOBS_ROOT: root, POTONGIN_EDITOR_UPLOADS: "off" }) }));
  assert.equal((await noUploads.GET(get(sha), context({ id: JOB_ID, sha }))).status, 200);
  for (const bad of ["../x", sha.toUpperCase(), `sha256:${sha}`, sha.slice(1), `${sha}.png`]) {
    assert.equal(await status(get(encodeURIComponent(bad)), { id: JOB_ID, sha: bad }), 400, bad);
  }
  assert.equal(await status(get(sha, { part: "json" }), { id: JOB_ID, sha }), 400);
  assert.equal(await status(get("c".repeat(64)), { id: JOB_ID, sha: "c".repeat(64) }), 404);
  const target = path.join(dir, `${sha}.png`);
  const outside = path.join(root, "outside.png");
  await writeFile(outside, pngBytes());
  await rm(target);
  await symlink(outside, target);
  assert.equal(await status(get(sha), { id: JOB_ID, sha }), 404);
  const linked = createHash("sha256").update("linked").digest("hex");
  await symlink(outside, path.join(dir, `${linked}.json`));
  assert.equal(await status(get(linked), { id: JOB_ID, sha: linked }), 404);
});

// --- the browser client ---------------------------------------------------------------------------------

class FakeXhr {
  constructor(script) {
    this.script = script;
    this.headers = {};
    this.upload = {};
    this.readyState = 0;
  }
  open(method, url) { this.method = method; this.url = url; this.readyState = 1; }
  setRequestHeader(name, value) {
    if (!/^[\x20-\x7e]*$/.test(value)) throw new TypeError("not a ByteString");
    this.headers[name.toLowerCase()] = value;
  }
  send(body) { this.body = body; queueMicrotask(() => this.script(this)); }
  abort() { this.aborted = true; this.onabort?.(); }
  getResponseHeader(name) { return this.responseHeaders?.[name.toLowerCase()] ?? null; }
  respond(status, body, headers = { "content-type": "application/json" }) {
    this.status = status;
    this.responseText = typeof body === "string" ? body : JSON.stringify(body);
    this.responseHeaders = headers;
    this.readyState = 4;
    this.onload?.();
  }
}

function fileLike(name, type, size, bytes = Buffer.alloc(size)) {
  return { name, type, size, bytes };
}

function client(script, options = {}) {
  const made = [];
  const instance = createUploadClient({
    xhrFactory: () => { const xhr = new FakeXhr(script); made.push(xhr); return xhr; },
    randomUuid: () => KEY,
    ...options,
  });
  return { instance, made };
}

test("uploadAsset sends the raw file with the transport headers and reports progress", async () => {
  const dto = { ...logoAsset(), peaksUrl: null };
  const { instance, made } = client((xhr) => {
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 200 });
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 200, total: 200 });
    xhr.upload.onload?.();
    xhr.respond(201, dto);
  });
  const progress = [];
  const file = fileLike("Logo Toko é.PNG", "image/png", 200);
  const result = await instance.uploadAsset(JOB_ID, file, "logo", { onProgress: (value, info) => progress.push([value, info?.phase]) });
  assert.deepEqual(result, dto);
  const [xhr] = made;
  assert.equal(xhr.method, "POST");
  assert.equal(xhr.url, `/api/jobs/${JOB_ID}/assets`);
  assert.equal(xhr.body, file);
  assert.deepEqual(xhr.headers, {
    accept: "application/json", "content-type": "image/png", "x-asset-kind": "logo", "idempotency-key": KEY,
    "x-asset-name": encodeURIComponent("Logo Toko é.PNG"),
  });
  assert.deepEqual(progress, [[0.25, "upload"], [1, "upload"], [1, "processing"]]);
});

test("the client maps browser types and extensions to the allowlist before sending", () => {
  const cases = [
    [["a.m4a", "audio/x-m4a"], "music", "audio/mp4"], [["a.m4a", ""], "music", "audio/mp4"], [["a.mp3", "audio/mp3"], "music", "audio/mpeg"],
    [["a.wav", "audio/x-wav"], "music", "audio/wav"], [["a.wav", "audio/wave"], "music", "audio/wav"], [["a.wav", "audio/vnd.wave"], "music", "audio/wav"],
    [["a.flac", "audio/x-flac"], "music", "audio/flac"], [["a.ogg", "application/ogg"], "music", "audio/ogg"], [["a.opus", "audio/opus"], "music", "audio/ogg"],
    [["a.aac", "audio/aac"], "music", null], [["a.jpg", "image/jpg"], "logo", "image/jpeg"], [["a.JPEG", ""], "logo", "image/jpeg"],
    [["a.png", "image/png"], "logo", "image/png"], [["a.webp", ""], "logo", "image/webp"], [["a.svg", "image/svg+xml"], "logo", null],
    [["a.gif", "image/gif"], "logo", null], [["a.heic", "image/heic"], "logo", null], [["a.png", "image/png"], "music", null],
    [["a.mp3", "audio/mpeg"], "logo", null], [["noext", ""], "logo", null],
  ];
  for (const [[name, type], kind, expected] of cases) assert.equal(canonicalType({ name, type }, kind), expected, `${name} ${type} ${kind}`);
  assert.equal(displayName("../x/Lagu\u0000 Saya.mp3"), "Lagu Saya.mp3");
  assert.equal(displayName(`${"x".repeat(100)}.mp3`), `${"x".repeat(76)}.mp3`);
  assert.equal([...displayName(`${"🎵".repeat(100)}.png`)].length, 80);
  assert.equal(displayName("\u0000"), null);
});

test("client-side refusals never open a request", async () => {
  const { instance, made } = client(() => assert.fail("no request"));
  const refused = async (file, kind, status, code) => {
    await assert.rejects(instance.uploadAsset(JOB_ID, file, kind), (error) => {
      assert.ok(error instanceof UploadError);
      assert.equal(error.status, status);
      assert.equal(error.code, code);
      assert.equal(error.message, uploadMessage(code));
      return true;
    });
  };
  await refused(fileLike("a.gif", "image/gif", 10), "logo", 415, "asset_type_unsupported");
  await refused(fileLike("a.png", "image/png", 10 * 1024 * 1024 + 1), "logo", 413, "asset_too_large");
  await refused(fileLike("a.mp3", "audio/mpeg", 50 * 1024 * 1024 + 1), "music", 413, "asset_too_large");
  await refused(fileLike("a.png", "image/png", 0), "logo", 400, "asset_empty");
  await refused(fileLike("a.png", "image/png", 10), "video", 400, "invalid_request");
  await assert.rejects(instance.uploadAsset("../x", fileLike("a.png", "image/png", 10), "logo"), TypeError);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(instance.uploadAsset(JOB_ID, fileLike("a.png", "image/png", 10), "logo", { signal: controller.signal }), { name: "AbortError" });
  assert.equal(made.length, 0);
});

test("server errors become UploadError with the Indonesian message and reason", async () => {
  const cases = [
    [415, { code: "asset_type_unsupported" }, "asset_type_unsupported", null],
    [422, { code: "asset_rejected", reason: "dimensions" }, "asset_rejected", "dimensions"],
    [422, { code: "asset_rejected", reason: "duration" }, "asset_rejected", "duration"],
    [409, { code: "asset_quota_exceeded" }, "asset_quota_exceeded", null],
    [429, { code: "rate_limited" }, "rate_limited", null],
    [404, { code: "uploads_disabled" }, "uploads_disabled", null],
    [401, { error: "Sesi login tidak valid" }, "unauthorized", null],
    [503, "<html>proxy</html>", "http_503", null],
  ];
  for (const [status, body, code, reason] of cases) {
    const { instance } = client((xhr) => xhr.respond(status, body, typeof body === "string" ? { "content-type": "text/html" } : undefined));
    await assert.rejects(instance.uploadAsset(JOB_ID, fileLike("a.png", "image/png", 10), "logo"), (error) => {
      assert.ok(error instanceof UploadError);
      assert.equal(error.status, status);
      assert.equal(error.code, code);
      assert.equal(error.reason, reason);
      assert.equal(error.message, uploadMessage(code, reason));
      assert.ok(error.message.length > 0 && !/proxy/.test(error.message));
      return true;
    });
  }
  assert.notEqual(uploadMessage("asset_rejected", "dimensions"), uploadMessage("asset_rejected"));
  assert.notEqual(uploadMessage("asset_rejected", "duration"), uploadMessage("asset_rejected"));
  assert.equal(uploadMessage("asset_rejected", "not-a-reason"), uploadMessage("asset_rejected"));
});

test("no upload message names a version or an engine (the owner's latest-only rule)", () => {
  const reasons = ["dimensions", "duration", "short", "channels", "streams", "timeout", null];
  const shown = [
    ...Object.values(ASSET_MESSAGES),
    ...Object.keys(ASSET_MESSAGES).map((code) => uploadMessage(code)),
    ...reasons.map((reason) => uploadMessage("asset_rejected", reason)),
    ...["unauthorized", "network_error", "invalid_response", "http_500"].map((code) => uploadMessage(code)),
  ];
  for (const text of shown) {
    assert.doesNotMatch(text, /\bV\d\b|\bv\d+(?:\.\d+)*\b|mesin (?:lama|baru)|engine|versi/i, text);
    assert.doesNotMatch(text, /—/, text);
  }
});

test("network failures, aborts and malformed answers", async () => {
  let { instance } = client((xhr) => xhr.onerror?.());
  await assert.rejects(instance.uploadAsset(JOB_ID, fileLike("a.png", "image/png", 10), "logo"), (error) => error.code === "network_error" && error.status === 0);
  ({ instance } = client((xhr) => xhr.respond(201, "not json", { "content-type": "application/json" })));
  await assert.rejects(instance.uploadAsset(JOB_ID, fileLike("a.png", "image/png", 10), "logo"), (error) => error.code === "invalid_response");
  ({ instance } = client((xhr) => xhr.respond(201, { ...logoAsset(), sha256: "nope" })));
  await assert.rejects(instance.uploadAsset(JOB_ID, fileLike("a.png", "image/png", 10), "logo"), (error) => error.code === "invalid_response");
  const controller = new AbortController();
  const made = [];
  instance = createUploadClient({ xhrFactory: () => { const xhr = new FakeXhr(() => controller.abort()); made.push(xhr); return xhr; } });
  await assert.rejects(instance.uploadAsset(JOB_ID, fileLike("a.png", "image/png", 10), "logo", { signal: controller.signal }), { name: "AbortError" });
  assert.equal(made[0].aborted, true);
  assert.match(made[0].headers["idempotency-key"], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("the real client and the fake agree on the Appendix A.2 surface", async () => {
  assert.equal(typeof uploadAsset, "function");
  assert.equal(uploadAsset.length, 3);
  const fake = createFakeUploadClient();
  const { instance } = client((xhr) => xhr.respond(201, { ...logoAsset(), peaksUrl: null }));
  const real = await instance.uploadAsset(JOB_ID, fileLike("a.png", "image/png", 10), "logo");
  const faked = await fake.uploadAsset(JOB_ID, { name: "a.png", size: 10, type: "image/png" }, "logo");
  for (const key of ["sha256", "kind", "mime", "w", "h", "durationMs", "lufsC", "peaksUrl"]) {
    assert.ok(key in real && key in faked, key);
  }
  assert.equal(assetUrl(JOB_ID, SHA), `/api/jobs/${JOB_ID}/assets/${SHA}`);
  assert.equal(assetUrl(JOB_ID, `sha256:${SHA}`, "peaks"), `/api/jobs/${JOB_ID}/assets/${SHA}?part=peaks`);
  assert.throws(() => assetUrl(JOB_ID, "../x"), TypeError);
});

// --- integration: the real ingest CLI ---------------------------------------------------------------------

const REAL = have("ffmpeg") && have("ffprobe") && have("prlimit");

function realDeps(root, extra = {}) {
  return deps(root, { env: env({ JOBS_ROOT: root, ...SECRETS }), pythonBin: python(), ...extra });
}

test("a PNG and a WAV go through the real ingest and are served back byte for byte", { skip: !REAL && "ffmpeg/prlimit missing" }, async (t) => {
  const root = await jobsRoot(t);
  const route = createAssetUploadRoute(realDeps(root));
  const files = createAssetFileRoute(realDeps(root));
  const logo = await read(await route.POST(upload(pngBytes(40, 30), { name: encodeURIComponent("Logo Toko.png") }), context({ id: JOB_ID })));
  assert.equal(logo.status, 201, logo.text);
  assert.equal(logo.body.w, 40);
  assert.equal(logo.body.name, "Logo Toko.png");
  const served = Buffer.from(await (await files.GET(get(logo.body.sha256), context({ id: JOB_ID, sha: logo.body.sha256 }))).arrayBuffer());
  assert.equal(createHash("sha256").update(served).digest("hex"), logo.body.sha256);
  assert.ok(!served.includes(Buffer.from("secret-metadata")));
  const again = await read(await route.POST(upload(pngBytes(40, 30), { key: randomUUID() }), context({ id: JOB_ID })));
  assert.equal(again.status, 200);
  assert.equal(again.body.sha256, logo.body.sha256);
  const music = await read(await route.POST(upload(wavBytes({ seconds: 2 }), { kind: "music", type: "audio/wav", key: randomUUID() }), context({ id: JOB_ID })));
  assert.equal(music.status, 201, music.text);
  assert.ok(music.body.durationMs >= 1990 && music.body.durationMs <= 2050);
  assert.ok(Number.isInteger(music.body.lufsC));
  const peaks = await files.GET(get(music.body.sha256, { part: "peaks" }), context({ id: JOB_ID, sha: music.body.sha256 }));
  assert.equal(peaks.status, 200);
  assert.equal((await peaks.arrayBuffer()).byteLength, 2 * Math.ceil(music.body.durationMs / 10));
  const conflict = await read(await route.POST(upload(pngBytes(41, 30)), context({ id: JOB_ID })));
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, "idempotency_conflict");
  assert.deepEqual(await readdir(path.join(root, JOB_ID, "analysis", "assets", ".incoming")), []);
});

test("the ingest children hold no secret (E11): python, ffprobe and ffmpeg", { skip: !REAL && "ffmpeg/prlimit missing" }, async (t) => {
  const root = await jobsRoot(t);
  const bin = await mkdtemp(path.join(os.tmpdir(), "asset-env-"));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const log = path.join(bin, "environ.jsonl");
  const recorderScript = (real, tool) => `#!${python()}
import json, os, sys
with open(${JSON.stringify(log)}, "a") as handle:
    env = dict(item.split("=", 1) for item in open("/proc/self/environ").read().split("\\0") if item)
    handle.write(json.dumps({"tool": ${JSON.stringify(tool)}, "env": env}) + "\\n")
os.execv(${JSON.stringify(real)}, [${JSON.stringify(real)}] + sys.argv[1:])
`;
  const which = (tool) => spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
  for (const tool of ["ffmpeg", "ffprobe"]) {
    await writeFile(path.join(bin, tool), recorderScript(which(tool), tool));
    await chmod(path.join(bin, tool), 0o755);
  }
  const pythonWrapper = path.join(bin, "python-wrapper");
  await writeFile(pythonWrapper, recorderScript(python(), "python"));
  await chmod(pythonWrapper, 0o755);
  const route = createAssetUploadRoute(realDeps(root, {
    env: env({ JOBS_ROOT: root, ...SECRETS, PATH: `${bin}:${process.env.PATH}` }), pythonBin: pythonWrapper,
  }));
  assert.equal((await route.POST(upload(pngBytes(8, 8)), context({ id: JOB_ID }))).status, 201);
  assert.equal((await route.POST(upload(wavBytes({ seconds: 1 }), { kind: "music", type: "audio/wav", key: randomUUID() }), context({ id: JOB_ID }))).status, 201);
  const records = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual([...new Set(records.map((record) => record.tool))].sort(), ["ffmpeg", "ffprobe", "python"]);
  for (const record of records) {
    const names = Object.keys(record.env);
    const allowed = record.tool === "python" ? new Set(CHILD_ENV_ALLOWLIST) : FFMPEG_ENV;
    assert.ok(names.every((name) => allowed.has(name)), `${record.tool}: ${names}`);
    const text = JSON.stringify(record.env);
    for (const value of Object.values(SECRETS)) assert.ok(!text.includes(value), `${record.tool} holds a secret`);
  }
});

test("a fuzz subset through the real route: every case is a 2xx or a 4xx, never a 5xx", { skip: !REAL && "ffmpeg/prlimit missing", timeout: 600_000 }, async (t) => {
  const root = await jobsRoot(t);
  const corpus = await mkdtemp(path.join(os.tmpdir(), "asset-fuzz-"));
  t.after(() => rm(corpus, { recursive: true, force: true }));
  const built = spawnSync(python(), [path.join(REPO, "scripts", "security", "make_upload_fuzz.py"), "write", corpus], { encoding: "utf8", timeout: 300_000 });
  assert.equal(built.status, 0, built.stderr);
  const index = JSON.parse(await readFile(path.join(corpus, "index.json"), "utf8"));
  const heavy = new Set(["mp3_ten_hours_lying_xing", "png_deflate_bomb", "oversize_music", "mp3_huge_id3"]);
  const route = createAssetUploadRoute(realDeps(root, { limits: createEditorRateLimits({ limits: { upload: { capacity: 1000, refillPerSecond: 1000, scope: "session" } } }) }));
  const results = [];
  for (const item of index.cases.filter((entry) => !heavy.has(entry.id))) {
    const body = await readFile(path.join(corpus, item.file));
    const started = Date.now();
    const response = await read(await route.POST(upload(body, {
      kind: item.kind, type: item.mime, key: randomUUID(),
      name: item.name === null ? undefined : encodeURIComponent(item.name),
    }), context({ id: JOB_ID })));
    results.push({ id: item.id, expect: item.expect, status: response.status, code: response.body?.code, ms: Date.now() - started });
  }
  assert.ok(results.length >= 40);
  const wrong = results.filter((item) => item.status >= 500 || (item.expect === "reject" && item.status < 400)
    || (item.expect === "normalise" && item.status >= 300) || item.ms > (index.cases.find((c) => c.id === item.id).kind === "logo" ? 20_000 : 60_000));
  assert.deepEqual(wrong, []);
  assert.deepEqual(await readdir(path.join(root, JOB_ID, "analysis", "assets", ".incoming")), []);
});
