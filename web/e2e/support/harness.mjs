import { expect, test as base } from "@playwright/test";

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
    if (message.type() === "error") failures.console.push(message.text());
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

export const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    const failures = captureFailures(page);
    await use(page);
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
