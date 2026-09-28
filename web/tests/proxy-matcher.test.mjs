import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { config } from "../proxy.js";

// Compile the matcher with Next's own code, in a child process: Next's server internals refuse
// to load next to the ESM `next/server` import that proxy.js pulls in.
const matchers = JSON.parse(execFileSync(process.execPath, ["-e", `
  const { getMiddlewareMatchers } = require("next/dist/build/analysis/get-page-static-info.js");
  process.stdout.write(JSON.stringify(getMiddlewareMatchers(JSON.parse(process.argv[1]), { i18n: null, basePath: "" })));
`, JSON.stringify(config.matcher)], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" }));

function proxyRuns(pathname) {
  return matchers.some((matcher) => new RegExp(matcher.regexp).test(pathname));
}

test("the job upload route bypasses the proxy so its body is streamed, not buffered at 10 MB", () => {
  // With a proxy in front, Next buffers the request body up to proxyClientMaxBodySize (10 MB)
  // and hands the route a truncated body; video uploads then fail as invalid requests.
  assert.equal(proxyRuns("/api/jobs"), false);
  assert.equal(proxyRuns("/api/jobs/"), false);
});

test("the agent ingest route bypasses the proxy: it authenticates with its own bearer token", () => {
  // The proxy only knows the session cookie; the ingest route refuses cookies and checks a
  // ptk_ token itself, and reads its (256 KiB) body unbuffered.
  assert.equal(proxyRuns("/api/ingest/trends"), false);
  assert.equal(proxyRuns("/api/ingest/trends/"), false);
});

const JOB = "8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55";
const SHA = "ab".repeat(32);

test("the Editor V3 asset upload route bypasses the proxy: logos up to 10 MB, music up to 50 MB", () => {
  // POST /api/jobs/:id/assets streams the raw body into the quarantine with its own cap; behind
  // the proxy Next would buffer it at 10 MB and hand the route a truncated body. The route
  // checks the session itself (requireAuth + sameOriginMutation), like POST /api/jobs.
  assert.equal(proxyRuns(`/api/jobs/${JOB}/assets`), false);
  assert.equal(proxyRuns(`/api/jobs/${JOB}/assets/`), false);
});

test("serving an asset and every other job route still runs the proxy", () => {
  for (const pathname of [
    `/api/jobs/${JOB}/assets/${SHA}`, `/api/jobs/${JOB}/assets/${SHA}/`, `/api/jobs/${JOB}/assetsx`,
    `/api/jobs/${JOB}/assets/x/y`, `/api/jobs/${JOB}/x/assets`, `/api/jobs/a/b/assets`, `/api/jobs/${JOB}`,
    `/api/jobs/${JOB}/clips`, `/api/jobs/${JOB}/clips/clip_62654c2c2fa04f125391464a/edit`,
    `/api/jobs/${JOB}/renders/${JOB}`, `/api/jobs/${JOB}/files/output/clip-01.mp4`, "/api/jobs/assets/x",
    `/projects/${JOB}/assets`, `/api/assets`, `/api/jobs//assets`,
  ]) assert.equal(proxyRuns(pathname), true, pathname);
});

test("every other protected path still runs the proxy", () => {
  for (const pathname of [
    "/dashboard", "/settings", "/projects/abc", "/api/jobs/abc", "/api/jobs/abc/files/output/clip-01.mp4",
    "/api/jobsx", "/api/settings/llm", "/api/llm/status", "/api/storage/status",
    "/trends", "/api/ingest", "/api/ingest/", "/api/ingest/trendsx", "/api/ingest/trends/abc", "/api/ingest/other",
    "/api/context/trends", "/api/context/trends/abc", "/api/context/trends/settings", "/api/context/tokens",
    "/api/context/tokens/abc", "/api/ingest/trends.json",
  ]) assert.equal(proxyRuns(pathname), true, pathname);
  for (const pathname of ["/api/health", "/api/auth/login", "/login"]) assert.equal(proxyRuns(pathname), false, pathname);
});

test("the matcher excludes exactly the listed routes", () => {
  // One entry per exclusion; a new one needs its own test above (the route must authenticate
  // every request itself).
  const [matcher] = config.matcher;
  const excluded = /^\/\(\(\?!(.*)\)\.\*\)$/.exec(matcher)[1].split("|");
  assert.deepEqual(excluded, [
    "api/health", "api/auth/login", "api/jobs/?$", "api/jobs/[^/]+/assets/?$", "api/ingest/trends/?$", "login",
    "_next/static", "_next/image", "favicon.ico",
  ]);
});
