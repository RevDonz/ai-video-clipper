// GET /api/jobs/:id/zip: "Unduh semua" and "Unduh (n)" on the project page. Session first, only
// this job's own clip files (output/clip-NN.mp4 through the safe final-file helpers), clip numbers
// checked, a size limit with an Indonesian message, no caching, and entries named NN-judul.mp4.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { close } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { GET, HEAD } from "../app/api/jobs/[id]/zip/route.js";
import { createSessionToken } from "../lib/auth.mjs";
import {
  DEFAULT_MAX_ZIP_BYTES,
  HARD_MAX_ZIP_BYTES,
  ZipConfigError,
  clipOutputName,
  clipsZipRoute,
  maxZipBytes,
  parseClipSelection,
} from "../lib/clips-zip.mjs";
import { openFinalFile } from "../lib/final-files.mjs";
import { crc32 } from "../lib/zip-store.mjs";
import { readZip } from "./support/read-zip.mjs";

const closeFd = promisify(close);

const JOB_ID = "123e4567-e89b-42d3-a456-426614174000";
const OTHER_JOB = "223e4567-e89b-42d3-a456-426614174000";
const AUTH_ENV = {
  APP_USERNAME: "admin",
  APP_PASSWORD: "secret-value",
  APP_SESSION_SECRET: "a-long-random-session-secret-value",
};
const DATA = [randomBytes(40_000), randomBytes(7), randomBytes(123_457)];
const TITLES = ["Rahasia Hook di 3 Detik", "Jangan menyerah!", "Ngopi di Café"];

function clip(index, extra = {}) {
  const base = `/api/jobs/${JOB_ID}/files/output/clip-${String(index).padStart(2, "0")}`;
  return {
    index, score: 7, duration: 30, text: "transkrip", title: TITLES[index - 1],
    videoUrl: `${base}.mp4`, downloadUrl: `${base}.mp4?download=1`, subtitleUrl: `${base}.srt?download=1`, ...extra,
  };
}

async function fixture(t, { job = {}, files = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "potongin-zip-route-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, JOB_ID, "output");
  await mkdir(output, { recursive: true });
  if (files) for (const [position, data] of DATA.entries()) await writeFile(path.join(output, `clip-0${position + 1}.mp4`), data);
  const record = { id: JOB_ID, status: "completed", source: { type: "upload", name: "Podcast Episode 12.mp4" }, clips: [clip(1), clip(2), clip(3)], ...job };
  await writeFile(path.join(root, JOB_ID, "job.json"), JSON.stringify(record));
  return { root, output };
}

async function call(root, { query = "", id = JOB_ID, authenticated = true, env = {}, signal } = {}) {
  const names = ["JOBS_ROOT", "MAX_ZIP_BYTES", ...Object.keys(AUTH_ENV)];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, AUTH_ENV, { JOBS_ROOT: root }, env);
  if (!("MAX_ZIP_BYTES" in env)) delete process.env.MAX_ZIP_BYTES;
  try {
    const headers = authenticated ? { Cookie: `potongin_session=${createSessionToken(AUTH_ENV, 2_000_000_000)}` } : {};
    return await GET(new Request(`http://local/api/jobs/${id}/zip${query}`, { headers, signal }), { params: Promise.resolve({ id }) });
  } finally {
    for (const [name, value] of Object.entries(previous)) value === undefined ? delete process.env[name] : process.env[name] = value;
  }
}

function assertHeaders(response, label) {
  assert.equal(response.headers.get("cache-control"), "no-store", `${label}: no-store`);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff", `${label}: nosniff`);
}

async function errorOf(response, status, code, label = code) {
  assert.equal(response.status, status, label);
  assertHeaders(response, label);
  const body = await response.json();
  assert.equal(body.code, code, label);
  assert.equal(typeof body.error, "string", label);
  return body;
}

async function saved(root, response) {
  const file = path.join(root, `download-${Math.random().toString(16).slice(2)}.zip`);
  await writeFile(file, Buffer.from(await response.arrayBuffer()));
  return readZip(file);
}

