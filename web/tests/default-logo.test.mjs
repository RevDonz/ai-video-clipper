// Pengaturan "Logo bawaan" (plan 2026-10-20 A6): web/lib/default-logo.mjs (the settings store,
// the routes, the copy a new job gets), the browser upload and the card's copy. Unit cases use a
// recording CLI runner that writes what the ingest writes; the integration case runs the real
// `python -m ai_clipper.edit_v2.assets` and reads the job copy back with the Python seeder.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import * as logoRouteModule from "../app/api/settings/logo/route.js";
import * as logoFileRouteModule from "../app/api/settings/logo/[sha]/route.js";
import { createSessionToken, isAuthorized } from "../lib/auth.mjs";
import {
  DEFAULT_LOGO_DIR,
  createDefaultLogoFileRoute,
  createDefaultLogoRoute,
  readDefaultLogo,
  snapshotDefaultLogo,
} from "../lib/default-logo.mjs";
import { DEFAULT_LOGO_ACCEPT, defaultLogoCopy, defaultLogoState } from "../lib/default-logo-view.mjs";
import { createUploadClient } from "../lib/editor/upload-client.mjs";
import { applyCommand, CommandRejected } from "../lib/editor/commands.mjs";
import { createContext } from "../lib/editor/doc-model.mjs";
import { createEditorRateLimits } from "../lib/rate-limit.mjs";
import { LOGO_ACCEPT } from "../components/editor/gizmos/logo-upload.mjs";
import { fakeDoc, fakeWords } from "../components/editor/__dev__/fakes.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const AUTH = Object.freeze({ APP_USERNAME: "admin", APP_PASSWORD: "pw-logo-value", APP_SESSION_SECRET: "logo-session-".padEnd(48, "q") });
const KEY = "00000000-0000-4000-8000-0000000000aa";
let session = null;
const sessionToken = () => (session ??= createSessionToken(AUTH));

function authorize(request) {
  return isAuthorized(request, AUTH) ? null
    : Response.json({ error: "Sesi login tidak valid" }, { status: 401, headers: { "Cache-Control": "no-store" } });
}

async function roots(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "default-logo-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const jobs = path.join(base, "jobs");
  const settings = path.join(base, "settings");
  await mkdir(jobs, { recursive: true });
  return { base, jobs, settings };
}

function env(where, extra = {}) {
  return {
    ...AUTH, PATH: process.env.PATH, JOBS_ROOT: where.jobs, POTONGIN_SETTINGS_DIR: where.settings,
    POTONGIN_EDITOR_V3: "on", POTONGIN_EDITOR_UPLOADS: "on", ...extra,
  };
}

// A runner that writes what `edit_v2.assets ingest` writes into the scratch job it is given.
function fakeIngest({ result, png = pngBytes(8, 4), w = 8, h = 4, name = "logo.png" } = {}) {
  const calls = [];
  const runCli = async (module, op, payload, options) => {
    calls.push({ module, op, payload, options });
    if (result !== undefined) return typeof result === "function" ? result(payload, options) : result;
    const sha = createHash("sha256").update(png).digest("hex");
    const store = path.join(options.env.JOBS_ROOT, payload.jobId, "analysis", "assets");
    const meta = { schema: "potongin.asset/1", kind: "image", mime: "image/png", w, h, name: payload.name, bytes: png.length, created_at_ms: 1 };
    await writeFile(path.join(store, `${sha}.png`), png, { mode: 0o600 });
    await writeFile(path.join(store, `${sha}.json`), JSON.stringify(meta), { mode: 0o600 });
    return { exitCode: 0, json: { asset: { sha256: sha, kind: "logo", mime: "image/png", w, h, durationMs: null, lufsC: null, name: payload.name ?? null }, created: true } };
  };
  return { calls, runCli, sha: createHash("sha256").update(png).digest("hex"), name };
}

