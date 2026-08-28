import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { isAuthorized } from "../lib/auth.mjs";
import {
  atomicWriteJson,
  parseByteRange,
  parseJobOptions,
  safeJobFile,
  validateYouTubeUrl,
} from "../lib/jobs.mjs";

test("accepts supported render and numeric options", () => {
  assert.deepEqual(
    parseJobOptions({ renderMode: "fit-blur", limit: "3", minDuration: "20", maxDuration: "60" }),
    { renderMode: "fit-blur", limit: 3, minDuration: 20, maxDuration: 60 },
  );
});

test("rejects invalid render modes and duration ranges", () => {
  assert.throws(() => parseJobOptions({ renderMode: "stretch" }), /render mode/i);
  assert.throws(
    () => parseJobOptions({ renderMode: "fit-blur", minDuration: "80", maxDuration: "20" }),
    /duration/i,
  );
});

test("only accepts public YouTube hostnames", () => {
  assert.equal(validateYouTubeUrl("https://youtu.be/Ive926sC6mc"), true);
  assert.equal(validateYouTubeUrl("https://www.youtube.com/watch?v=Ive926sC6mc"), true);
  assert.equal(validateYouTubeUrl("https://youtube.com.evil.test/watch?v=x"), false);
  assert.equal(validateYouTubeUrl("file:///etc/passwd"), false);
});

test("job file paths cannot escape their job directory", () => {
  const root = "/data/jobs/123";
  assert.equal(safeJobFile(root, "output/clip-01.mp4"), "/data/jobs/123/output/clip-01.mp4");
  assert.throws(() => safeJobFile(root, "../../etc/passwd"), /unsafe/i);
});

test("atomic JSON publication leaves readable complete state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clipper-job-test-"));
  const target = path.join(root, "job.json");
  await atomicWriteJson(target, { status: "completed", clips: [1, 2] });
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), {
    status: "completed",
    clips: [1, 2],
  });
});

test("basic authentication fails closed and accepts exact credentials", () => {
  const env = { APP_USERNAME: "admin", APP_PASSWORD: "secret-value" };
  assert.equal(isAuthorized(new Request("http://local"), env), false);
  const headers = { Authorization: `Basic ${Buffer.from("admin:secret-value").toString("base64")}` };
  assert.equal(isAuthorized(new Request("http://local", { headers }), env), true);
  assert.equal(isAuthorized(new Request("http://local", { headers }), {}), false);
});

test("byte ranges are validated and clamped", () => {
  assert.deepEqual(parseByteRange("bytes=100-199", 1000), { start: 100, end: 199 });
  assert.deepEqual(parseByteRange("bytes=900-", 1000), { start: 900, end: 999 });
  assert.deepEqual(parseByteRange("bytes=-100", 1000), { start: 900, end: 999 });
  assert.throws(() => parseByteRange("bytes=1000-1200", 1000), /range/i);
});
