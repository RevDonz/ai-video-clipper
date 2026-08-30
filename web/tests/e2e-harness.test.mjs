import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const originalEnv = { ...process.env };

async function importFresh(path, env = {}) {
  process.env = { ...originalEnv, ...env };
  for (const key of [
    "CI", "E2E_ALLOW_SKIP", "E2E_USERNAME", "E2E_PASSWORD", "E2E_CANDIDATE_ID",
    "E2E_CANDIDATE_IDS", "E2E_RENDER_TIMEOUT_MS",
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

test("only non-API navigation and media lifecycle aborts are suppressed", async () => {
  const { isExpectedLifecycleAbort } = await importFresh("../e2e/support/harness.mjs", {
    E2E_USERNAME: "user", E2E_PASSWORD: "secret",
  });
  const request = (url, type) => ({ url: () => url, resourceType: () => type });
  assert.equal(isExpectedLifecycleAbort(request("https://site/projects/1", "document"), "net::ERR_ABORTED"), true);
  assert.equal(isExpectedLifecycleAbort(request("https://cdn/video.mp4", "media"), "net::ERR_ABORTED"), true);
  assert.equal(isExpectedLifecycleAbort(request("https://site/api/jobs", "fetch"), "net::ERR_ABORTED"), false);
  assert.equal(isExpectedLifecycleAbort(request("https://site/api/jobs/1/file.mp4", "media"), "net::ERR_ABORTED"), false);
  assert.equal(isExpectedLifecycleAbort(request("https://site/projects/1", "document"), "net::ERR_FAILED"), false);
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

test("spec contracts include nested editor deep-link, playback, terminal failure, and diagnostics fixture", async () => {
  const [readOnly, mutation, harness] = await Promise.all([
    readFile(new URL("../e2e/read-only.spec.mjs", import.meta.url), "utf8"),
    readFile(new URL("../e2e/mutation.spec.mjs", import.meta.url), "utf8"),
    readFile(new URL("../e2e/support/harness.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(readOnly, /editorPath\(/);
  assert.match(readOnly, /clearCookies\(/);
  assert.match(readOnly, /expectPlaybackAdvances\(/);
  assert.match(mutation, /waitForRenderCompletion\(/);
  assert.match(harness, /base\.extend\(/);
  assert.doesNotMatch(harness, /testInfo\.attach\(/);
});

test("generated E2E reports and results are ignored", async () => {
  const ignore = await readFile(new URL("../../.gitignore", import.meta.url), "utf8");
  assert.match(ignore, /^web\/test-results\/$/m);
  assert.match(ignore, /^web\/playwright-report\/$/m);
});