function deps(where, extra = {}) {
  return { authorize, env: env(where), limits: createEditorRateLimits(), ...extra };
}

function post(body, { type = "image/png", kind = "logo", key = KEY, name, length, origin = "http://local", cookie = true, headers = {} } = {}) {
  const all = { Host: "local", "X-Asset-Kind": kind, "Content-Type": type, "Idempotency-Key": key, ...headers };
  if (origin) all.Origin = origin;
  if (cookie) all.Cookie = `potongin_session=${sessionToken()}`;
  if (name !== undefined) all["X-Asset-Name"] = name;
  const bytes = body instanceof Uint8Array ? body : Buffer.from(body ?? "");
  if (length !== null) all["Content-Length"] = String(length ?? bytes.length);
  for (const [header, value] of Object.entries(all)) if (value === undefined) delete all[header];
  return new Request("http://local/api/settings/logo", { method: "POST", headers: all, body: bytes, duplex: "half" });
}

function request(method, url = "http://local/api/settings/logo", { cookie = true, origin = "http://local" } = {}) {
  const headers = { Host: "local" };
  if (cookie) headers.Cookie = `potongin_session=${sessionToken()}`;
  if (origin && method !== "GET" && method !== "HEAD") headers.Origin = origin;
  return new Request(url, { method, headers });
}

async function read(response) {
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body, text, headers: response.headers };
}

function chunk(kind, body) {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(kind, 4, "latin1");
  body.copy(out, 8);
  out.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(kind, "latin1"), body])) >>> 0, 8 + body.length);
  return out;
}

function pngBytes(width = 2, height = 2, shade = 128) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const row = Buffer.alloc(1 + 4 * width);
  for (let x = 0; x < width; x += 1) row.set([(x * 97) & 255, 40, shade, 255], 1 + 4 * x);
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}

const logoDir = (where) => path.join(where.settings, DEFAULT_LOGO_DIR);

// Route modules and the transport.

test("route modules export their handlers and run on node", () => {
  assert.equal(typeof logoRouteModule.GET, "function");
  assert.equal(typeof logoRouteModule.POST, "function");
  assert.equal(typeof logoRouteModule.DELETE, "function");
  assert.equal(typeof logoFileRouteModule.GET, "function");
  assert.equal(typeof logoFileRouteModule.HEAD, "function");
  assert.equal(logoFileRouteModule.POST, undefined);
  for (const module of [logoRouteModule, logoFileRouteModule]) {
    assert.equal(module.runtime, "nodejs");
    assert.equal(module.dynamic, "force-dynamic");
  }
  // The card accepts exactly what the editor's Logo panel accepts.
  assert.equal(DEFAULT_LOGO_ACCEPT, LOGO_ACCEPT);
});

test("session, flags and origin are checked before anything is read, written or spawned", async (t) => {
  const where = await roots(t);
  const { calls, runCli } = fakeIngest();
  const make = (extra = {}) => createDefaultLogoRoute(deps(where, { runCli, ...extra }));
  const png = pngBytes();
  const cases = [
    [make(), post(png, { cookie: false }), 401, undefined],
    [make({ env: env(where, { POTONGIN_EDITOR_V3: "off" }) }), post(png), 404, "uploads_disabled"],
    [make({ env: env(where, { POTONGIN_EDITOR_UPLOADS: undefined }) }), post(png), 404, "uploads_disabled"],
    [make(), post(png, { origin: null }), 403, "csrf_rejected"],
    [make(), post(png, { origin: "http://evil" }), 403, "csrf_rejected"],
    [make(), post(png, { headers: { "Sec-Fetch-Site": "cross-site" } }), 403, "csrf_rejected"],
  ];
  for (const [route, req, status, code] of cases) {
    const result = await read(await route.POST(req));
    assert.equal(result.status, status, result.text);
    if (code) assert.equal(result.body.code, code);
  }
  assert.equal((await read(await make().GET(request("GET", undefined, { cookie: false })))).status, 401);
  assert.equal((await read(await make().DELETE(request("DELETE", undefined, { cookie: false })))).status, 401);
  assert.equal((await read(await make().DELETE(request("DELETE", undefined, { origin: "http://evil" })))).status, 403);
  assert.equal(calls.length, 0);
  await assert.rejects(lstat(where.settings), { code: "ENOENT" });
});