test("the size limit is MAX_ZIP_BYTES, 2 GiB by default and never above the classic ZIP's 4 GiB", () => {
  assert.equal(DEFAULT_MAX_ZIP_BYTES, 2 * 1024 ** 3);
  assert.ok(HARD_MAX_ZIP_BYTES < 2 ** 32);
  assert.equal(maxZipBytes({}), DEFAULT_MAX_ZIP_BYTES);
  assert.equal(maxZipBytes({ MAX_ZIP_BYTES: "" }), DEFAULT_MAX_ZIP_BYTES);
  assert.equal(maxZipBytes({ MAX_ZIP_BYTES: "1048576" }), 1_048_576);
  assert.equal(maxZipBytes({ MAX_ZIP_BYTES: "99999999999" }), HARD_MAX_ZIP_BYTES);
  for (const value of ["0", "-1", "1e9", "2GB", "1.5", " 12", "abc"]) {
    assert.throws(() => maxZipBytes({ MAX_ZIP_BYTES: value }), ZipConfigError, value);
  }
});

test("the picked clips are numbers of this project, each once; no list means every clip", () => {
  const available = [1, 2, 3, 12];
  assert.deepEqual(parseClipSelection(null, available), { indexes: [1, 2, 3, 12] });
  assert.deepEqual(parseClipSelection("12,1", available), { indexes: [1, 12] }, "the project's order");
  assert.deepEqual(parseClipSelection("3", available), { indexes: [3] });
  for (const value of ["", ",", "1,", "1,,2", "a", "1;2", "01", "0", "-1", "1.0", " 1", "1,1", "1".repeat(5), `${"1,".repeat(600)}1`]) {
    assert.deepEqual(parseClipSelection(value, available), { code: "invalid_clips" }, JSON.stringify(value));
  }
  assert.deepEqual(parseClipSelection("4", available), { code: "unknown_clip", index: 4 });
});

test("a clip's file is its own output/clip-NN.mp4 in this job, nothing else", () => {
  assert.equal(clipOutputName(clip(1), JOB_ID), "clip-01.mp4");
  assert.equal(clipOutputName({ downloadUrl: `/api/jobs/${JOB_ID}/files/output/clip-02.mp4?download=1` }, JOB_ID), "clip-02.mp4");
  for (const url of [
    `/api/jobs/${OTHER_JOB}/files/output/clip-01.mp4`, `/api/jobs/${JOB_ID}/files/output/edits/x/clip.mp4`,
    `/api/jobs/${JOB_ID}/files/output/..%2Fjob.json`, `/api/jobs/${JOB_ID}/files/output/clip-01.srt`,
    `/api/jobs/${JOB_ID}/files/output/%2e%2e`, `https://evil.example/api/jobs/${JOB_ID}/files/output/clip-01.mp4`,
    `/api/jobs/${JOB_ID}/files/analysis/clip-01.mp4`, "/v", "", null,
  ]) assert.equal(clipOutputName({ videoUrl: url, downloadUrl: url }, JOB_ID), null, String(url));
});

test("every answer needs a session and is never cached", async (t) => {
  const { root } = await fixture(t);
  const denied = await call(root, { authenticated: false });
  assert.equal(denied.status, 401);
  assertHeaders(denied, "401");
  const invalid = await call(root, { id: "not-a-job" });
  assert.equal(invalid.status, 400);
  assertHeaders(invalid, "400");
  // The handler checks the id itself too, whatever wraps it.
  const direct = await clipsZipRoute(new Request("http://local/api/jobs/x/zip"), { params: Promise.resolve({ id: "../x" }) }, { jobsRoot: root });
  assert.equal(direct.status, 400);
  assert.equal((await direct.json()).code, "invalid_request");
});

