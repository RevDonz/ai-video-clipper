import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  authenticateCredentials,
  createSessionToken,
  isAuthorized,
  verifySessionToken,
} from "../lib/auth.mjs";
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

test("session authentication persists with a signed cookie and fails closed", () => {
  const env = {
    APP_USERNAME: "admin",
    APP_PASSWORD: "secret-value",
    APP_SESSION_SECRET: "a-long-random-session-secret-value",
  };
  assert.equal(authenticateCredentials("admin", "secret-value", env), true);
  assert.equal(authenticateCredentials("admin", "wrong", env), false);
  const token = createSessionToken(env, 1_000);
  assert.equal(verifySessionToken(token, env, 1_001), true);
  assert.equal(verifySessionToken(`${token}tampered`, env, 1_001), false);
  assert.equal(verifySessionToken(token, env, 1_000 + 31 * 24 * 60 * 60), false);
  const headers = { Cookie: `potongin_session=${token}` };
  assert.equal(isAuthorized(new Request("http://local", { headers }), env, 1_001), true);
  assert.equal(isAuthorized(new Request("http://local"), env, 1_001), false);
  assert.equal(isAuthorized(new Request("http://local", { headers }), {}, 1_001), false);
});

test("byte ranges are validated and clamped", () => {
  assert.deepEqual(parseByteRange("bytes=100-199", 1000), { start: 100, end: 199 });
  assert.deepEqual(parseByteRange("bytes=900-", 1000), { start: 900, end: 999 });
  assert.deepEqual(parseByteRange("bytes=-100", 1000), { start: 900, end: 999 });
  assert.throws(() => parseByteRange("bytes=1000-1200", 1000), /range/i);
});