test("transport, size and type are refused before the scratch store is written", async (t) => {
  const where = await roots(t);
  const { calls, runCli } = fakeIngest();
  const route = createDefaultLogoRoute(deps(where, { runCli }));
  const png = pngBytes();
  const cases = [
    [post(png, { kind: "music" }), 415, "asset_type_unsupported"],
    [post(png, { kind: "video" }), 400, "invalid_request"],
    [post(png, { type: "image/gif" }), 415, "asset_type_unsupported"],
    [post(png, { type: "image/svg+xml" }), 415, "asset_type_unsupported"],
    [post(png, { key: "nope" }), 400, "invalid_request"],
    [post(png, { length: null }), 411, "length_required"],
    [post(Buffer.alloc(0)), 400, "asset_empty"],
    [post(png, { length: 10 * 1024 * 1024 + 1 }), 413, "asset_too_large"],
    [post(png, { name: "a%0Ab.png" }), 400, "invalid_request"],
  ];
  for (const [req, status, code] of cases) {
    const result = await read(await route.POST(req));
    assert.equal(result.status, status, result.text);
    assert.equal(result.body.code, code);
    assert.equal(result.headers.get("cache-control"), "no-store");
  }
  assert.equal(calls.length, 0);
  await assert.rejects(lstat(path.join(logoDir(where), ".work", "x")), { code: "ENOENT" });
});

test("the sniff refuses a body that is not what it claims, without spawning", async (t) => {
  const where = await roots(t);
  const { calls, runCli } = fakeIngest();
  const route = createDefaultLogoRoute(deps(where, { runCli }));
  for (const [body, type] of [
    [Buffer.from("GIF89a\x01\x00\x01\x00\x80\x00\x00", "latin1"), "image/png"],
    [Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'></svg>"), "image/png"],
    [pngBytes(), "image/jpeg"],
    [pngBytes(), "image/webp"],
  ]) {
    const result = await read(await route.POST(post(body, { type })));
    assert.equal(result.status, 415, result.text);
    assert.equal(result.body.code, "asset_type_unsupported");
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(await readdir(path.join(logoDir(where), ".work")), []);
  assert.equal(await readDefaultLogo(env(where)), null);
});

// Upload, read, replace, serve, remove.

test("an upload is normalised by the editor's ingest in a scratch job and becomes the default logo", async (t) => {
  const where = await roots(t);
  const ingest = fakeIngest();
  const route = createDefaultLogoRoute(deps(where, { runCli: ingest.runCli, now: () => 1_790_000_000_000 }));
  assert.deepEqual((await read(await route.GET(request("GET")))).body, { logo: null, enabled: true, autoClips: true });

  const result = await read(await route.POST(post(pngBytes(), { name: encodeURIComponent("Logo Toko.png") })));
  assert.equal(result.status, 201, result.text);
  const url = `/api/settings/logo/${ingest.sha}`;
  assert.deepEqual(result.body, {
    sha256: ingest.sha, kind: "logo", mime: "image/png", w: 8, h: 4, durationMs: null, lufsC: null,
    name: "Logo Toko.png", peaksUrl: null, url, updatedAtMs: 1_790_000_000_000,
  });
  const [call] = ingest.calls;
  assert.equal(call.module, "ai_clipper.edit_v2.assets");
  assert.equal(call.op, "ingest");
  assert.deepEqual(Object.keys(call.payload).sort(), ["idempotencyKey", "incomingId", "jobId", "kind", "mime", "name"]);
  assert.equal(call.payload.kind, "logo");
  assert.equal(call.options.env.JOBS_ROOT, path.join(logoDir(where), ".work"));
  assert.equal(call.options.timeoutMs, 30_000);

  const dir = logoDir(where);
  assert.deepEqual((await readdir(dir)).sort(), [".work", `${ingest.sha}.json`, `${ingest.sha}.png`, "current.json"].sort());
  assert.deepEqual(await readdir(path.join(dir, ".work")), []); // the scratch job is gone
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  for (const name of ["current.json", `${ingest.sha}.png`, `${ingest.sha}.json`]) {
    assert.equal((await stat(path.join(dir, name))).mode & 0o777, 0o600, name);
  }
  const state = await read(await route.GET(request("GET")));
  assert.deepEqual(state.body, { logo: result.body, enabled: true, autoClips: true });
  assert.equal(state.headers.get("cache-control"), "no-store");

  const files = createDefaultLogoFileRoute(deps(where));
  const served = await files.GET(request("GET", `http://local${url}`), { params: Promise.resolve({ sha: ingest.sha }) });
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.equal(served.headers.get("cache-control"), "private, max-age=31536000, immutable");
  assert.equal(served.headers.get("x-content-type-options"), "nosniff");
  assert.match(served.headers.get("content-security-policy"), /sandbox/);
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), pngBytes(8, 4));
  const head = await files.HEAD(request("HEAD", `http://local${url}`), { params: Promise.resolve({ sha: ingest.sha }) });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(pngBytes(8, 4).length));
});

