import assert from "node:assert/strict";
import { close } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";

import { createSessionToken } from "../lib/auth.mjs";
import { GET, HEAD } from "../app/api/jobs/[id]/files/[...path]/route.js";
import {
  FinalFileInvalidError,
  finalFileResponse,
  openFinalFile,
} from "../lib/final-files.mjs";

const JOB_ID = "123e4567-e89b-42d3-a456-426614174000";
const AUTH_ENV = {
  APP_USERNAME: "admin",
  APP_PASSWORD: "secret-value",
  APP_SESSION_SECRET: "a-long-random-session-secret-value",
};
const MEDIA = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom-final-render-data")]);
const closeFd = promisify(close);
const SEGMENTS = ["output", "edits", "clip.mp4"];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "clipper-final-"));
  const output = path.join(root, JOB_ID, "output");
  const edits = path.join(output, "edits");
  await mkdir(edits, { recursive: true });
  const target = path.join(edits, "clip.mp4");
  await writeFile(target, MEDIA);
  return { root, output, edits, target };
}

function request({ method = "GET", range, authenticated = true, signal, download = false } = {}) {
  const headers = {};
  if (range) headers.Range = range;
  if (authenticated) headers.Cookie = `potongin_session=${createSessionToken(AUTH_ENV, 2_000_000_000)}`;
  return new Request(`http://local/api/jobs/${JOB_ID}/files/output/edits/clip.mp4${download ? "?download=1" : ""}`, { method, headers, signal });
}

async function invoke(root, options = {}) {
  const previous = {};
  for (const name of ["JOBS_ROOT", ...Object.keys(AUTH_ENV)]) previous[name] = process.env[name];
  Object.assign(process.env, AUTH_ENV, { JOBS_ROOT: root });
  try {
    const handler = options.method === "HEAD" ? HEAD : GET;
    return await handler(request(options), {
      params: Promise.resolve({ id: options.id || JOB_ID, path: options.segments || SEGMENTS }),
    });
  } finally {
    for (const [name, value] of Object.entries(previous)) value === undefined ? delete process.env[name] : process.env[name] = value;
  }
}

test("final output streams descriptor-backed full and ranged GET responses", async (t) => {
  const { root } = await fixture();
  for (const [range, status, start, end] of [
    [undefined, 200, 0, MEDIA.length - 1],
    ["bytes=2-7", 206, 2, 7],
    ["ByTeS=2-7", 206, 2, 7],
    ["bytes=8-", 206, 8, MEDIA.length - 1],
    ["bytes=-5", 206, MEDIA.length - 5, MEDIA.length - 1],
  ]) {
    await t.test(range || "full", async () => {
      const response = await invoke(root, { range });
      assert.equal(response.status, status);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), MEDIA.subarray(start, end + 1));
      assert.equal(response.headers.get("content-length"), String(end - start + 1));
      assert.equal(response.headers.get("accept-ranges"), "bytes");
      assert.equal(response.headers.get("content-type"), "video/mp4");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      if (range) assert.equal(response.headers.get("content-range"), `bytes ${start}-${end}/${MEDIA.length}`);
    });
  }
});

test("HEAD ignores Range and mirrors full GET headers without a body", async () => {
  const { root } = await fixture();
  for (const options of [{ method: "HEAD" }, { method: "HEAD", range: "bytes=-4" }]) {
    const response = await invoke(root, options);
    assert.equal(response.status, 200);
    assert.equal((await response.arrayBuffer()).byteLength, 0);
    assert.equal(response.headers.get("content-length"), String(MEDIA.length));
    assert.equal(response.headers.get("content-range"), null);
  }
});

test("MIME and disposition are safe for MP4, SRT, JSON, unknown, and downloads", async () => {
  const fx = await fixture();
  const cases = [
    ["clip.mp4", "video/mp4", "inline"],
    ["captions.srt", "application/x-subrip; charset=utf-8", "inline"],
    ["manifest.json", "application/json; charset=utf-8", "inline"],
    ["payload.bin", "application/octet-stream", "attachment"],
  ];
  await writeFile(path.join(fx.edits, "captions.srt"), "captions");
  await writeFile(path.join(fx.edits, "manifest.json"), "{}");
  await writeFile(path.join(fx.edits, "payload.bin"), "unknown");
  for (const [filename, contentType, disposition] of cases) {
    const response = await invoke(fx.root, { segments: ["output", "edits", filename] });
    assert.equal(response.headers.get("content-type"), contentType);
    assert.equal(response.headers.get("content-disposition"), `${disposition}; filename="${filename}"`);
    await response.arrayBuffer();
  }
  const downloaded = await invoke(fx.root, { download: true });
  assert.equal(downloaded.headers.get("content-disposition"), "attachment; filename=\"clip.mp4\"");
  await downloaded.arrayBuffer();
});

test("invalid ranges close the descriptor and return 416 with exact size", async () => {
  const { root } = await fixture();
  for (const range of [`bytes=${MEDIA.length}-`, "bytes=0-1,3-4", "items=0-1", "bytes=-0"]) {
    const response = await invoke(root, { range });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get("content-range"), `bytes */${MEDIA.length}`);
    assert.equal(response.headers.get("content-length"), "0");
  }
});

