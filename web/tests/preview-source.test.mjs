import assert from "node:assert/strict";
import { close } from "node:fs";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";

import { createSessionToken } from "../lib/auth.mjs";
import { GET, HEAD } from "../app/api/jobs/[id]/preview-source/route.js";
import { PreviewInvalidError, openPreviewSource, previewResponse } from "../lib/preview-source.mjs";

const JOB_ID = "123e4567-e89b-42d3-a456-426614174000";
const AUTH_ENV = {
  APP_USERNAME: "admin",
  APP_PASSWORD: "secret-value",
  APP_SESSION_SECRET: "a-long-random-session-secret-value",
};
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom0123456789abcdef")]);
const closeFd = promisify(close);

async function fixture(extension = ".mp4") {
  const root = await mkdtemp(path.join(os.tmpdir(), "clipper-preview-"));
  const job = path.join(root, JOB_ID);
  const input = path.join(job, "input");
  await mkdir(input, { recursive: true });
  const sourcePath = path.join(input, `source${extension}`);
  await writeFile(sourcePath, MP4);
  await writeFile(path.join(job, "job.json"), JSON.stringify({ id: JOB_ID, sourcePath }));
  return { root, job, input, sourcePath };
}

function request({ method = "GET", range, authenticated = true, signal } = {}) {
  const headers = {};
  if (range) headers.Range = range;
  if (authenticated) headers.Cookie = `potongin_session=${createSessionToken(AUTH_ENV, 2_000_000_000)}`;
  return new Request(`http://local/api/jobs/${JOB_ID}/preview-source`, { method, headers, signal });
}

async function invoke(root, options = {}) {
  const previous = {};
  for (const name of ["JOBS_ROOT", ...Object.keys(AUTH_ENV)]) previous[name] = process.env[name];
  Object.assign(process.env, AUTH_ENV, { JOBS_ROOT: root });
  try {
    const handler = options.method === "HEAD" ? HEAD : GET;
    return await handler(request(options), { params: Promise.resolve({ id: options.id || JOB_ID }) });
  } finally {
    for (const [name, value] of Object.entries(previous)) value === undefined ? delete process.env[name] : process.env[name] = value;
  }
}

test("authenticated preview streams full source with private fixed headers", async () => {
  const { root, sourcePath } = await fixture();
  const response = await invoke(root);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), MP4);
  assert.equal(response.headers.get("content-length"), String(MP4.length));
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("content-type"), "video/mp4");
  assert.equal(response.headers.get("content-disposition"), 'inline; filename="source.mp4"');
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(JSON.stringify([...response.headers]), JSON.stringify([...response.headers]).replaceAll(sourcePath, ""));
});

test("single, open-ended, and suffix byte ranges return descriptor-backed 206", async (t) => {
  const { root } = await fixture();
  for (const [range, start, end] of [["bytes=2-7", 2, 7], ["bytes=8-", 8, MP4.length - 1], ["bytes=-5", MP4.length - 5, MP4.length - 1]]) {
    await t.test(range, async () => {
      const response = await invoke(root, { range });
      assert.equal(response.status, 206);
      assert.equal(response.headers.get("content-range"), `bytes ${start}-${end}/${MP4.length}`);
      assert.equal(response.headers.get("content-length"), String(end - start + 1));
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), MP4.subarray(start, end + 1));
    });
  }
});

test("HEAD mirrors GET and range headers but never has a body", async () => {
  const { root } = await fixture();
  for (const options of [{ method: "HEAD" }, { method: "HEAD", range: "bytes=-4" }]) {
    const response = await invoke(root, options);
    assert.equal(response.status, options.range ? 206 : 200);
    assert.equal((await response.arrayBuffer()).byteLength, 0);
    assert.equal(response.headers.get("content-length"), options.range ? "4" : String(MP4.length));
  }
});

test("unsatisfiable and multiple ranges return 416 with size", async () => {
  const { root } = await fixture();
  for (const range of [`bytes=${MP4.length}-`, "bytes=0-1,3-4", "items=0-1", "bytes=-0"]) {
    const response = await invoke(root, { range });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get("content-range"), `bytes */${MP4.length}`);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
});