test("a new logo replaces the old one, and removing it leaves nothing behind", async (t) => {
  const where = await roots(t);
  const first = fakeIngest({ png: pngBytes(8, 4, 10) });
  const second = fakeIngest({ png: pngBytes(16, 4, 20), w: 16 });
  await createDefaultLogoRoute(deps(where, { runCli: first.runCli })).POST(post(pngBytes()));
  const route = createDefaultLogoRoute(deps(where, { runCli: second.runCli }));
  const replaced = await read(await route.POST(post(pngBytes(), { key: randomUUID() })));
  assert.equal(replaced.status, 201, replaced.text);
  assert.equal(replaced.body.sha256, second.sha);
  assert.deepEqual((await readdir(logoDir(where))).sort(), [".work", `${second.sha}.json`, `${second.sha}.png`, "current.json"].sort());
  const files = createDefaultLogoFileRoute(deps(where));
  const old = await files.GET(request("GET", `http://local/api/settings/logo/${first.sha}`), { params: Promise.resolve({ sha: first.sha }) });
  assert.equal(old.status, 404);

  const removed = await read(await route.DELETE(request("DELETE")));
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body, { logo: null, enabled: true, autoClips: true });
  assert.deepEqual((await readdir(logoDir(where))).sort(), [".work"]);
  assert.equal(await readDefaultLogo(env(where)), null);
  const gone = await files.GET(request("GET", `http://local/api/settings/logo/${second.sha}`), { params: Promise.resolve({ sha: second.sha }) });
  assert.equal(gone.status, 404);
  assert.equal((await read(await route.DELETE(request("DELETE")))).status, 200); // removing nothing is fine
});

test("ingest refusals keep their codes, never echo a path and clean the scratch job", async (t) => {
  const where = await roots(t);
  const cases = [
    [{ exitCode: 3, json: { error: { code: "asset_rejected", ref: "dimensions" } } }, 422, "asset_rejected", "dimensions"],
    [{ exitCode: 3, json: { error: { code: "asset_type_unsupported" } } }, 415, "asset_type_unsupported", undefined],
    [{ exitCode: 3, json: { error: { code: "asset_too_large" } } }, 413, "asset_too_large", undefined],
    [null, 503, "backend_unavailable", undefined],
    [{ exitCode: 0, json: { asset: { sha256: "x" }, created: true } }, 503, "backend_unavailable", undefined],
    [{ exitCode: 1, json: { error: { code: "internal_error", path: "/data/settings/default-logo" } } }, 503, "backend_unavailable", undefined],
  ];
  for (const [result, status, code, reason] of cases) {
    const { runCli } = fakeIngest({ result });
    const response = await read(await createDefaultLogoRoute(deps(where, { runCli })).POST(post(pngBytes(), { key: randomUUID() })));
    assert.equal(response.status, status, response.text);
    assert.equal(response.body.code, code);
    assert.equal(response.body.reason, reason);
    assert.doesNotMatch(response.text, /settings|default-logo|\.work/);
    assert.deepEqual(await readdir(path.join(logoDir(where), ".work")), []);
  }
  assert.equal(await readDefaultLogo(env(where)), null);
});