test("HEAD is refused: it would open every file for a body nobody reads", async (t) => {
  const { root } = await fixture(t);
  const previous = Object.fromEntries(["JOBS_ROOT", ...Object.keys(AUTH_ENV)].map((name) => [name, process.env[name]]));
  Object.assign(process.env, AUTH_ENV, { JOBS_ROOT: root });
  try {
    const cookie = `potongin_session=${createSessionToken(AUTH_ENV, 2_000_000_000)}`;
    const response = await HEAD(new Request(`http://local/api/jobs/${JOB_ID}/zip`, { method: "HEAD", headers: { Cookie: cookie } }), { params: Promise.resolve({ id: JOB_ID }) });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET");
    assertHeaders(response, "HEAD");
    const denied = await HEAD(new Request(`http://local/api/jobs/${JOB_ID}/zip`, { method: "HEAD" }), { params: Promise.resolve({ id: JOB_ID }) });
    assert.equal(denied.status, 401);
  } finally {
    for (const [name, value] of Object.entries(previous)) value === undefined ? delete process.env[name] : process.env[name] = value;
  }
});

test("a missing, unfinished or empty project answers with what is wrong, in Indonesian", async (t) => {
  const { root } = await fixture(t);
  await errorOf(await call(root, { id: OTHER_JOB }), 404, "not_found");
  for (const status of ["processing", "failed", "deleting", "queued"]) {
    const { root: unfinished } = await fixture(t, { job: { status } });
    const body = await errorOf(await call(unfinished), 409, "not_ready", status);
    assert.match(body.error, /belum/);
  }
  const { root: empty } = await fixture(t, { job: { clips: [] } });
  await errorOf(await call(empty), 404, "no_clips");
  const broken = await fixture(t);
  await writeFile(path.join(broken.root, JOB_ID, "job.json"), "bukan json");
  await errorOf(await call(broken.root), 503, "read_failed");
});

test("picked clip numbers are checked before any file is opened", async (t) => {
  const { root } = await fixture(t);
  for (const query of ["?clips=", "?clips=a", "?clips=1,1", "?clips=0", "?clips=1,,2"]) {
    const body = await errorOf(await call(root, { query }), 400, "invalid_clips", query);
    assert.equal(body.error, "Pilihan klip tidak valid.");
  }
  const unknown = await errorOf(await call(root, { query: "?clips=2,7" }), 404, "unknown_clip");
  assert.equal(unknown.error, "Klip 07 tidak ada di proyek ini.");
});

test("a clip file that is gone, foreign or a symlink stops the ZIP before it starts", async (t) => {
  const missing = await fixture(t, { files: false });
  const gone = await errorOf(await call(missing.root), 404, "file_missing");
  assert.equal(gone.error, "File Klip 01 tidak ditemukan di server.");
  const foreign = await fixture(t, { job: { clips: [clip(1), clip(2, { videoUrl: `/api/jobs/${OTHER_JOB}/files/output/clip-02.mp4`, downloadUrl: null })] } });
  const other = await errorOf(await call(foreign.root), 404, "file_missing");
  assert.equal(other.error, "File Klip 02 tidak ditemukan di server.");
  const linked = await fixture(t);
  const outside = path.join(linked.root, "outside.mp4");
  await writeFile(outside, "secret");
  await rm(path.join(linked.output, "clip-03.mp4"));
  await symlink(outside, path.join(linked.output, "clip-03.mp4"));
  await errorOf(await call(linked.root, { query: "?clips=3" }), 404, "file_missing");
});

test("a ZIP over the limit is refused with both sizes and what to do", async (t) => {
  const { root } = await fixture(t);
  const body = await errorOf(await call(root, { env: { MAX_ZIP_BYTES: "100000" } }), 413, "zip_too_large");
  assert.match(body.error, /^ZIP-nya \d+ KB, batasnya 98 KB\. Pilih lebih sedikit klip, atau unduh satu per satu\.$/);
  // The picked clips alone fit.
  const small = await call(root, { query: "?clips=1,2", env: { MAX_ZIP_BYTES: "100000" } });
  assert.equal(small.status, 200);
  await small.arrayBuffer();
  const config = await errorOf(await call(root, { env: { MAX_ZIP_BYTES: "dua giga" } }), 500, "zip_config_invalid");
  assert.match(config.error, /MAX_ZIP_BYTES/);
});

