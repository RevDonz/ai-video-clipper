import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { POST as login } from "../app/api/auth/login/route.js";
import { POST as logout } from "../app/api/auth/logout/route.js";
import {
  authenticateCredentials,
  createSessionToken,
  isAuthorized,
  sessionCookie,
  verifySessionToken,
} from "../lib/auth.mjs";
import {
  atomicWriteJson,
  enrichJobSocialMetadata,
  generateSocialMetadata,
  parseByteRange,
  parseJobOptions,
  parseWorkerProgress,
  safeJobFile,
  sortJobsNewest,
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

test("project history is sorted newest first without dropping old jobs", () => {
  const jobs = [
    { id: "old", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "new", createdAt: "2026-03-01T00:00:00.000Z" },
    { id: "middle", createdAt: "2026-02-01T00:00:00.000Z" },
  ];
  assert.deepEqual(sortJobsNewest(jobs).map((job) => job.id), ["new", "middle", "old"]);
  assert.deepEqual(jobs.map((job) => job.id), ["old", "new", "middle"]);
});

test("worker progress events are parsed safely and reject unrelated output", () => {
  assert.deepEqual(
    parseWorkerProgress('POTONGIN_PROGRESS {"progress":67,"stage":"rendering","detail":"Render klip 1 dari 3"}'),
    { progress: 67, stage: "rendering", detail: "Render klip 1 dari 3" },
  );
  assert.equal(parseWorkerProgress("ffmpeg version 7"), null);
  assert.equal(parseWorkerProgress('POTONGIN_PROGRESS {"progress":999}'), null);
});

test("AI social metadata derives a concise hook and caption from clip content", () => {
  const metadata = generateSocialMetadata(
    "Banyak orang tidak sadar kalau konsistensi jauh lebih penting daripada motivasi. "
      + "Motivasi bisa hilang, tetapi kebiasaan membuat kita tetap bergerak setiap hari.",
  );
  assert.match(metadata.title, /konsistensi|motivasi/i);
  assert.ok(metadata.title.length <= 72);
  assert.match(metadata.description, /konsistensi|motivasi/i);
  assert.match(metadata.description, /#fyp/i);
  assert.ok(metadata.hashtags.length >= 4);
  assert.ok(metadata.hashtags.some((tag) => /konsistensi|motivasi/i.test(tag)));
});

test("AI social metadata stays useful for empty or noisy transcripts", () => {
  const metadata = generateSocialMetadata("  ...  ");
  assert.equal(metadata.title, "Momen Pilihan dari Video Ini");
  assert.match(metadata.description, /sampai akhir/i);
});

test("AI social metadata turns noisy speech into a clean topic hook", () => {
  const metadata = generateSocialMetadata(
    "Pip-pip boom setutu-tutu di belakang saya ini hasil dari sepeda custom yang baru selesai dibuat dan bisa digunakan untuk perjalanan jauh dengan berbagai aksesori tambahan yang sedang diperlihatkan kepada penonton.",
  );
  assert.match(metadata.title, /sepeda/i);
  assert.doesNotMatch(metadata.title, /pip|setutu/i);
});

test("old social metadata is regenerated when its version is stale", () => {
  const job = enrichJobSocialMetadata({
    clips: [{ text: "Cerita sepeda custom yang menarik", title: "Judul lama", description: "Lama", hashtags: ["#old"] }],
  });
  assert.notEqual(job.clips[0].title, "Judul lama");
  assert.equal(job.clips[0].metadataVersion, 5);
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
  const cookie = sessionCookie(token, Date.UTC(2026, 0, 1));
  assert.match(cookie, /Max-Age=2592000/);
  assert.match(cookie, /Expires=Sat, 31 Jan 2026 00:00:00 GMT/);
});

test("login form exposes password-manager compatible semantics", async () => {
  const source = await readFile(new URL("../app/login/page.jsx", import.meta.url), "utf8");
  assert.match(source, /autoComplete="on"/);
  assert.match(source, /name="username"[^>]+autoComplete="username"/);
  assert.match(source, /name="password"[^>]+autoComplete="current-password"/);
});

test("public landing and protected dashboard use separate routes", async () => {
  const landing = await readFile(new URL("../app/page.jsx", import.meta.url), "utf8");
  const dashboard = await readFile(new URL("../app/dashboard/page.jsx", import.meta.url), "utf8");
  const proxySource = await readFile(new URL("../proxy.js", import.meta.url), "utf8");
  assert.match(landing, /LandingPage/);
  assert.match(landing, /href="\/dashboard"/);
  assert.match(dashboard, /DashboardPage/);
  assert.match(dashboard, /fetch\("\/api\/jobs"/);
  assert.match(dashboard, /role="progressbar"/);
  assert.match(dashboard, /aria-live="polite"/);
  assert.match(proxySource, /pathname === "\/"/);
});

test("auth redirects stay on the public origin behind a reverse proxy", async () => {
  const previous = {
    APP_USERNAME: process.env.APP_USERNAME,
    APP_PASSWORD: process.env.APP_PASSWORD,
    APP_SESSION_SECRET: process.env.APP_SESSION_SECRET,
  };
  process.env.APP_USERNAME = "admin";
  process.env.APP_PASSWORD = "secret-value";
  process.env.APP_SESSION_SECRET = "a-long-random-session-secret-value";
  try {
    const validForm = new FormData();
    validForm.set("username", "admin");
    validForm.set("password", "secret-value");
    validForm.set("next", "/jobs?filter=done");
    const valid = await login(new Request("http://0.0.0.0:3000/api/auth/login", {
      method: "POST",
      body: validForm,
    }));
    assert.equal(valid.status, 303);
    assert.equal(valid.headers.get("location"), "/jobs?filter=done");

    const defaultForm = new FormData();
    defaultForm.set("username", "admin");
    defaultForm.set("password", "secret-value");
    const defaultLogin = await login(new Request("http://0.0.0.0:3000/api/auth/login", {
      method: "POST",
      body: defaultForm,
    }));
    assert.equal(defaultLogin.headers.get("location"), "/dashboard");

    const maliciousForm = new FormData();
    maliciousForm.set("username", "admin");
    maliciousForm.set("password", "secret-value");
    maliciousForm.set("next", "/\\evil.example");
    const malicious = await login(new Request("http://0.0.0.0:3000/api/auth/login", {
      method: "POST",
      body: maliciousForm,
    }));
    assert.equal(malicious.headers.get("location"), "/dashboard");

    const invalidForm = new FormData();
    invalidForm.set("username", "admin");
    invalidForm.set("password", "wrong");
    const invalid = await login(new Request("http://0.0.0.0:3000/api/auth/login", {
      method: "POST",
      body: invalidForm,
    }));
    assert.equal(invalid.headers.get("location"), "/login?error=1");

    const loggedOut = await logout();
    assert.equal(loggedOut.headers.get("location"), "/login");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("byte ranges are validated and clamped", () => {
  assert.deepEqual(parseByteRange("bytes=100-199", 1000), { start: 100, end: 199 });
  assert.deepEqual(parseByteRange("bytes=900-", 1000), { start: 900, end: 999 });
  assert.deepEqual(parseByteRange("bytes=-100", 1000), { start: 900, end: 999 });
  assert.throws(() => parseByteRange("bytes=1000-1200", 1000), /range/i);
});