test("preview authenticates and validates UUID before filesystem access", async () => {
  const { root } = await fixture();
  assert.equal((await invoke(root, { authenticated: false })).status, 401);
  assert.equal((await invoke(root, { id: "../../etc/passwd" })).status, 400);
});

test("job, job.json, input, and source symlinks are rejected", async (t) => {
  await t.test("job directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "clipper-preview-root-"));
    const outside = (await fixture()).job;
    await symlink(outside, path.join(root, JOB_ID));
    assert.equal((await invoke(root)).status, 404);
  });
  for (const targetName of ["job.json", "input", "source.mp4"]) {
    await t.test(targetName, async () => {
      const fx = await fixture();
      const outside = path.join(await mkdtemp(path.join(os.tmpdir(), "clipper-preview-out-")), targetName.replaceAll("/", "-"));
      if (targetName === "input") await mkdir(outside); else await writeFile(outside, targetName === "job.json" ? JSON.stringify({ id: JOB_ID, sourcePath: fx.sourcePath }) : MP4);
      const target = targetName === "source.mp4" ? fx.sourcePath : path.join(fx.job, targetName);
      await (await import("node:fs/promises")).rm(target, { recursive: true });
      await symlink(outside, target);
      assert.equal((await invoke(fx.root)).status, targetName === "job.json" ? 404 : 422);
    });
  }
});

test("private sourcePath must name a regular allowlisted video under input", async () => {
  for (const mutate of [
    async (fx) => writeFile(path.join(fx.job, "job.json"), JSON.stringify({ id: JOB_ID, sourcePath: "/etc/passwd" })),
    async (fx) => { const target = path.join(fx.input, "source.txt"); await writeFile(target, MP4); await writeFile(path.join(fx.job, "job.json"), JSON.stringify({ id: JOB_ID, sourcePath: target })); },
    async (fx) => writeFile(fx.sourcePath, Buffer.from("not a media container")),
  ]) {
    const fx = await fixture();
    await mutate(fx);
    assert.equal((await invoke(fx.root)).status, 422);
  }
});

test("m4v ISO BMFF sources are previewed with a consistent video MIME type", async () => {
  const { root } = await fixture(".m4v");
  const response = await invoke(root);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "video/x-m4v");
  assert.equal(response.headers.get("content-disposition"), 'inline; filename="source.m4v"');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), MP4);
});

test("job JSON is strict UTF-8 with unique keys and exact requested identity", async (t) => {
  const cases = [
    ["duplicate id", `{"id":"${JOB_ID}","id":"${JOB_ID}","sourcePath":"SOURCE"}`],
    ["duplicate sourcePath", `{"id":"${JOB_ID}","sourcePath":"SOURCE","sourcePath":"SOURCE"}`],
    ["mismatched id", `{"id":"00000000-0000-4000-8000-000000000000","sourcePath":"SOURCE"}`],
    ["non-finite number", `{"id":"${JOB_ID}","sourcePath":"SOURCE","legacy":1e999}`],
  ];
  for (const [name, template] of cases) {
    await t.test(name, async () => {
      const fx = await fixture();
      await writeFile(path.join(fx.job, "job.json"), template.replaceAll("SOURCE", fx.sourcePath));
      assert.equal((await invoke(fx.root)).status, 422);
    });
  }
  await t.test("invalid UTF-8", async () => {
    const fx = await fixture();
    await writeFile(path.join(fx.job, "job.json"), Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]));
    assert.equal((await invoke(fx.root)).status, 422);
  });
  await t.test("unknown evolving fields remain compatible", async () => {
    const fx = await fixture();
    await writeFile(path.join(fx.job, "job.json"), JSON.stringify({ id: JOB_ID, sourcePath: fx.sourcePath, future: { nested: true } }));
    const response = await invoke(fx.root);
    assert.equal(response.status, 200);
    await response.body.cancel();
  });
});

