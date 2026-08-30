import { defineConfig, devices } from "@playwright/test";
import os from "node:os";
import path from "node:path";

const baseURL = (process.env.E2E_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const local = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(baseURL);
const missingCredentials = !process.env.E2E_USERNAME || !process.env.E2E_PASSWORD;
const localSafeSkip = process.env.E2E_ALLOW_SKIP === "1" && !process.env.CI;

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
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "line" : "list",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: local && process.env.E2E_NO_WEB_SERVER !== "1" ? {
    command: "npm run dev",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  } : undefined,
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile-chromium",
      testMatch: /(?:read-only|smoke)\.spec\.mjs/,
      testIgnore: /mutation\.spec\.mjs/,
      use: { ...devices["Pixel 7"] },
    },
  ],
});