test("a settings directory inside JOBS_ROOT or a symlinked logo directory is refused", async (t) => {
  const where = await roots(t);
  const { calls, runCli } = fakeIngest();
  const inside = createDefaultLogoRoute(deps(where, { runCli, env: env(where, { POTONGIN_SETTINGS_DIR: path.join(where.jobs, "settings") }) }));
  const refused = await read(await inside.POST(post(pngBytes())));
  assert.equal(refused.status, 503);
  assert.equal(refused.body.code, "settings_unavailable");
  assert.doesNotMatch(refused.text, /jobs/);
  const elsewhere = path.join(where.base, "elsewhere");
  await mkdir(elsewhere);
  await mkdir(where.settings);
  await symlink(elsewhere, logoDir(where));
  const linked = await read(await createDefaultLogoRoute(deps(where, { runCli })).POST(post(pngBytes())));
  assert.equal(linked.status, 503);
  assert.equal(calls.length, 0);
  assert.deepEqual(await readdir(elsewhere), []);
  assert.equal(await readDefaultLogo(env(where)), null);
});

test("only the current logo is served, never a symlink or another file", async (t) => {
  const where = await roots(t);
  const ingest = fakeIngest();
  await createDefaultLogoRoute(deps(where, { runCli: ingest.runCli })).POST(post(pngBytes()));
  const files = createDefaultLogoFileRoute(deps(where));
  const get = (sha, extra = {}) => files.GET(request("GET", `http://local/api/settings/logo/${sha}`, extra), { params: Promise.resolve({ sha }) });
  assert.equal((await get("ab".repeat(32))).status, 404);
  assert.equal((await get("../current.json")).status, 400);
  assert.equal((await get(ingest.sha, { cookie: false })).status, 401);
  const png = path.join(logoDir(where), `${ingest.sha}.png`);
  const outside = path.join(where.base, "outside.png");
  await writeFile(outside, "outside");
  await rm(png);
  await symlink(outside, png);
  assert.equal((await get(ingest.sha)).status, 404);
  assert.equal(await readDefaultLogo(env(where)), null);
});

test("GET says whether uploads are on and whether automatic clips carry the logo", async (t) => {
  const where = await roots(t);
  const read0 = async (extra) => (await read(await createDefaultLogoRoute(deps(where, { env: env(where, extra) })).GET(request("GET")))).body;
  // edit-v2 is the release default (CONTRACTS §5.48); legacy is the rollback switch.
  assert.deepEqual(await read0({}), { logo: null, enabled: true, autoClips: true });
  assert.deepEqual(await read0({ POTONGIN_EDITOR_UPLOADS: "off" }), { logo: null, enabled: false, autoClips: true });
  assert.deepEqual(await read0({ POTONGIN_RENDER_ENGINE: "edit-v2" }), { logo: null, enabled: true, autoClips: true });
  assert.deepEqual(await read0({ POTONGIN_RENDER_ENGINE: "legacy" }), { logo: null, enabled: true, autoClips: false });
});

// The copy a new job gets.