test("final file route authenticates and enforces bounded output-only paths", async () => {
  const { root } = await fixture();
  assert.equal((await invoke(root, { authenticated: false })).status, 401);
  assert.equal((await invoke(root, { id: "../../etc/passwd" })).status, 400);
  for (const segments of [
    ["input", "source.mp4"],
    ["output", "..", "input", "source.mp4"],
    ["output", "bad/name.mp4"],
    ["output", "bad\\name.mp4"],
    ["output", "x".repeat(256)],
    ["output", ...Array.from({ length: 20 }, () => "x")],
  ]) assert.equal((await invoke(root, { segments })).status, 403);
});

test("symlinked job, output ancestor, and final component are rejected", async (t) => {
  await t.test("job", async () => {
    const fx = await fixture();
    const root = await mkdtemp(path.join(os.tmpdir(), "clipper-final-root-"));
    await symlink(path.join(fx.root, JOB_ID), path.join(root, JOB_ID));
    assert.equal((await invoke(root)).status, 404);
  });
  await t.test("ancestor", async () => {
    const fx = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), "clipper-final-out-"));
    await writeFile(path.join(outside, "clip.mp4"), MEDIA);
    await rm(fx.edits, { recursive: true });
    await symlink(outside, fx.edits);
    assert.equal((await invoke(fx.root)).status, 404);
  });
  await t.test("file", async () => {
    const fx = await fixture();
    const outside = path.join(await mkdtemp(path.join(os.tmpdir(), "clipper-final-out-")), "outside.mp4");
    await writeFile(outside, MEDIA);
    await rm(fx.target);
    await symlink(outside, fx.target);
    assert.equal((await invoke(fx.root)).status, 404);
  });
});

test("opened descriptor canonical containment rejects symlink-swap results", async () => {
  const { root } = await fixture();
  await assert.rejects(openFinalFile(JOB_ID, SEGMENTS, root, {
    resolveFdPath: async () => "/tmp/outside/swapped.mp4",
  }), FinalFileInvalidError);
});

test("descriptor closes exactly once on EOF, cancel, abort, error, HEAD, and construction failure", async (t) => {
  async function responseWithCounter(root, options = {}) {
    let closes = 0;
    const response = await finalFileResponse(request(options), JOB_ID, SEGMENTS, {
      head: options.method === "HEAD",
      jobsRoot: root,
      responseFactory: options.responseFactory,
      streamOptions: {
        createReadStream: options.createReadStream,
        closeFd: async (fd) => { closes += 1; await closeFd(fd); },
      },
    });
    return { response, closes: () => closes };
  }

  await t.test("EOF", async () => {
    const fx = await fixture();
    const result = await responseWithCounter(fx.root);
    await result.response.arrayBuffer();
    assert.equal(result.closes(), 1);
  });
  await t.test("cancel", async () => {
    const fx = await fixture();
    await writeFile(fx.target, Buffer.concat([MEDIA, Buffer.alloc(1024 * 1024)]));
    const result = await responseWithCounter(fx.root);
    const reader = result.response.body.getReader();
    await reader.read();
    await reader.cancel();
    assert.equal(result.closes(), 1);
  });
  await t.test("abort", async () => {
    const fx = await fixture();
    await writeFile(fx.target, Buffer.concat([MEDIA, Buffer.alloc(1024 * 1024)]));
    const controller = new AbortController();
    const result = await responseWithCounter(fx.root, { signal: controller.signal });
    const consuming = result.response.arrayBuffer();
    controller.abort();
    await assert.rejects(consuming, /abort/i);
    assert.equal(result.closes(), 1);
  });
  await t.test("read error", async () => {
    const fx = await fixture();
    const result = await responseWithCounter(fx.root, {
      createReadStream: () => new Readable({ read() { this.destroy(new Error("injected read failure")); } }),
    });
    await assert.rejects(result.response.arrayBuffer(), /injected read failure/);
    assert.equal(result.closes(), 1);
  });
  await t.test("HEAD", async () => {
    const fx = await fixture();
    const result = await responseWithCounter(fx.root, { method: "HEAD" });
    assert.equal(result.closes(), 1);
  });
  await t.test("read stream construction error", async () => {
    const fx = await fixture();
    let closes = 0;
    await assert.rejects(finalFileResponse(request(), JOB_ID, SEGMENTS, {
      jobsRoot: fx.root,
      streamOptions: {
        createReadStream: () => { throw new Error("injected stream construction failure"); },
        closeFd: async (fd) => { closes += 1; await closeFd(fd); },
      },
    }), /stream construction failure/);
    assert.equal(closes, 1);
  });
  await t.test("Response construction failure", async () => {
    const fx = await fixture();
    let closes = 0;
    await assert.rejects(finalFileResponse(request(), JOB_ID, SEGMENTS, {
      jobsRoot: fx.root,
      responseFactory: () => { throw new Error("injected construction failure"); },
      streamOptions: { closeFd: async (fd) => { closes += 1; await closeFd(fd); } },
    }), /construction failure/);
    assert.equal(closes, 1);
  });
});
