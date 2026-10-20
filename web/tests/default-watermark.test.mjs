// Pengaturan "Teks watermark bawaan" (CONTRACTS §5.40): web/lib/default-watermark.mjs (the settings
// file, the route, the copy a new job gets), the card's view model, and the Python seeder reading
// the job copy back.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as watermarkRouteModule from "../app/api/settings/watermark/route.js";
import { createSessionToken, isAuthorized } from "../lib/auth.mjs";
import {
  DEFAULT_WATERMARK_FILE,
  JOB_WATERMARK_FILE,
  createDefaultWatermarkRoute,
  parseDefaultWatermark,
  readDefaultWatermark,
  snapshotDefaultWatermark,
} from "../lib/default-watermark.mjs";
import {
  defaultWatermarkCopy,
  defaultWatermarkForm,
  defaultWatermarkPayload,
  defaultWatermarkState,
  formMatches,
} from "../lib/default-watermark-view.mjs";
import { autoFileIsSeed } from "../lib/editor/doc-model.mjs";
import { fakeDoc } from "../components/editor/__dev__/fakes.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const AUTH = Object.freeze({ APP_USERNAME: "admin", APP_PASSWORD: "pw-mark-value", APP_SESSION_SECRET: "mark-session-".padEnd(48, "q") });
const MARK = Object.freeze({ text: "@potongin.klip", pos: "top_center", size_pm: 1000, opacity_pm: 850 });
let session = null;
const sessionToken = () => (session ??= createSessionToken(AUTH));

function authorize(request) {
  return isAuthorized(request, AUTH) ? null
    : Response.json({ error: "Sesi login tidak valid" }, { status: 401, headers: { "Cache-Control": "no-store" } });
}

async function roots(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "default-watermark-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const jobs = path.join(base, "jobs");
  const settings = path.join(base, "settings");
  await mkdir(jobs, { recursive: true });
  return { base, jobs, settings };
}

function env(where, extra = {}) {
  return { ...AUTH, JOBS_ROOT: where.jobs, POTONGIN_SETTINGS_DIR: where.settings, ...extra };
}

function route(where, extra = {}) {
  return createDefaultWatermarkRoute({ authorize, env: env(where, extra), now: () => 1_790_000_000_000 });
}

function request(method, { body, cookie = true, origin = "http://local", type = "application/json" } = {}) {
  const headers = { Host: "local" };
  if (cookie) headers.Cookie = `potongin_session=${sessionToken()}`;
  if (origin && method !== "GET") headers.Origin = origin;
  let payload;
  if (body !== undefined) {
    payload = typeof body === "string" ? body : JSON.stringify(body);
    headers["Content-Type"] = type;
    headers["Content-Length"] = String(Buffer.byteLength(payload));
  }
  return new Request("http://local/api/settings/watermark", { method, headers, body: payload });
}

async function read(response) {
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body, headers: response.headers };
}

test("the route module exports its handlers and runs on node", () => {
  assert.equal(watermarkRouteModule.runtime, "nodejs");
  assert.equal(watermarkRouteModule.dynamic, "force-dynamic");
  for (const method of ["GET", "PUT", "DELETE"]) assert.equal(typeof watermarkRouteModule[method], "function", method);
});

test("the input is the document's watermark: four keys, the text trimmed in NFC", () => {
  assert.deepEqual(parseDefaultWatermark({ ...MARK, text: "  Café " }), { value: { ...MARK, text: "Café" } });
  for (const pos of ["top_left", "middle_center", "bottom_right"]) assert.equal(parseDefaultWatermark({ ...MARK, pos }).value.pos, pos);
  const refused = (input) => parseDefaultWatermark(input).field;
  assert.equal(refused({ ...MARK, text: "  " }), "text");
  assert.equal(refused({ ...MARK, text: "x".repeat(41) }), "text");
  assert.equal(refused({ ...MARK, text: "a\u0007b" }), "text");
  assert.equal(refused({ ...MARK, text: 7 }), "text");
  assert.equal(refused({ ...MARK, pos: "center" }), "pos");
  assert.equal(refused({ ...MARK, size_pm: 499 }), "size_pm");
  assert.equal(refused({ ...MARK, size_pm: 1000.5 }), "size_pm");
  assert.equal(refused({ ...MARK, opacity_pm: 1001 }), "opacity_pm");
  assert.equal(refused({ ...MARK, colour: "#FFFFFF" }), "body");
  assert.equal(refused(["@akun"]), "body");
  assert.equal(refused(null), "body");
  assert.match(parseDefaultWatermark({ ...MARK, text: "x".repeat(41) }).message, /40 karakter/);
});

