import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect } from "@playwright/test";

import { E2E_JOB_ID } from "../scripts/seed-e2e-project.mjs";
import { login, skipWithoutCredentials, test } from "./support/harness.mjs";

// The landing's "hasil" screenshot of the real app (lib/landing-media.mjs, 08 Fase 2 F3), retaken
// on the CI server (editor-gates.yml -f suite=e2e -f seed=true -f command=e2e/landing-shots.spec.mjs):
// the seeded project (scripts/seed-e2e-project.mjs) with its best clip open in the clip viewer.
// Written as WebP (the browser's own encoder) to $EDITOR_GATES_OUT/landing, to be copied into
// public/landing; only run with LANDING_SHOTS=1. The editor picture (editor.webp) shows the
// editor as it ships until its own rombak (Fase 10-11); the editor fakes have no video to show.

const SHOTS = Object.freeze({
  hasil: Object.freeze({ width: 1400, height: 860 }),
});
const QUALITY = 0.86;

test.skip(process.env.LANDING_SHOTS !== "1", "LANDING_SHOTS=1 retakes the landing screenshots");
test.use({ deviceScaleFactor: 1 });

async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

// PNG from Playwright, WebP from the browser's canvas encoder (no image tool on the runner).
async function saveWebp(page, name) {
  const png = await page.screenshot({ animations: "disabled", caret: "hide" });
  const encoder = await page.context().newPage();
  const webp = await encoder.evaluate(async ({ data, quality }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext("2d").drawImage(image, 0, 0);
    return canvas.toDataURL("image/webp", quality).split(",")[1];
  }, { data: png.toString("base64"), quality: QUALITY });
  await encoder.close();
  const out = path.join(process.env.EDITOR_GATES_OUT || test.info().outputDir, "landing");
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, `${name}.png`), png);
  await writeFile(path.join(out, `${name}.webp`), Buffer.from(webp, "base64"));
}

test.describe("landing screenshots", () => {
  test.beforeEach(() => skipWithoutCredentials(test));

  test("hasil: a project's clips with the best one open in the clip viewer", async ({ page }) => {
    await page.setViewportSize(SHOTS.hasil);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await login(page, "/projects");
    // The seed is a project without editor analysis; the picture shows a project of the current
    // method, whose clips open in the editor and carry Hook di video.
    await page.route(`**/api/jobs/${E2E_JOB_ID}/clips`, (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ clips: [1, 2, 3].map((index) => ({
        index, clipId: `clip_${String(index).repeat(24)}`, openable: true, hook: { on: true, available: true },
      })) }),
    }));
    await page.goto(`/projects/${E2E_JOB_ID}?klip=2`);
    const detail = page.locator("[data-clip-detail]");
    await expect(detail.getByRole("heading", { level: 3 })).toHaveText("Kamu dengar itu?");
    const video = detail.locator("video");
    await expect(video).toBeVisible();
    // A frame of the clip instead of an empty player.
    await video.evaluate((element) => new Promise((resolve) => {
      const show = () => { element.pause(); resolve(); };
      element.muted = true;
      if (element.readyState >= 2) element.currentTime = 3.2;
      element.addEventListener("seeked", show, { once: true });
      element.addEventListener("loadeddata", () => { element.currentTime = 3.2; }, { once: true });
    }));
    await settle(page);
    await saveWebp(page, "hasil");
  });
});
