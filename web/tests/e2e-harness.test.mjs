import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const originalEnv = { ...process.env };

async function importFresh(path, env = {}) {
  process.env = { ...originalEnv, ...env };
  for (const key of [
    "CI", "E2E_ALLOW_SKIP", "E2E_USERNAME", "E2E_PASSWORD", "E2E_CANDIDATE_ID",
    "E2E_CANDIDATE_IDS", "E2E_RENDER_TIMEOUT_MS", "E2E_BASE_URL", "E2E_WORKERS",
  ]) {
    if (!(key in env)) delete process.env[key];
  }
  try {
    return await import(`${path}?test=${Date.now()}-${Math.random()}`);
  } finally {
    process.env = { ...originalEnv };
  }
}

test("render timeout accepts only positive finite milliseconds", async () => {
  const { parsePositiveMilliseconds } = await importFresh("../e2e/support/harness.mjs", {
    E2E_USERNAME: "user", E2E_PASSWORD: "secret",
  });
  assert.equal(parsePositiveMilliseconds(undefined, 600_000, "E2E_RENDER_TIMEOUT_MS"), 600_000);
  assert.equal(parsePositiveMilliseconds("1500", 600_000, "E2E_RENDER_TIMEOUT_MS"), 1500);
  for (const value of ["NaN", "Infinity", "0", "-1", "", "1.5", "9007199254740992"]) {
    assert.throws(() => parsePositiveMilliseconds(value, 600_000, "E2E_RENDER_TIMEOUT_MS"), /positive finite/);
  }
});

test("weak ETag delivery accepts only canonical strong or once-weak validators", async () => {
  const { weakTransportEtag } = await importFresh("../e2e/support/harness.mjs", {
    E2E_USERNAME: "user", E2E_PASSWORD: "secret",
  });
  const canonical = `"${"a".repeat(64)}"`;
  assert.equal(weakTransportEtag(canonical), `W/${canonical}`);
  assert.equal(weakTransportEtag(`W/${canonical}`), `W/${canonical}`);
  for (const malformed of [
    `W/W/${canonical}`, `w/${canonical}`, `"${"A".repeat(64)}"`,
    `"${"a".repeat(63)}"`, ` ${canonical}`, `${canonical} `, "not-an-etag",
  ]) assert.throws(() => weakTransportEtag(malformed), /canonical ETag/);
});

test("candidate pins never replace the complete available candidate set", async () => {
  const { selectCandidateTargets } = await importFresh("../e2e/support/harness.mjs", {
    E2E_USERNAME: "user", E2E_PASSWORD: "secret",
  });
  assert.deepEqual(
    selectCandidateTargets([{ id: "a" }, { id: "b" }], ["b"]),
    { availableCandidateIds: ["a", "b"], mutationCandidateIds: ["b"] },
  );
  assert.throws(() => selectCandidateTargets([{ id: "a" }], ["missing"]), /not in current selection/);
});

test("candidate discovery suppresses only the documented legacy response", async () => {
  const { resolveTarget } = await importFresh("../e2e/support/harness.mjs", {
    E2E_USERNAME: "user", E2E_PASSWORD: "secret",
  });
  const response = (status, body) => ({
    ok: () => status >= 200 && status < 300,
    status: () => status,
    json: async () => body,
  });
  const jobs = response(200, { jobs: [
    { id: "legacy", status: "completed" },
    { id: "current", status: "completed" },
  ] });
  const page = { request: { get: async (path) => {
    if (path === "/api/jobs") return jobs;
    if (path.includes("legacy")) return response(422, { error: "Artifact kandidat tidak valid" });
    return response(200, { candidates: [{ id: "candidate" }], selectionVersion: 2 });
  } } };
  assert.deepEqual(await resolveTarget(page), {
    jobId: "current",
    availableCandidateIds: ["candidate"],
    mutationCandidateIds: ["candidate"],
    selectionVersion: 2,
  });

  page.request.get = async (path) => path === "/api/jobs"
    ? jobs : response(503, { error: "backend unavailable" });
  await assert.rejects(resolveTarget(page), /returned 503.*backend unavailable/);
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
  const mediaUrl = "https://site/api/jobs/1/preview-source";

  page.emit("requestfailed", request(mediaUrl));
  page.emit("requestfailed", request("https://site/api/jobs/1/candidates", "fetch"));
  page.emit("requestfailed", request(mediaUrl, "media", "POST"));
  page.emit("requestfailed", request(mediaUrl, "media", "GET", "net::ERR_FAILED"));

  assert.deepEqual(failures.requests, [
    "GET https://site/api/jobs/1/candidates net::ERR_ABORTED",
    `POST ${mediaUrl} net::ERR_ABORTED`,
    `GET ${mediaUrl} net::ERR_FAILED`,
  ]);
});

test("editor media cleanup pauses and unloads only videos with current sources", async () => {
  const { captureFailures, cleanupEditorMedia } = await importFresh("../e2e/support/harness.mjs", {
    E2E_USERNAME: "user", E2E_PASSWORD: "secret",
  });
  const page = new EventEmitter();
  const calls = [];
  const sourced = {
    currentSrc: "https://site/api/jobs/1/preview.mp4",
    pause: () => calls.push("pause"),
    removeAttribute: (name) => calls.push(`remove:${name}`),
    querySelectorAll: () => [],
    load: () => calls.push("load"),
  };
  const empty = {
    currentSrc: "", getAttribute: () => null,
    pause: () => calls.push("empty:pause"),
    removeAttribute: () => calls.push("empty:remove"),
    querySelectorAll: () => [], load: () => calls.push("empty:load"),
  };
  page.locator = () => ({ evaluateAll: async (callback, argument) => callback([sourced, empty], argument) });
  captureFailures(page);
  assert.deepEqual(await cleanupEditorMedia(page), [sourced.currentSrc]);
  assert.deepEqual(calls, ["pause", "remove:src", "load"]);
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
  assert.match(String(mobile.testIgnore), /mutation/);
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

test("spec contracts include nested editor deep-link, playback, terminal failure, and diagnostics fixture", async () => {
  const [readOnly, mutation, harness] = await Promise.all([
    readFile(new URL("../e2e/read-only.spec.mjs", import.meta.url), "utf8"),
    readFile(new URL("../e2e/mutation.spec.mjs", import.meta.url), "utf8"),
    readFile(new URL("../e2e/support/harness.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(readOnly, /editorPath\(/);
  assert.match(readOnly, /clearCookies\(/);
  assert.match(readOnly, /expectPlaybackAdvances\(/);
  assert.match(readOnly, /cleanupEditorMedia\(page\)[\s\S]*page\.goto\(editorPath/s);
  assert.match(readOnly, /weakTransportEtag\(etag\)/);
  assert.match(mutation, /waitForRenderCompletion\(/);
  assert.match(harness, /base\.extend\(/);
  assert.doesNotMatch(harness, /testInfo\.attach\(/);
});

test("generated E2E reports and results are ignored", async () => {
  const ignore = await readFile(new URL("../../.gitignore", import.meta.url), "utf8");
  assert.match(ignore, /^web\/test-results\/$/m);
  assert.match(ignore, /^web\/playwright-report\/$/m);
});