test("session and origin are checked before the settings folder is touched", async (t) => {
  const where = await roots(t);
  const handlers = route(where);
  assert.equal((await handlers.GET(request("GET", { cookie: false }))).status, 401);
  assert.equal((await handlers.PUT(request("PUT", { body: MARK, cookie: false }))).status, 401);
  assert.equal((await handlers.PUT(request("PUT", { body: MARK, origin: "http://evil.test" }))).status, 403);
  assert.equal((await handlers.PUT(request("PUT", { body: MARK, origin: null }))).status, 403);
  assert.equal((await handlers.DELETE(request("DELETE", { origin: "http://evil.test" }))).status, 403);
  await assert.rejects(stat(where.settings), { code: "ENOENT" });
});

test("PUT saves the watermark (0600 in a 0700 folder), GET reads it back, DELETE removes it", async (t) => {
  const where = await roots(t);
  const handlers = route(where);
  assert.deepEqual((await read(await handlers.GET(request("GET")))).body, { watermark: null, autoClips: false });
  const saved = await read(await handlers.PUT(request("PUT", { body: { ...MARK, text: " @potongin.klip " } })));
  assert.equal(saved.status, 200);
  assert.equal(saved.headers.get("cache-control"), "no-store");
  assert.deepEqual(saved.body, { watermark: { ...MARK, updatedAtMs: 1_790_000_000_000 }, autoClips: false });
  const file = path.join(where.settings, DEFAULT_WATERMARK_FILE);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(where.settings)).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")),
    { schema: "potongin.default-watermark/1", ...MARK, updatedAtMs: 1_790_000_000_000 });
  assert.deepEqual(await readDefaultWatermark(env(where)), { ...MARK, updatedAtMs: 1_790_000_000_000 });
  const again = await read(await route(where, { POTONGIN_RENDER_ENGINE: "edit-v2" }).GET(request("GET")));
  assert.deepEqual(again.body, { watermark: { ...MARK, updatedAtMs: 1_790_000_000_000 }, autoClips: true });
  const removed = await read(await handlers.DELETE(request("DELETE")));
  assert.deepEqual(removed.body, { watermark: null, autoClips: false });
  await assert.rejects(stat(file), { code: "ENOENT" });
  assert.equal((await handlers.DELETE(request("DELETE"))).status, 200, "removing nothing is fine");
});

test("PUT refuses a bad watermark with its field, a non-JSON body and a large body", async (t) => {
  const where = await roots(t);
  const handlers = route(where);
  const bad = await read(await handlers.PUT(request("PUT", { body: { ...MARK, pos: "center" } })));
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, "invalid_watermark");
  assert.equal(bad.body.field, "pos");
  assert.equal((await handlers.PUT(request("PUT", { body: "{nope" }))).status, 400);
  assert.equal((await handlers.PUT(request("PUT", { body: MARK, type: "text/plain" }))).status, 415);
  assert.equal((await handlers.PUT(request("PUT", { body: { ...MARK, text: "x".repeat(5000) } }))).status, 413);
  await assert.rejects(stat(path.join(where.settings, DEFAULT_WATERMARK_FILE)), { code: "ENOENT" });
});

test("a broken or symlinked settings file reads as no watermark; a folder inside JOBS_ROOT is refused", async (t) => {
  const where = await roots(t);
  await mkdir(where.settings, { recursive: true, mode: 0o700 });
  const file = path.join(where.settings, DEFAULT_WATERMARK_FILE);
  for (const content of ["{}", "nope", JSON.stringify({ schema: "potongin.default-watermark/1", ...MARK, pos: "center", updatedAtMs: 1 })]) {
    await writeFile(file, content);
    assert.equal(await readDefaultWatermark(env(where)), null, content);
  }
  await rm(file);
  const elsewhere = path.join(where.base, "elsewhere.json");
  await writeFile(elsewhere, JSON.stringify({ schema: "potongin.default-watermark/1", ...MARK, updatedAtMs: 1 }));
  await symlink(elsewhere, file);
  assert.equal(await readDefaultWatermark(env(where)), null);
  const inside = { ...where, settings: path.join(where.jobs, "settings") };
  const refused = await read(await route(inside).PUT(request("PUT", { body: MARK })));
  assert.equal(refused.status, 503);
  assert.equal(refused.body.code, "settings_unavailable");
});

