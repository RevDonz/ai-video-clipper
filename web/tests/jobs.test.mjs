import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { POST as login } from "../app/api/auth/login/route.js";
import { POST as logout } from "../app/api/auth/logout/route.js";
import { parseJobFormOptions } from "../app/api/jobs/route.js";
import { proxy } from "../proxy.js";
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
  sanitizeSelectionV2Summary,
  serializePublicJob,
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

test("old job requests preserve their exact V1 option shape", () => {
  assert.deepEqual(
    parseJobOptions({ renderMode: "fit-blur", limit: "3", minDuration: "20", maxDuration: "60" }),
    { renderMode: "fit-blur", limit: 3, minDuration: 20, maxDuration: 60 },
  );
});

test("V2 shadow options are strict, bounded, and default safely", () => {
  assert.deepEqual(parseJobOptions({ selectionMode: "v2-shadow", clipProfile: "deep-dive" }), {
    renderMode: "fit-blur", limit: 5, minDuration: 20, maxDuration: 60,
    selectionMode: "v2-shadow", clipProfile: "deep-dive",
    maxCandidates: 200, maxMediaCandidates: 12, mediaTimeout: 30,
  });
  for (const input of [
    { selectionMode: "v2" }, { selectionMode: true },
    { selectionMode: "v2-shadow", clipProfile: "viral" },
    { selectionMode: "v2-shadow", clipProfile: false },
    { selectionMode: "v2-shadow", maxCandidates: 5001 },
    { selectionMode: "v2-shadow", maxCandidates: true },
    { selectionMode: "v2-shadow", maxCandidates: 10, maxMediaCandidates: 11 },
    { selectionMode: "v2-shadow", maxMediaCandidates: 101 },
    { selectionMode: "v2-shadow", mediaTimeout: 0 },
    { selectionMode: "v2-shadow", mediaTimeout: 301 },
    { selectionMode: "v2-shadow", mediaTimeout: true },
  ]) assert.throws(() => parseJobOptions(input));
});

test("public old jobs advertise V1 without leaking sourcePath", () => {
  const result = serializePublicJob({
    id: "old", sourcePath: "/data/jobs/old/input/source.mp4",
    options: { renderMode: "fit-blur", limit: 3, minDuration: 20, maxDuration: 60 }, clips: [],
  });
  assert.equal(result.sourcePath, undefined);
  assert.equal(result.options.selectionMode, "v1");
  assert.equal(result.options.renderMode, "fit-blur");
});

test("public jobs re-sanitize Selection V2 summaries and omit invalid values", () => {
  const raw = {
    mode: "v2-shadow", status: "failed", analysis_id: "0123456789abcdef0123456789abcdef",
    selection_version: "selection-v2.0", candidate_count: 0,
    artifact: "analysis/candidates.v2.json", warnings: ["artifact_archive_failed"],
    error: "shadow_failed", sourcePath: "/private/source.mp4", nested: { secret: "raw-secret" },
  };
  const expected = {
    mode: "v2-shadow", status: "failed", analysis_id: "0123456789abcdef0123456789abcdef",
    selection_version: "selection-v2.0", candidate_count: 0,
    artifact: "analysis/candidates.v2.json", warnings: ["artifact_archive_failed"], error: "shadow_failed",
  };
  assert.deepEqual(sanitizeSelectionV2Summary(raw), expected);
  const failedWithoutError = { ...raw };
  const expectedWithoutError = { ...expected };
  delete failedWithoutError.error;
  delete expectedWithoutError.error;
  assert.deepEqual(sanitizeSelectionV2Summary(failedWithoutError), expectedWithoutError);
  const publicJob = serializePublicJob({ id: "safe", options: {}, clips: [], selectionV2: raw, selection_v2: raw });
  assert.deepEqual(publicJob.selectionV2, expected);
  assert.equal(publicJob.selection_v2, undefined);
  assert.doesNotMatch(JSON.stringify(publicJob), /private|raw-secret/);

  const invalid = serializePublicJob({
    id: "invalid", options: {}, clips: [], selectionV2: { ...raw, warnings: ["secret=leak"] },
  });
  assert.equal(invalid.selectionV2, undefined);
  assert.doesNotMatch(JSON.stringify(invalid), /secret|leak/);
});

test("job API form parsing leaves old payloads exact and accepts explicit shadow mode", () => {
  const form = new FormData();
  form.set("renderMode", "fit-blur");
  form.set("limit", "3");
  form.set("minDuration", "20");
  form.set("maxDuration", "60");
  assert.deepEqual(parseJobFormOptions(form), {
    renderMode: "fit-blur", limit: 3, minDuration: 20, maxDuration: 60,
  });

  form.set("selectionMode", "v2-shadow");
  form.set("clipProfile", "standard");
  assert.deepEqual(parseJobFormOptions(form), {
    renderMode: "fit-blur", limit: 3, minDuration: 20, maxDuration: 60,
    selectionMode: "v2-shadow", clipProfile: "standard",
    maxCandidates: 200, maxMediaCandidates: 12, mediaTimeout: 30,
  });
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

test("byte ranges reject unsafe integer overflow instead of rounding", () => {
  assert.throws(() => parseByteRange("bytes=9007199254740992-9007199254740993", Number.MAX_SAFE_INTEGER), /invalid byte range/i);
  assert.throws(() => parseByteRange("bytes=0-9007199254740992", 100), /invalid byte range/i);
  assert.throws(() => parseByteRange("bytes=-9007199254740992", 100), /invalid byte range/i);
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
  assert.deepEqual(
    parseWorkerProgress('POTONGIN_PROGRESS {"progress":60,"stage":"candidates_ready","detail":"Kandidat bayangan V2 siap"}'),
    { progress: 60, stage: "candidates_ready", detail: "Kandidat bayangan V2 siap" },
  );
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
  assert.match(dashboard, /Experimental Selection V2 shadow/);
  assert.match(dashboard, /V1 tetap merender/);
  assert.match(dashboard, /data\.set\("selectionMode", "v2-shadow"\)/);
  assert.match(proxySource, /pathname === "\/"/);
});

test("proxy API authentication failures are explicitly non-cacheable", async () => {
  const response = proxy({
    headers: new Headers(),
    nextUrl: new URL("http://local/api/jobs/00000000-0000-4000-8000-000000000000"),
  });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("cache-control"), "no-store");
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
