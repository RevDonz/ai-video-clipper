// QG-SEC in the browser (plan §9.1 "Headers", §10.2; T4.2): the editor page is cross-origin
// isolated (COOP + COEP, so crossOriginIsolated is true), never sniffed and never framed, and the
// editor's API answers carry nosniff and Cross-Origin-Resource-Policy.
//
// Prerequisites: a production build started with POTONGIN_EDITOR_V3=on and POTONGIN_EDITOR_FAKES=1
// (dev and CI only), E2E_EDITOR_FAKES=1, E2E_USERNAME/E2E_PASSWORD. EDITOR_CHROME overrides the
// browser (default: Chrome for Testing 147.0.7727.15, Playwright build 1217, when installed).
import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { FAKE_CLIP_ID, FAKE_JOB_ID } from "../components/editor/__dev__/fakes.mjs";
import { login, settings } from "./support/harness.mjs";

const EDITOR = `/projects/${FAKE_JOB_ID}/clips/${FAKE_CLIP_ID}/edit?mode=lengkap`;

function defaultChrome() {
  const candidate = path.join(os.homedir(), ".cache", "ms-playwright", "chromium-1217", "chrome-linux64", "chrome");
  return existsSync(candidate) ? candidate : undefined;
}
const chrome = process.env.EDITOR_CHROME || defaultChrome();

test.use({ launchOptions: chrome ? { executablePath: chrome } : {}, viewport: { width: 1366, height: 768 } });
test.skip(process.env.E2E_EDITOR_FAKES !== "1",
  "E2E_EDITOR_FAKES=1 is required (server with POTONGIN_EDITOR_V3=on and POTONGIN_EDITOR_FAKES=1)");
test.skip(!settings.username || !settings.password, "E2E_USERNAME and E2E_PASSWORD are required");

test("the editor page is cross-origin isolated, never sniffed and never framed", async ({ page }) => {
  await login(page, "/dashboard");
  const response = await page.goto(EDITOR);
  expect(response.status()).toBe(200);
  const headers = response.headers();
  expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
  expect(headers["cross-origin-embedder-policy"]).toBe("require-corp");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["x-frame-options"]).toBe("DENY");
  await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);
  expect(await page.evaluate(() => typeof SharedArrayBuffer === "function")).toBe(true);
});

test("a page of the same origin cannot frame the editor", async ({ page }) => {
  await login(page, "/dashboard");
  const blocked = page.waitForEvent("console", { predicate: (message) => /frame-ancestors|X-Frame-Options|refused to (?:display|frame)/i.test(message.text()), timeout: 15_000 }).catch(() => null);
  await page.evaluate((target) => {
    const frame = document.createElement("iframe");
    frame.id = "framed-editor";
    frame.src = target;
    document.body.append(frame);
  }, EDITOR);
  await page.waitForTimeout(3000);
  const framed = page.frames().find((frame) => frame !== page.mainFrame());
  const reached = framed ? await framed.evaluate(() => Boolean(document.querySelector("[data-editor-ready]"))).catch(() => false) : false;
  expect(reached, "the editor rendered inside a frame").toBe(false);
  expect(framed ? framed.url() : "").not.toContain(EDITOR);
  const message = await blocked;
  expect(message?.text() ?? "", "the browser reports the refused frame").toMatch(/frame-ancestors|X-Frame-Options/i);
});

test("the editor's API answers carry nosniff and Cross-Origin-Resource-Policy", async ({ page }) => {
  await login(page, "/dashboard");
  await page.goto(EDITOR);
  const answers = await page.evaluate(async ({ job, clip }) => {
    const paths = [
      `/api/jobs/${job}/clips`,
      `/api/jobs/${job}/clips/${clip}/edit`,
      `/api/jobs/${job}/clips/${clip}/cleanup`,
      `/api/jobs/${job}/clips/${clip}/media/plates/0123456789abcdef-c0000000.mp4`,
      `/api/jobs/${job.toUpperCase()}/clips/${clip}/edit`,
      `/api/jobs/${job}/assets/${"ab".repeat(32)}`,
    ];
    const read = async (target) => {
      const response = await fetch(target, { cache: "no-store" });
      return { target, status: response.status, nosniff: response.headers.get("x-content-type-options"),
        corp: response.headers.get("cross-origin-resource-policy"), body: (await response.text()).slice(0, 400) };
    };
    const out = [];
    for (const target of paths) out.push(await read(target));
    const traversal = await read(`/api/jobs/${job}/clips/${clip}/media/plates/..%2F..%2Fseed.json`);
    return { out, traversal };
  }, { job: FAKE_JOB_ID, clip: FAKE_CLIP_ID });
  for (const answer of answers.out) {
    expect(answer.nosniff, answer.target).toBe("nosniff");
    expect(answer.corp, answer.target).toBe("same-origin");
    // 503 is the fixed answer when no Python backend is reachable (the fakes server); never another 5xx
    expect(answer.status < 500 || answer.status === 503, `${answer.target}: ${answer.status}`).toBe(true);
    expect(answer.body, answer.target).not.toMatch(/Traceback|\/data\/jobs|\/proc\/self/);
  }
  const upper = answers.out.find((answer) => answer.target.includes(FAKE_JOB_ID.toUpperCase()));
  expect(upper.status).toBe(400);
  expect([400, 404]).toContain(answers.traversal.status);
  expect(answers.traversal.body).not.toMatch(/"schema"|Traceback|\/data\/jobs/);
});
