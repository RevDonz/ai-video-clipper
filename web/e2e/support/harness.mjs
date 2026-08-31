import { expect, test as base } from "@playwright/test";

export function parsePositiveMilliseconds(raw, fallback, name) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (raw === "" || !Number.isSafeInteger(value) || value <= 0 || value > 86_400_000) {
    throw new Error(`${name} must be a positive finite integer no greater than 86400000 milliseconds`);
  }
  return value;
}

export function weakTransportEtag(etag) {
  const match = /^(?:W\/)?("[0-9a-f]{64}")$/.exec(etag || "");
  if (!match) throw new Error("Expected a canonical ETag: exact strong or once-weak lowercase 64hex");
  return `W/${match[1]}`;
}

export const settings = Object.freeze({
  baseURL: (process.env.E2E_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, ""),
  username: process.env.E2E_USERNAME || "",
  password: process.env.E2E_PASSWORD || "",
  jobId: process.env.E2E_JOB_ID || "",
  candidateIds: (process.env.E2E_CANDIDATE_IDS || process.env.E2E_CANDIDATE_ID || "")
    .split(",").map((value) => value.trim()).filter(Boolean),
  allowMutation: process.env.E2E_ALLOW_MUTATION === "1",
  allowSkip: process.env.E2E_ALLOW_SKIP === "1" && !process.env.CI,
  renderTimeoutMs: parsePositiveMilliseconds(process.env.E2E_RENDER_TIMEOUT_MS, 600_000, "E2E_RENDER_TIMEOUT_MS"),
});

export function skipWithoutCredentials(testType) {
  testType.skip(
    settings.allowSkip && (!settings.username || !settings.password),
    "Explicit local safety mode: credentials are absent and E2E_ALLOW_SKIP=1",
  );
}

export function skipWithoutExplicitMutationTarget(testType) {
  testType.skip(!settings.allowMutation, "Production-safe default: set E2E_ALLOW_MUTATION=1 to enable mutations");
  testType.skip(!settings.jobId || settings.candidateIds.length === 0,
    "Mutation tests also require explicit E2E_JOB_ID and E2E_CANDIDATE_ID(S)");
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

async function apiJson(page, path) {
  const response = await page.request.get(path, { failOnStatusCode: false });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok()) throw new ApiResponseError(path, response.status(), body);
  return body;
}

export function selectCandidateTargets(candidates, requestedIds) {
  const availableCandidateIds = candidates.map((item) => item.id).filter(Boolean);
  const mutationCandidateIds = requestedIds.length ? [...requestedIds] : [...availableCandidateIds];
  const missing = mutationCandidateIds.filter((id) => !availableCandidateIds.includes(id));
  if (missing.length) throw new Error(`Explicit candidate IDs not in current selection: ${missing.join(", ")}`);
  return { availableCandidateIds, mutationCandidateIds };
}

function targetFromPayload(jobId, payload) {
  const targets = selectCandidateTargets(payload.candidates || [], settings.candidateIds);
  if (!targets.availableCandidateIds.length) throw new Error(`Job ${jobId} has no V2 candidates`);
  return { jobId, ...targets, selectionVersion: payload.selectionVersion };
}

export async function resolveTarget(page) {
  if (settings.jobId) {
    return targetFromPayload(
      settings.jobId,
      await apiJson(page, `/api/jobs/${encodeURIComponent(settings.jobId)}/candidates`),
    );
  }

  const { jobs = [] } = await apiJson(page, "/api/jobs");
  for (const job of jobs.filter((item) => item.status === "completed")) {
    try {
      const payload = await apiJson(page, `/api/jobs/${encodeURIComponent(job.id)}/candidates`);
      if ((payload.candidates || []).length) return targetFromPayload(job.id, payload);
    } catch (error) {
      // A 422 is the documented legacy-artifact response. Authentication, transport,
      // malformed IDs, missing jobs, and server failures are never converted to "no job".
      if (!(error instanceof ApiResponseError && error.status === 422
        && error.body?.error === "Artifact kandidat tidak valid")) throw error;
    }
  }
  throw new Error("No completed job with a readable Selection V2 candidate artifact was found");
}

export function editorPath(jobId, candidateId) {
  return `/projects/${encodeURIComponent(jobId)}/candidates/${encodeURIComponent(candidateId)}/edit`;
}

async function currentMediaUrls(page) {
  return page.locator("video").evaluateAll((elements) => elements.flatMap((element) => {
    const current = element.currentSrc || element.src || element.getAttribute?.("src");
    return current ? [current] : [];
  }));
}

export async function cleanupEditorMedia(page) {
  const videos = page.locator("video");
  const urls = await currentMediaUrls(page);
  await videos.evaluateAll((elements, expectedUrls) => {
    const expected = new Set(expectedUrls);
    for (const element of elements) {
      const current = element.currentSrc || element.src || element.getAttribute?.("src");
      if (!current || !expected.has(current)) continue;
      element.pause();
      element.removeAttribute("src");
      for (const source of element.querySelectorAll("source")) source.removeAttribute("src");
      element.load();
    }
  }, urls);
  return urls;
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

export async function expectEditorReady(page) {
  await expect(page.getByRole("heading", { name: "Poles kandidat sebelum render" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Editor tidak tersedia" })).toHaveCount(0);
  await expect(page.locator("video")).toHaveCount(2);
  await expect.poll(() => page.locator("video").evaluateAll((elements) => (
    elements.length === 2 && elements.every((element) => element.readyState >= 1)
  )), { timeout: 30_000, message: "both editor videos should load metadata" }).toBe(true);
  await expect(page.getByRole("button", { name: "Render Final" })).toBeVisible();
  await expect(page.getByLabel("Normalisasi loudness")).toBeVisible();
}

export async function expectPlaybackAdvances(video) {
  await expect(video).toBeVisible();
  await video.evaluate(async (element) => {
    element.muted = true;
    await element.play();
  });
  await expect.poll(() => video.evaluate((element) => element.currentTime), { timeout: 15_000 }).toBeGreaterThan(0);
}

export async function waitForRenderCompletion(status, timeout) {
  const terminal = await expect.poll(async () => {
    const classes = (await status.getAttribute("class") || "").split(/\s+/);
    return ["completed", "failed", "conflict", "error"].find((value) => classes.includes(value)) || "pending";
  }, { timeout, message: "render should reach a terminal state" }).not.toBe("pending");
  void terminal;
  const classes = (await status.getAttribute("class") || "").split(/\s+/);
  const state = ["completed", "failed", "conflict", "error"].find((value) => classes.includes(value));
  if (state !== "completed") {
    const message = await status.getByRole("alert").textContent().catch(() => "No failure message was rendered");
    throw new Error(`Render reached terminal ${state} state: ${message}`);
  }
}