test("check=1 says how big the ZIP will be without sending it", async (t) => {
  const { root } = await fixture(t);
  const response = await call(root, { query: "?clips=3,1&check=1" });
  assert.equal(response.status, 200);
  assertHeaders(response, "check");
  const body = await response.json();
  // Per entry a 30-byte local header and a 46-byte central record, each with the name; one
  // 22-byte end record.
  const names = ["01-rahasia-hook-di-3-detik.mp4", "03-ngopi-di-cafe.mp4"];
  const expected = names.reduce((sum, name) => sum + 30 + 46 + 2 * name.length, 22) + DATA[0].length + DATA[2].length;
  assert.deepEqual(body, { count: 2, bytes: expected, filename: "podcast-episode-12-klip.zip" });
});

test("the ZIP streams every clip as NN-judul.mp4 with the right bytes and CRCs", async (t) => {
  const { root } = await fixture(t);
  const response = await call(root);
  assert.equal(response.status, 200);
  assertHeaders(response, "zip");
  assert.equal(response.headers.get("content-type"), "application/zip");
  assert.equal(response.headers.get("content-disposition"), "attachment; filename=\"podcast-episode-12-klip.zip\"");
  const length = Number(response.headers.get("content-length"));
  const copy = response.clone();
  assert.equal((await copy.arrayBuffer()).byteLength, length);
  const read = await saved(root, response);
  assert.equal(read.bad, null);
  assert.deepEqual(read.entries.map((entry) => entry.name), ["01-rahasia-hook-di-3-detik.mp4", "02-jangan-menyerah.mp4", "03-ngopi-di-cafe.mp4"]);
  for (const [position, data] of DATA.entries()) {
    assert.equal(read.entries[position].size, data.length);
    assert.equal(read.entries[position].method, 0);
    assert.equal(read.entries[position].crc, crc32(data));
  }

  const picked = await saved(root, await call(root, { query: "?clips=3,1" }));
  assert.deepEqual(picked.entries.map((entry) => entry.name), ["01-rahasia-hook-di-3-detik.mp4", "03-ngopi-di-cafe.mp4"]);
});

test("every descriptor opened for a refused or checked ZIP is closed again", async (t) => {
  const { root, output } = await fixture(t);
  const run = async (query, env = {}) => {
    const opened = [];
    const closed = [];
    const deps = {
      jobsRoot: root,
      env,
      openFile: async (...args) => {
        const handle = await openFinalFile(...args);
        opened.push(handle.fd);
        return handle;
      },
      closeFile: async (fd) => {
        closed.push(fd);
        await closeFd(fd);
      },
    };
    const response = await clipsZipRoute(new Request(`http://local/api/jobs/${JOB_ID}/zip${query}`), { params: Promise.resolve({ id: JOB_ID }) }, deps);
    await response.arrayBuffer();
    return { status: response.status, opened, closed };
  };
  const checked = await run("?check=1");
  assert.equal(checked.status, 200);
  assert.equal(checked.opened.length, 3);
  assert.deepEqual(checked.closed.sort(), checked.opened.sort());
  const tooLarge = await run("", { MAX_ZIP_BYTES: "1000" });
  assert.equal(tooLarge.status, 413);
  assert.deepEqual(tooLarge.closed.sort(), tooLarge.opened.sort());
  const sent = await run("");
  assert.equal(sent.status, 200);
  assert.deepEqual(sent.closed.sort(), sent.opened.sort());
  await rm(path.join(output, "clip-03.mp4"));
  const missing = await run("");
  assert.equal(missing.status, 404);
  assert.equal(missing.opened.length, 2);
  assert.deepEqual(missing.closed.sort(), missing.opened.sort());
});

test("two clips that would share a name get distinct ones", async (t) => {
  const { root } = await fixture(t, { job: { clips: [clip(1), clip(1, { videoUrl: `/api/jobs/${JOB_ID}/files/output/clip-02.mp4`, downloadUrl: null })] } });
  const read = await saved(root, await call(root));
  assert.deepEqual(read.entries.map((entry) => entry.name), ["01-rahasia-hook-di-3-detik.mp4", "01-rahasia-hook-di-3-detik-2.mp4"]);
});