test("opened descriptor realpath containment is authoritative against ancestor races", async () => {
  const { root } = await fixture();
  let calls = 0;
  await assert.rejects(openPreviewSource(JOB_ID, root, {
    resolveFdPath: async (fd) => {
      calls += 1;
      return calls === 1
        ? path.join(root, JOB_ID, "job.json")
        : "/tmp/outside/source.mp4";
    },
  }), PreviewInvalidError);
});

test("descriptor stream closes exactly once on consume, cancel, abort, and read error", async (t) => {
  async function responseWithCounter(root, signal, streamOptions = {}) {
    let closes = 0;
    const response = await previewResponse(request({ signal }), JOB_ID, {
      jobsRoot: root,
      streamOptions: {
        ...streamOptions,
        closeFd: async (fd) => {
          closes += 1;
          await closeFd(fd);
        },
      },
    });
    return { response, closes: () => closes };
  }

  await t.test("full consume", async () => {
    const { root } = await fixture();
    const result = await responseWithCounter(root);
    assert.deepEqual(Buffer.from(await result.response.arrayBuffer()), MP4);
    assert.equal(result.closes(), 1);
  });
  await t.test("consumer cancel", async () => {
    const fx = await fixture();
    await writeFile(fx.sourcePath, Buffer.concat([MP4, Buffer.alloc(1024 * 1024)]));
    const result = await responseWithCounter(fx.root);
    const reader = result.response.body.getReader();
    await reader.read();
    await reader.cancel();
    assert.equal(result.closes(), 1);
  });
  await t.test("already aborted", async () => {
    const { root } = await fixture();
    const controller = new AbortController();
    controller.abort();
    const result = await responseWithCounter(root, controller.signal);
    await assert.rejects(result.response.arrayBuffer(), /abort/i);
    assert.equal(result.closes(), 1);
  });
  await t.test("abort while consuming", async () => {
    const fx = await fixture();
    await writeFile(fx.sourcePath, Buffer.concat([MP4, Buffer.alloc(1024 * 1024)]));
    const controller = new AbortController();
    const result = await responseWithCounter(fx.root, controller.signal);
    const consuming = result.response.arrayBuffer();
    controller.abort();
    await assert.rejects(consuming, /abort/i);
    assert.equal(result.closes(), 1);
  });
  await t.test("read error", async () => {
    const { root } = await fixture();
    const result = await responseWithCounter(root, undefined, {
      createReadStream: () => new Readable({ read() { this.destroy(new Error("injected read failure")); } }),
    });
    await assert.rejects(result.response.arrayBuffer(), /injected read failure/);
    assert.equal(result.closes(), 1);
  });
  await t.test("abort and reader failure race settles only once", async () => {
    const fx = await fixture();
    await writeFile(fx.sourcePath, Buffer.concat([MP4, Buffer.alloc(1024 * 1024)]));
    const unhandled = [];
    const onUnhandled = (error) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    try {
      for (let index = 0; index < 20; index += 1) {
        const controller = new AbortController();
        const result = await responseWithCounter(fx.root, controller.signal);
        const consuming = result.response.arrayBuffer();
        queueMicrotask(() => controller.abort());
        await assert.rejects(consuming, /abort/i);
        assert.equal(result.closes(), 1);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
  await t.test("twenty cancellation loops", async () => {
    const fx = await fixture();
    await writeFile(fx.sourcePath, Buffer.concat([MP4, Buffer.alloc(1024 * 1024)]));
    for (let index = 0; index < 20; index += 1) {
      const result = await responseWithCounter(fx.root);
      await result.response.body.cancel();
      assert.equal(result.closes(), 1);
    }
  });
  await t.test("Response construction exception", async () => {
    const { root } = await fixture();
    let closes = 0;
    await assert.rejects(previewResponse(request(), JOB_ID, {
      jobsRoot: root,
      responseFactory: () => { throw new Error("injected Response construction failure"); },
      streamOptions: {
        closeFd: async (fd) => {
          closes += 1;
          await closeFd(fd);
        },
      },
    }), /Response construction failure/);
    assert.equal(closes, 1);
  });
});