test("a new job gets a copy of the current logo in <job>/logo/", async (t) => {
  const where = await roots(t);
  const job = path.join(where.jobs, randomUUID());
  await mkdir(job);
  assert.equal(await snapshotDefaultLogo(job, env(where)), false);
  await assert.rejects(lstat(path.join(job, "logo")), { code: "ENOENT" });

  const ingest = fakeIngest();
  await createDefaultLogoRoute(deps(where, { runCli: ingest.runCli })).POST(post(pngBytes()));
  assert.equal(await snapshotDefaultLogo(job, env(where)), true);
  const copy = path.join(job, "logo");
  assert.deepEqual((await readdir(copy)).sort(), [`${ingest.sha}.json`, `${ingest.sha}.png`]);
  assert.equal((await stat(copy)).mode & 0o777, 0o700);
  for (const name of await readdir(copy)) {
    assert.equal((await stat(path.join(copy, name))).mode & 0o777, 0o600);
    assert.deepEqual(await readFile(path.join(copy, name)), await readFile(path.join(logoDir(where), name)));
  }
  assert.equal(await snapshotDefaultLogo(job, env(where)), false); // never into an existing copy

  const other = path.join(where.jobs, randomUUID());
  await mkdir(other);
  await rm(path.join(logoDir(where), `${ingest.sha}.png`));
  assert.equal(await snapshotDefaultLogo(other, env(where)), false);
  await assert.rejects(lstat(path.join(other, "logo")), { code: "ENOENT" });
  assert.equal(await snapshotDefaultLogo(other, env(where, { POTONGIN_SETTINGS_DIR: "relative" })), false);
});

// Integration: the real ingest, and the job copy read back by the Python seeder.

function python() {
  const configured = process.env.PYTHON_BIN;
  if (configured) return configured.includes(path.sep) ? path.resolve(configured) : configured;
  return path.join(REPO, ".venv", "bin", "python");
}

function have(tool) {
  return spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).status === 0;
}

const REAL = have("ffmpeg") && have("ffprobe") && have("prlimit");

test("a real upload goes through the editor's ingest and a job copy seeds in Python", { skip: !REAL && "ffmpeg/prlimit missing" }, async (t) => {
  const where = await roots(t);
  const route = createDefaultLogoRoute(deps(where, { pythonBin: python() }));
  const uploaded = await read(await route.POST(post(pngBytes(40, 30), { name: encodeURIComponent("Logo.png") })));
  assert.equal(uploaded.status, 201, uploaded.text);
  assert.equal(uploaded.body.w, 40);
  const job = path.join(where.jobs, randomUUID());
  await mkdir(path.join(job, "analysis"), { recursive: true });
  assert.equal(await snapshotDefaultLogo(job, env(where)), true);
  const script = "import json, sys; from pathlib import Path; from ai_clipper.edit_v2 import assets; "
    + "print(json.dumps(assets.seed_logo(Path(sys.argv[1]), Path(sys.argv[1]))))";
  const result = spawnSync(python(), ["-c", script, job], { encoding: "utf8", env: { PATH: process.env.PATH, PYTHONPATH: path.join(REPO, "src") } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { sha256: uploaded.body.sha256, w: 40, h: 30 });
});

// The seed places the logo exactly where the editor's SetLogo places a new one.

test("the shared placement vectors are what SetLogo does", async () => {
  const fixture = JSON.parse(await readFile(path.join(REPO, "tests", "fixtures", "edit_v2", "default-logo-vectors.json"), "utf8"));
  const hex = "5c1f".padEnd(64, "a");
  assert.equal(fixture.vectors.length, 48); // 12 logos at 720×1280, 1080×1920, 720×720 and 1080×1080
  for (const vector of fixture.vectors) {
    const seed = fakeDoc();
    seed.output = { ...seed.output, w: vector.output[0], h: vector.output[1] };
    const ctx = createContext({ words: fakeWords(), seed });
    const meta = { sha256: hex, kind: "logo", mime: "image/png", w: vector.asset[0], h: vector.asset[1] };
    let transform = null;
    try {
      const doc = applyCommand(seed, "SetLogo", { asset: `sha256:${hex}`, meta }, ctx).doc;
      transform = doc.tracks.find((track) => track.kind === "visual").items[0].transform;
    } catch (error) {
      if (!(error instanceof CommandRejected)) throw error;
    }
    assert.deepEqual(transform, vector.transform, JSON.stringify(vector));
  }
});

// The browser side.

class FakeXhr {
  constructor(script) {
    this.script = script;
    this.headers = {};
    this.upload = {};
  }
  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader(name, value) { this.headers[name.toLowerCase()] = value; }
  send(body) { this.body = body; queueMicrotask(() => this.script(this)); }
  abort() { this.aborted = true; this.onabort?.(); }
  getResponseHeader(name) { return this.responseHeaders?.[name.toLowerCase()] ?? null; }
  respond(status, body) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.responseHeaders = { "content-type": "application/json" };
    this.onload?.();
  }
}