test("a new job gets a copy of the current watermark, and Python seeds it", async (t) => {
  const where = await roots(t);
  const job = path.join(where.jobs, "job-1");
  await mkdir(job);
  assert.equal(await snapshotDefaultWatermark(job, env(where)), false);
  await route(where).PUT(request("PUT", { body: MARK }));
  assert.equal(await snapshotDefaultWatermark(job, env(where)), true);
  const copy = path.join(job, JOB_WATERMARK_FILE);
  assert.equal((await stat(copy)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(copy, "utf8")), { schema: "potongin.job-watermark/1", ...MARK });
  assert.equal(await snapshotDefaultWatermark(job, env(where)), false, "an existing copy is never overwritten");
  const python = [path.join(REPO, ".venv", "bin", "python"), "python3"].find((candidate) => spawnSync(candidate, ["-c", "import ai_clipper"],
    { env: { ...process.env, PYTHONPATH: path.join(REPO, "src") } }).status === 0);
  if (python) {
    const run = spawnSync(python, ["-c", "import json, sys; from ai_clipper.edit_v2.seed import job_watermark; print(json.dumps(job_watermark(sys.argv[1])))", job],
      { env: { ...process.env, PYTHONPATH: path.join(REPO, "src") }, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), MARK);
  }
});

test("a legacy seed with the default watermark is not its auto file (R10)", () => {
  const seed = { ...fakeDoc(), watermark: { ...MARK } };
  assert.equal(autoFileIsSeed(seed), true);
  const legacy = { ...seed, base: { ...seed.base, engine: { ...seed.base.engine, compiler: "legacy" } } };
  assert.equal(autoFileIsSeed(legacy), false);
  const { watermark: _mark, ...plain } = legacy;
  assert.equal(autoFileIsSeed(plain), true);
});

test("the card's state, form and copy", () => {
  assert.deepEqual(defaultWatermarkState(null), { watermark: null, autoClips: false });
  assert.deepEqual(defaultWatermarkState({ watermark: { ...MARK, updatedAtMs: 5 }, autoClips: true }),
    { watermark: { ...MARK, updatedAtMs: 5 }, autoClips: true });
  assert.equal(defaultWatermarkState({ watermark: { ...MARK, pos: "x", updatedAtMs: 5 } }).watermark, null);
  assert.deepEqual(defaultWatermarkForm(null), { text: "", pos: "top_center", size_pm: 1000, opacity_pm: 850 });
  assert.deepEqual(defaultWatermarkForm({ ...MARK, pos: "bottom_left", updatedAtMs: 5 }), { ...MARK, pos: "bottom_left" });
  assert.deepEqual(defaultWatermarkPayload({ ...MARK, text: " @akun " }), { payload: { ...MARK, text: "@akun" } });
  assert.equal(defaultWatermarkPayload({ ...MARK, text: "" }).error, "Tulis teks watermark dulu.");
  assert.ok(formMatches({ ...MARK, text: "@potongin.klip " }, { ...MARK, updatedAtMs: 5 }));
  assert.ok(!formMatches({ ...MARK, size_pm: 1200 }, { ...MARK, updatedAtMs: 5 }));
  assert.ok(!formMatches(MARK, null));
  const auto = defaultWatermarkCopy({ autoClips: true });
  const editor = defaultWatermarkCopy({ autoClips: false });
  assert.match(auto.reach, /file klip otomatis/);
  assert.match(editor.reach, /tetap tanpa teks watermark/);
  assert.match(editor.perClip, /panel Logo/);
  for (const text of [...Object.values(auto), ...Object.values(editor)]) assert.ok(!text.includes("—"), text);
});
