import { expect, test as base } from "@playwright/test";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const settings = Object.freeze({
  baseURL: (process.env.E2E_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, ""),
  username: process.env.E2E_USERNAME || "",
  password: process.env.E2E_PASSWORD || "",
  jobId: process.env.E2E_JOB_ID || "",
  allowMutation: process.env.E2E_ALLOW_MUTATION === "1",
  allowSkip: process.env.E2E_ALLOW_SKIP === "1" && !process.env.CI,
});

export function skipWithoutCredentials(testType) {
  testType.skip(
    settings.allowSkip && (!settings.username || !settings.password),
    "Explicit local safety mode: credentials are absent and E2E_ALLOW_SKIP=1",
  );
}

export async function login(page, next = "/projects") {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.locator('input[name="username"]').fill(settings.username);
  await page.locator('input[name="password"]').fill(settings.password);
  await Promise.all([
    page.waitForURL((url) => url.pathname === next),
    page.locator('button[type="submit"]').click(),
  ]);
}

class ApiResponseError extends Error {
  constructor(path, status, body) {
    super(`${path} returned ${status}: ${JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

// From the page itself: the session cookie is Secure, which the browser sends to a local http
// origin but Playwright's request context does not.
async function apiJson(page, path) {
  const { status, body } = await page.evaluate(async (target) => {
    const response = await fetch(target, { cache: "no-store" });
    let payload = {};
    try { payload = await response.json(); } catch {}
    return { status: response.status, body: payload };
  }, path);
  if (status < 200 || status >= 300) throw new ApiResponseError(path, status, body);
  return body;
}

/**
 * The project the read-only specs open: E2E_JOB_ID, or the newest completed project with clips.
 * Authentication, transport and server failures are never turned into "no project".
 */
export async function resolveTarget(page) {
  const { jobs = [] } = await apiJson(page, "/api/jobs");
  const job = settings.jobId
    ? jobs.find((item) => item.id === settings.jobId)
    : jobs.find((item) => item.status === "completed" && Array.isArray(item.clips) && item.clips.length > 0);
  if (!job) {
    throw new Error(settings.jobId ? `E2E_JOB_ID ${settings.jobId} is not in the project list` : "No completed project with clips was found");
  }
  const clipCount = Array.isArray(job.clips) ? job.clips.length : 0;
  if (!clipCount) throw new Error(`Project ${job.id} has no clips`);
  return { jobId: job.id, clipCount };
}

export function captureFailures(page) {
  const failures = { console: [], page: [], requests: [], api: [] };
  page.on("console", (message) => {
    // The URL names the resource of a "Failed to load resource" line.
    const url = message.location()?.url;
    if (message.type() === "error") failures.console.push(url ? `${message.text()} (${url})` : message.text());
  });
  page.on("pageerror", (error) => failures.page.push(error.stack || error.message));
  page.on("requestfailed", (request) => {
    const reason = request.failure()?.errorText || "failed";
    const browserCancelledMedia = request.method() === "GET"
      && request.resourceType() === "media" && reason === "net::ERR_ABORTED";
    if (!browserCancelledMedia) failures.requests.push(`${request.method()} ${request.url()} ${reason}`);
  });
  page.on("response", (response) => {
    if (response.url().includes("/api/") && response.status() >= 400) {
      failures.api.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });
  return failures;
}

function failureCount(failures) {
  return Object.values(failures).reduce((total, values) => total + values.length, 0);
}

// The Chrome for Testing build the parity specs pin (editor-gates and ci-cd install only that
// one): EDITOR_CHROME or PARITY_CHROME, else Playwright's chromium-1217 folder when present,
// else Playwright's own browser.
export function pinnedChrome() {
  const explicit = process.env.EDITOR_CHROME || process.env.PARITY_CHROME;
  if (explicit) return explicit;
  const pin = path.join(os.homedir(), ".cache", "ms-playwright", "chromium-1217", "chrome-linux64", "chrome");
  return existsSync(pin) ? pin : undefined;
}

const chrome = pinnedChrome();

const EXPECTED = Symbol("expected browser failures");

/** Marks API responses (`"<status> <METHOD> <url>"`) and console errors this test causes on purpose. */
export function expectFailures(page, { api = [], console = [] } = {}) {
  if (!page[EXPECTED]) throw new Error("expectFailures needs the harness's page fixture");
  page[EXPECTED].api.push(...api);
  page[EXPECTED].console.push(...console);
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * One faked failed request: its API line (`<status> <METHOD> …<path>`) and the browser's
 * "Failed to load resource" line for it. `path` is the URL's path, e.g. "/api/settings/logo".
 */
export function expectFailedRequest(page, status, method, path) {
  const tail = escapeRegExp(path);
  expectFailures(page, {
    api: [new RegExp(`^${status} ${method} \\S*${tail}$`)],
    console: [new RegExp(`status of ${status} \\([^)]*\\) \\(\\S*${tail}\\)$`)],
  });
}

export const test = base.extend({
  launchOptions: [chrome ? { executablePath: chrome } : {}, { scope: "worker", option: true }],
  // A test that fakes a failure on purpose names what it expects, per test:
  // expectFailures(page, { api: [/^409 POST .*\/hook$/], console: [/status of 409 .*\/hook\)$/] }).
  // Anything else still fails the test.
  page: async ({ page }, use, testInfo) => {
    const failures = captureFailures(page);
    page[EXPECTED] = { api: [], console: [] };
    await use(page);
    const expected = page[EXPECTED];
    for (const kind of ["api", "console"]) {
      failures[kind] = failures[kind].filter((line) => !expected[kind].some((pattern) => pattern.test(line)));
    }
    const diagnostics = JSON.stringify(failures, null, 2);
    if (testInfo.status !== testInfo.expectedStatus) {
      process.stderr.write(`Browser diagnostics for ${testInfo.title}:\n${diagnostics}\n`);
    }
    if (failureCount(failures)) {
      throw new Error(`Browser diagnostics:\n${diagnostics}`);
    }
  },
});

export async function expectPlaybackAdvances(video) {
  await expect(video).toBeVisible();
  await video.evaluate(async (element) => {
    element.muted = true;
    await element.play();
  });
  await expect.poll(() => video.evaluate((element) => element.currentTime), { timeout: 15_000 }).toBeGreaterThan(0);
}