test("uploadDefaultLogo sends the raw file to the settings route with the asset transport", async () => {
  const dto = { sha256: "ab".repeat(32), kind: "logo", mime: "image/png", w: 2, h: 2, durationMs: null, lufsC: null, name: "a.png", peaksUrl: null, url: `/api/settings/logo/${"ab".repeat(32)}`, updatedAtMs: 1 };
  const made = [];
  const client = createUploadClient({ xhrFactory: () => { const xhr = new FakeXhr((x) => x.respond(201, dto)); made.push(xhr); return xhr; }, randomUuid: () => KEY });
  const file = { name: "a.png", type: "image/png", size: 10 };
  assert.deepEqual(await client.uploadDefaultLogo(file), dto);
  assert.equal(made[0].method, "POST");
  assert.equal(made[0].url, "/api/settings/logo");
  assert.deepEqual(made[0].headers, {
    accept: "application/json", "content-type": "image/png", "x-asset-kind": "logo", "idempotency-key": KEY, "x-asset-name": "a.png",
  });
  await assert.rejects(client.uploadDefaultLogo({ name: "a.gif", type: "image/gif", size: 10 }), { code: "asset_type_unsupported" });
  await assert.rejects(client.uploadDefaultLogo({ name: "a.png", type: "image/png", size: 10 * 1024 * 1024 + 1 }), { code: "asset_too_large" });
  assert.equal(made.length, 1);
});

test("the card's state and copy", () => {
  const logo = { sha256: "ab".repeat(32), kind: "logo", mime: "image/png", w: 300, h: 100, durationMs: null, lufsC: null, name: "toko.png", peaksUrl: null, url: `/api/settings/logo/${"ab".repeat(32)}`, updatedAtMs: 5 };
  assert.deepEqual(defaultLogoState({ logo, enabled: true, autoClips: false }), { logo, enabled: true, autoClips: false });
  assert.deepEqual(defaultLogoState({ logo: { ...logo, url: "https://evil/x.png" }, enabled: true, autoClips: false }).logo, null);
  assert.deepEqual(defaultLogoState(null), { logo: null, enabled: false, autoClips: false });
  assert.deepEqual(defaultLogoState({ logo: { ...logo, w: "300" } }).logo, null);
  const legacy = defaultLogoCopy({ autoClips: false });
  const auto = defaultLogoCopy({ autoClips: true });
  assert.match(legacy.where, /klip baru/);
  assert.match(legacy.where, /tidak berubah/);
  assert.match(legacy.reach, /editor/);
  assert.match(legacy.reach, /tanpa logo/);
  assert.doesNotMatch(auto.reach, /tanpa logo/);
  for (const copy of [legacy, auto]) {
    for (const text of Object.values(copy)) {
      assert.doesNotMatch(text, /—|\bV[1-3]\b|\bbaru\b.*\bfitur\b|mesin|legacy|edit-v2/i, text);
    }
  }
});
