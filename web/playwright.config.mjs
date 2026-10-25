import { defineConfig, devices } from "@playwright/test";
import os from "node:os";
import path from "node:path";

const baseURL = (process.env.E2E_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const local = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(baseURL);
const missingCredentials = !process.env.E2E_USERNAME || !process.env.E2E_PASSWORD;
const localSafeSkip = process.env.E2E_ALLOW_SKIP === "1" && !process.env.CI;

function parseWorkers(raw) {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (raw === "" || !Number.isSafeInteger(value) || value <= 0 || value > 16) {
    throw new Error("E2E_WORKERS must be a positive integer no greater than 16");
  }
  return value;
}

// English against a server with POTONGIN_LOCALES=id,en (rombak 07 §14.1), only on request:
// E2E_EN_SMOKE=1. The post-deploy checks (deploy/production.sh) run every project, and production
// stays id until English ships (i18n M9).
const enSmoke = process.env.E2E_EN_SMOKE === "1";

const configuredWorkers = parseWorkers(process.env.E2E_WORKERS);
const workers = process.env.CI ? 1 : (configuredWorkers ?? (local ? undefined : 1));

if (missingCredentials && !localSafeSkip) {
  if (process.env.CI) {
    throw new Error("E2E credentials are required in CI: set E2E_USERNAME and E2E_PASSWORD");
  }
  throw new Error(
    "E2E_USERNAME and E2E_PASSWORD are required for real coverage. "
    + "For local discovery/safety only, explicitly set E2E_ALLOW_SKIP=1.",
  );
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.mjs/,
  outputDir: process.env.E2E_OUTPUT_DIR || path.join(os.tmpdir(), `potongin-playwright-${process.pid}`),
  preserveOutput: "never",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers,
  reporter: process.env.CI ? "line" : "list",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    // Indonesian, explicitly (rombak 07 §14.1): Accept-Language and the potongin_locale cookie
    // (e2e/support/harness.mjs) both say id, so text selectors read the id catalog.
    locale: "id-ID",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: local && process.env.E2E_NO_WEB_SERVER !== "1" ? {
    command: "npm run dev",
    url: baseURL,
    // Both languages on, so en-smoke has its English; a missing key fails the page.
    env: { POTONGIN_LOCALES: "id,en", POTONGIN_I18N_STRICT: "1" },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  } : undefined,
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"], locale: "id-ID", uiLocale: "id" } },
    {
      name: "mobile-chromium",
      // The shell on a touch phone too (05-ui-dashboard.md §8.2): Menu drawer, account menu, names.
      testMatch: /(?:read-only|smoke|app-shell|aria-names)\.spec\.mjs/,
      use: { ...devices["Pixel 7"], locale: "id-ID", uiLocale: "id" },
    },
    ...(enSmoke ? [{
      name: "en-smoke",
      testMatch: /(?:smoke|read-only|app-shell|i18n-locale|aria-names)\.spec\.mjs/,
      use: { ...devices["Desktop Chrome"], locale: "en-US", uiLocale: "en" },
    }] : []),
  ],
});
