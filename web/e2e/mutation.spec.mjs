import { expect } from "@playwright/test";

import {
  cleanupEditorMedia, editorPath, expectEditorReady, expectPlaybackAdvances, login, resolveTarget,
  settings, skipWithoutCredentials, skipWithoutExplicitMutationTarget, test, waitForRenderCompletion,
} from "./support/harness.mjs";

test.describe("explicitly gated mutations", () => {
  test.beforeEach(() => {
    skipWithoutCredentials(test);
    skipWithoutExplicitMutationTarget(test);
  });

  test("safe reversible edit persists across reload", async ({ page }) => {
    await login(page);
    const target = await resolveTarget(page);
    const candidateId = target.mutationCandidateIds[0];
    const path = editorPath(target.jobId, candidateId);
    await page.goto(path);
    await expectEditorReady(page);

    const revisionText = await page.locator(".editorHeader .eyebrow").textContent();
    const originalRevision = Number(/REVISI\s+(\d+)/i.exec(revisionText || "")?.[1]);
    expect(originalRevision).toBeGreaterThan(0);
    const normalize = page.getByLabel("Normalisasi loudness");
    const original = await normalize.isChecked();

    try {
      await normalize.setChecked(!original);
      await page.getByRole("button", { name: "Simpan", exact: true }).click();
      await expect(page.getByText(`Tersimpan sebagai revisi ${originalRevision + 1}.`)).toBeVisible();
      await cleanupEditorMedia(page);
      await page.reload();
      await expectEditorReady(page);
      await expect(page.getByLabel("Normalisasi loudness")).toBeChecked({ checked: !original });
      await expect(page.locator(".editorHeader .eyebrow")).toContainText(`REVISI ${originalRevision + 1}`);
    } finally {
      // Best-effort rollback also runs when a persistence assertion fails. Retries are disabled.
      await cleanupEditorMedia(page);
      await page.goto(path);
      await expectEditorReady(page);
      const current = page.getByLabel("Normalisasi loudness");
      if (await current.isChecked() !== original) {
        await current.setChecked(original);
        await page.getByRole("button", { name: "Simpan", exact: true }).click();
        await expect(page.locator(".editorSaveBar").getByText(/Tersimpan sebagai revisi \d+\./)).toBeVisible();
        await cleanupEditorMedia(page);
        await page.reload();
        await expectEditorReady(page);
      }
      await expect(page.getByLabel("Normalisasi loudness")).toBeChecked({ checked: original });
      await cleanupEditorMedia(page);
    }
  });

  test("render queues, polls, completes, downloads, and plays", async ({ page }) => {
    test.setTimeout(settings.renderTimeoutMs + 90_000);
    await login(page);
    const target = await resolveTarget(page);
    const candidateId = target.mutationCandidateIds[0];
    await page.goto(editorPath(target.jobId, candidateId));
    await expectEditorReady(page);

    await page.getByRole("button", { name: "Render Final", exact: true }).click();
    const status = page.locator(".editorRenderStatus");
    await expect(status).toBeVisible();
    await waitForRenderCompletion(status, settings.renderTimeoutMs);

    const video = status.locator('video[aria-label^="Render final revisi"]');
    const source = await video.getAttribute("src");
    expect(source).toMatch(/^\/api\/jobs\/.+\.mp4$/);
    const download = await page.request.get(source);
    expect(download.ok()).toBe(true);
    expect(download.headers()["content-type"] || "").toMatch(/^video\//);
    expect((await download.body()).byteLength).toBeGreaterThan(0);
    await expectPlaybackAdvances(video);
    await cleanupEditorMedia(page);
  });
});
