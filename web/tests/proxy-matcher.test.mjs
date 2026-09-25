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

test("every other protected path still runs the proxy", () => {
  for (const pathname of [
    "/dashboard", "/settings", "/projects/abc", "/api/jobs/abc", "/api/jobs/abc/files/output/clip-01.mp4",
    "/api/jobsx", "/api/settings/llm", "/api/llm/status", "/api/storage/status",
  ]) assert.equal(proxyRuns(pathname), true, pathname);
  for (const pathname of ["/api/health", "/api/auth/login", "/login"]) assert.equal(proxyRuns(pathname), false, pathname);
});
