import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, readFile } from "node:fs/promises";
import { test } from "node:test";

const originalEnv = { ...process.env };

async function importFresh(path, env = {}) {
  process.env = { ...originalEnv, ...env };
  for (const key of [
    "CI", "E2E_ALLOW_SKIP", "E2E_USERNAME", "E2E_PASSWORD", "E2E_JOB_ID", "E2E_BASE_URL", "E2E_WORKERS",
  ]) {
    if (!(key in env)) delete process.env[key];
  }
  try {
    return await import(`${path}?test=${Date.now()}-${Math.random()}`);
  } finally {
    process.env = { ...originalEnv };
  }
}

// A page whose in-page fetch answers from `routes` (path -> [status, body]).
function fakePage(routes) {
  const calls = [];
  return {
    calls,
    evaluate: async (callback, path) => {
      calls.push(path);
      const [status, body] = routes[path] || [404, { error: "missing" }];
      const fetch = async () => ({ status, json: async () => body });
      const previous = globalThis.fetch;
      globalThis.fetch = fetch;
      try {
        return await callback(path);
      } finally {
        globalThis.fetch = previous;
      }
    },
  };
}

test("the read-only target is the newest completed project with clips", async () => {
  const { resolveTarget } = await importFresh("../e2e/support/harness.mjs", {
    E2E_USERNAME: "user", E2E_PASSWORD: "secret",
  });
  const page = fakePage({ "/api/jobs": [200, { jobs: [
    { id: "running", status: "processing", clips: [] },
    { id: "empty", status: "completed", clips: [] },
    { id: "done", status: "completed", clips: [{ index: 1 }, { index: 2 }] },
    { id: "older", status: "completed", clips: [{ index: 1 }] },
  ] }] });
  assert.deepEqual(await resolveTarget(page), { jobId: "done", clipCount: 2 });
  assert.deepEqual(page.calls, ["/api/jobs"], "no candidate request");
});

test("a pinned project is used as is, and failures are never read as 'no project'", async () => {
  const { resolveTarget } = await importFresh("../e2e/support/harness.mjs", {
    E2E_USERNAME: "user", E2E_PASSWORD: "secret", E2E_JOB_ID: "older",
  });
  const jobs = { jobs: [{ id: "done", status: "completed", clips: [{ index: 1 }] }, { id: "older", status: "completed", clips: [{ index: 1 }] }] };
  assert.deepEqual(await resolveTarget(fakePage({ "/api/jobs": [200, jobs] })), { jobId: "older", clipCount: 1 });
  await assert.rejects(resolveTarget(fakePage({ "/api/jobs": [200, { jobs: [] }] })), /E2E_JOB_ID older is not in the project list/);
  await assert.rejects(resolveTarget(fakePage({ "/api/jobs": [401, { error: "expired" }] })), /returned 401.*expired/);
  await assert.rejects(resolveTarget(fakePage({ "/api/jobs": [503, { error: "backend unavailable" }] })), /returned 503/);
});

test("media diagnostics ignore only browser-cancelled GET media requests", async () => {
  const { captureFailures } = await importFresh("../e2e/support/harness.mjs", {
    E2E_USERNAME: "user", E2E_PASSWORD: "secret",
  });
  const page = new EventEmitter();
  const request = (url, type = "media", method = "GET", reason = "net::ERR_ABORTED") => ({
    url: () => url, resourceType: () => type, method: () => method,
    failure: () => ({ errorText: reason }),
  });
  const failures = captureFailures(page);
  const mediaUrl = "https://site/api/jobs/1/files/output/clip-01.mp4";

  page.emit("requestfailed", request(mediaUrl));
  page.emit("requestfailed", request("https://site/api/jobs/1", "fetch"));
  page.emit("requestfailed", request(mediaUrl, "media", "POST"));
  page.emit("requestfailed", request(mediaUrl, "media", "GET", "net::ERR_FAILED"));

  assert.deepEqual(failures.requests, [
    "GET https://site/api/jobs/1 net::ERR_ABORTED",
    `POST ${mediaUrl} net::ERR_ABORTED`,
    `GET ${mediaUrl} net::ERR_FAILED`,
  ]);
});

test("credential preflight fails closed except explicit local safe-skip", async () => {
  await assert.rejects(
    importFresh("../playwright.config.mjs"),
    /E2E_USERNAME.*E2E_PASSWORD.*E2E_ALLOW_SKIP=1/s,
  );
  const local = await importFresh("../playwright.config.mjs", { E2E_ALLOW_SKIP: "1" });
  assert.equal(local.default.retries, 0);
  await assert.rejects(
    importFresh("../playwright.config.mjs", { CI: "1", E2E_ALLOW_SKIP: "1" }),
    /credentials are required in CI/i,
  );
});

test("config disables credential-bearing artifacts and gives mobile read-only coverage", async () => {
  const { default: config } = await importFresh("../playwright.config.mjs", {
    E2E_USERNAME: "user", E2E_PASSWORD: "secret", CI: "1",
  });
  assert.equal(config.retries, 0);
  assert.equal(config.use.trace, "off");
  assert.equal(config.use.screenshot, "off");
  assert.equal(config.use.video, "off");
  assert.equal(config.preserveOutput, "never");
  const mobile = config.projects.find((project) => project.name === "mobile-chromium");
  assert.match(String(mobile.testMatch), /read-only/);
  assert.match(String(mobile.testMatch), /smoke/);
});

test("worker concurrency is bounded, remote-safe by default, and fixed at one in CI", async () => {
  const credentials = { E2E_USERNAME: "user", E2E_PASSWORD: "secret" };
  const remote = await importFresh("../playwright.config.mjs", {
    ...credentials, E2E_BASE_URL: "https://production.example",
  });
  assert.equal(remote.default.workers, 1);
  const local = await importFresh("../playwright.config.mjs", { ...credentials, E2E_WORKERS: "3" });
  assert.equal(local.default.workers, 3);
  const ci = await importFresh("../playwright.config.mjs", { ...credentials, CI: "1", E2E_WORKERS: "3" });
  assert.equal(ci.default.workers, 1);
  for (const value of ["0", "-1", "1.5", "", "17", "Infinity"]) {
    await assert.rejects(
      importFresh("../playwright.config.mjs", { ...credentials, E2E_WORKERS: value }),
      /E2E_WORKERS.*positive integer.*16/i,
    );
  }
});

test("read-only specs cover the project deep link, playback, the old editor link and the gone routes", async () => {
  const [readOnly, harness] = await Promise.all([
    readFile(new URL("../e2e/read-only.spec.mjs", import.meta.url), "utf8"),
    readFile(new URL("../e2e/support/harness.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(readOnly, /clearCookies\(/);
  assert.match(readOnly, /expectPlaybackAdvances\(/);
  assert.match(readOnly, /\/candidates\/\$\{RETIRED_CANDIDATE\}\/edit/);
  assert.match(readOnly, /toEqual\(\[404, 404, 404, 404\]\)/);
  assert.match(harness, /base\.extend\(/);
  assert.doesNotMatch(harness, /testInfo\.attach\(/);
  assert.doesNotMatch(harness, /candidate|editorPath|E2E_CANDIDATE/i);
  await assert.rejects(access(new URL("../e2e/mutation.spec.mjs", import.meta.url)), { code: "ENOENT" });
});

test("generated E2E reports and results are ignored", async () => {
  const ignore = await readFile(new URL("../../.gitignore", import.meta.url), "utf8");
  assert.match(ignore, /^web\/test-results\/$/m);
  assert.match(ignore, /^web\/playwright-report\/$/m);
});
