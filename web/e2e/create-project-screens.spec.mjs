import { mkdir } from "node:fs/promises";
import path from "node:path";

import { expect } from "@playwright/test";

import { expectFailedRequest, login, skipWithoutCredentials, test } from "./support/harness.mjs";
import { LIn } from "./support/i18n.mjs";

// Buat klip and the project page at 360 px in each UI language (08 Fase 2: "Screenshot en 360 px
// tanpa scroll horizontal"): no sideways scroll with the chips, a popover, the clip grid and the
// clip viewer open, then Proyek, Pengaturan, Tren and Bantuan, and a screenshot of each in
// $EDITOR_GATES_OUT/create-project-shots. The job
// API is faked inside the browser (page.route); only the login is real. A server that has only
// Indonesian on skips the English run.

const JOB_ID = "7c3e5f60-8a1b-4c2d-9e3f-1a2b3c4d5e6f";
const NOW = new Date().toISOString();

function clip(index) {
  const base = `/api/jobs/${JOB_ID}/files/output/clip-0${index}`;
  return {
    index, score: 9 - index, start: 60 * index, end: 60 * index + 35, duration: 35, text: "transkrip", selectionSource: "llm",
    title: `Judul klip yang cukup panjang untuk dua baris ${index}`, description: "Deskripsi klip.\n\n#fyp #podcast", hashtags: ["#fyp", "#podcast"],
    hookText: "Kalimat pembuka yang kuat", sourceStart: 60 * index, sourceEnd: 60 * index + 35,
    videoUrl: `${base}.mp4`, downloadUrl: `${base}.mp4?download=1`, subtitleUrl: `${base}.srt?download=1`,
  };
}

const JOB = {
  id: JOB_ID, status: "completed", progress: 100, createdAt: NOW, updatedAt: NOW, source: { type: "upload", name: "Podcast panjang episode 12.mp4" },
  options: { selectionMode: "v3", renderMode: "fit-blur" }, clips: [1, 2, 3, 4].map(clip),
};

async function fakeApi(page) {
  // The clips listing answers 404 while the editor is off; the project page reads it.
  expectFailedRequest(page, 404, "GET", `/api/jobs/${JOB_ID}/clips`);
  await page.route(/\/api\/(?:jobs|llm\/status|storage\/status)(?:[/?]|$)/, (route) => {
    const { pathname } = new URL(route.request().url());
    const json = (status, body) => route.fulfill({ status, contentType: "application/json", headers: { "Cache-Control": "no-store" }, body: JSON.stringify(body) });
    if (pathname === "/api/llm/status") return json(200, { llm: { state: "active", order: ["uji"], providers: [] } });
    if (pathname === "/api/storage/status") return json(200, { admission: { allowed: true, code: null } });
    if (pathname === "/api/jobs") return json(200, { jobs: [JOB], total: 1, editor: true });
    if (pathname === `/api/jobs/${JOB_ID}`) return json(200, { job: JOB });
    if (pathname === `/api/jobs/${JOB_ID}/clips`) return json(404, {});
    return route.fulfill({ status: 200, contentType: "video/mp4", body: "" });
  });
}

const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
// The outermost elements whose box ends past the viewport's right edge (tag.class, right edge).
const pastRightEdge = (page) => page.evaluate(() => {
  const edge = document.documentElement.clientWidth;
  const wide = [...document.body.querySelectorAll("*")].filter((element) => element.getBoundingClientRect().right > edge + 0.5);
  return wide.filter((element) => !wide.includes(element.parentElement)).slice(0, 6)
    .map((element) => `${element.tagName.toLowerCase()}.${[...element.classList].join(".")} ${Math.round(element.getBoundingClientRect().right)}`);
});

async function shoot(page, name) {
  await page.evaluate(() => document.fonts.ready);
  const out = path.join(process.env.EDITOR_GATES_OUT || test.info().outputDir, "create-project-shots");
  await mkdir(out, { recursive: true });
  await page.screenshot({ path: path.join(out, `${name}.png`), animations: "disabled", caret: "hide", fullPage: true });
}

for (const locale of ["id", "en"]) {
  test.describe(`Buat klip and the project page at 360 px (${locale})`, () => {
    test.use({ uiLocale: locale, viewport: { width: 360, height: 780 } });
    test.beforeEach(() => skipWithoutCredentials(test));

    test("no sideways scroll with the chips, a popover, the clip grid and the viewer", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await fakeApi(page);
      await login(page, "/dashboard");
      const lang = await page.locator("html").getAttribute("lang");
      test.skip(lang !== locale, `the server does not have ${locale} on (POTONGIN_LOCALES)`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(LIn(locale, "dashboard.title"));
      await expect(page.locator('[data-chip="language"]')).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await shoot(page, `${locale}-360-dashboard`);
      await page.locator('[data-chip="subtitle"]').click();
      await expect(page.locator('[data-chip-popover="subtitle"]')).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await shoot(page, `${locale}-360-dashboard-subtitle`);
      await page.keyboard.press("Escape");

      await page.goto(`/projects/${JOB_ID}`);
      await expect(page.getByRole("article")).toHaveCount(4);
      await expect(page.getByRole("button", { name: LIn(locale, "project.downloadAll") })).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await shoot(page, `${locale}-360-project`);
      await page.locator('[data-poster="1"]').click();
      await expect(page.locator("[data-clip-detail]")).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await shoot(page, `${locale}-360-viewer`);
    });

    test("no sideways scroll on Proyek, Pengaturan, Tren and Bantuan", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await fakeApi(page);
      await login(page, "/dashboard");
      const lang = await page.locator("html").getAttribute("lang");
      test.skip(lang !== locale, `the server does not have ${locale} on (POTONGIN_LOCALES)`);
      for (const [name, route, key] of [
        ["projects", "/projects", "projects.title"],
        ["settings", "/settings", "settings.title"],
        ["trends", "/trends", "trends.title"],
        ["bantuan", "/bantuan", "help.title"],
      ]) {
        await page.goto(route);
        await expect(page.getByRole("heading", { level: 1 })).toHaveText(LIn(locale, key));
        // The shot first, so a page that scrolls sideways can be looked at; the message names the
        // elements that reach past the right edge.
        await shoot(page, `${locale}-360-${name}`);
        expect(await overflow(page), `${name}: ${JSON.stringify(await pastRightEdge(page))}`).toBeLessThanOrEqual(0);
      }
    });
  });
}
