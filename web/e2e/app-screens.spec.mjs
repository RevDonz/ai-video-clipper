// Full-page screenshots of the app pages (login, dashboard, Riwayat, a project, settings, Konteks
// Tren, Bantuan, licenses) at 1366×900 and 390×844, so a run on main and a run on a branch can be
// compared pixel by pixel before a change to the shared CSS reaches production. The job API is
// faked inside the browser (page.route) with fixed data; only the login is real. PNGs and a
// manifest land in EDITOR_GATES_OUT/app-screens.
//
// Prerequisites: E2E_USERNAME/E2E_PASSWORD against a production build. On GitHub Actions:
//   gh workflow run editor-gates.yml -f ref=<branch> -f suite=e2e -f command='e2e/app-screens.spec.mjs'
import { expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { login, skipWithoutCredentials, test } from "./support/harness.mjs";

const JOB_ID = "8c2e4f60-7a1b-4c3d-9e5f-0a1b2c3d4e5f";
const CLIP_ID = `clip_${"a".repeat(24)}`;
// A fixed clock in the page and in the data, so dates and "N jam lalu" read the same on every run.
const NOW = Date.parse("2026-10-20T03:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const VIEWPORTS = [{ name: "laptop", width: 1366, height: 900 }, { name: "phone", width: 390, height: 844 }];

function clip(index) {
  const base = `/api/jobs/${JOB_ID}/files/output/clip-0${index}`;
  return {
    index, score: [8.4, 6.1, 7.9][index - 1], start: 60 * index, end: 60 * index + 30, duration: 30, text: "transkrip",
    title: ["Rahasia hook di 3 detik", "Jangan menyerah", "Ngopi pagi"][index - 1], description: "Deskripsi.\n\n#fyp",
    hashtags: ["#fyp"], selectionSource: "llm", sourceStart: 60 * index, sourceEnd: 60 * index + 30,
    videoUrl: `${base}.mp4`, downloadUrl: `${base}.mp4?download=1`, subtitleUrl: `${base}.srt?download=1`,
  };
}

const DONE = {
  id: JOB_ID, status: "completed", progress: 100, createdAt: iso(NOW - 3_600_000), updatedAt: iso(NOW - 3_600_000),
  source: { type: "upload", name: "Podcast 12.mp4" },
  options: { renderMode: "fit-blur", limit: 3, minDuration: 20, maxDuration: 60, llmMode: "auto" },
  clips: [1, 2, 3].map(clip),
};
const RUNNING = {
  id: "9d3f5a71-8b2c-4d4e-8f60-1b2c3d4e5f60", status: "processing", progress: 63, stage: "packaging",
  stageDetail: "Menyiapkan judul, hook, dan caption klip", createdAt: iso(NOW - 600_000), updatedAt: iso(NOW - 60_000),
  source: { type: "upload", name: "Podcast 13.mp4" }, options: { llmMode: "auto" }, clips: [],
};
const FAILED = {
  id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", status: "failed", progress: 20, error: "Video tidak bisa dibaca.",
  createdAt: iso(NOW - 86_400_000), updatedAt: iso(NOW - 86_400_000), source: { type: "upload", name: "Rekaman.mov" },
  options: {}, clips: [],
};

async function fakeJobs(page) {
  const json = (route, body) => route.fulfill({ status: 200, contentType: "application/json", headers: { "Cache-Control": "no-store" }, body: JSON.stringify(body) });
  await page.route(/\/api\/jobs(?:\?.*)?$/, (route) => (route.request().method() === "GET"
    ? json(route, { jobs: [DONE, RUNNING, FAILED], total: 3, editor: false }) : route.continue()));
  // The CI server has no storage limits or LLM keys; the dashboard reads both.
  await page.route(/\/api\/storage\/status(?:\?.*)?$/, (route) => json(route, { admission: { allowed: true, code: null } }));
  await page.route(/\/api\/llm\/status(?:\?.*)?$/, (route) => json(route, {
    llm: { state: "active", order: ["uji"], providers: [{ name: "uji", displayName: null }], label: "LLM aktif: uji" },
  }));
  await page.route(new RegExp(`/api/jobs/(?:${JOB_ID}|${RUNNING.id}|${FAILED.id})(?:[/?].*)?$`), (route) => {
    const url = new URL(route.request().url());
    const job = [DONE, RUNNING, FAILED].find((item) => url.pathname.startsWith(`/api/jobs/${item.id}`));
    if (url.pathname === `/api/jobs/${job.id}`) return json(route, { job });
    if (url.pathname === `/api/jobs/${job.id}/clips`) {
      return json(route, { clips: job.clips.map((item) => ({ index: item.index, clipId: CLIP_ID, openable: true, reason: null, edit: null, latestRender: null })) });
    }
    return route.fulfill({ status: 200, contentType: "video/mp4", body: "" });
  });
}

async function settle(page) {
  // The dashboard polls the running job, so the network may never go quiet for long.
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
}

function outDir(testInfo) {
  const dir = path.join(process.env.EDITOR_GATES_OUT || testInfo.outputPath(), "app-screens");
  mkdirSync(dir, { recursive: true });
  return dir;
}

const PAGES = [
  { name: "dashboard", path: "/dashboard", ready: (page) => page.getByRole("heading", { level: 1 }).first() },
  // The table on a laptop, the card list on a phone: the one on screen.
  { name: "projects", path: "/projects", ready: (page) => page.getByText("Podcast 12.mp4").filter({ visible: true }).first() },
  { name: "project", path: `/projects/${JOB_ID}`, ready: (page) => page.getByText("Rahasia hook di 3 detik").filter({ visible: true }).first() },
  { name: "settings", path: "/settings", ready: (page) => page.getByRole("heading", { level: 1 }).first() },
  { name: "trends", path: "/trends", ready: (page) => page.getByRole("heading", { level: 1 }).first() },
  { name: "bantuan", path: "/bantuan", ready: (page) => page.getByRole("heading", { level: 1 }).first() },
  { name: "licenses", path: "/licenses", ready: (page) => page.getByRole("heading", { level: 1 }).first() },
];

test.describe("app page screenshots", () => {
  test.beforeEach(() => skipWithoutCredentials(test));

  for (const viewport of VIEWPORTS) {
    test(`app pages at ${viewport.name} width`, async ({ page }, testInfo) => {
      const dir = outDir(testInfo);
      const shots = [];
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.clock.setFixedTime(NOW);
      await page.goto("/login");
      await expect(page.locator('input[name="username"]')).toBeVisible();
      await settle(page);
      await page.screenshot({ path: path.join(dir, `${viewport.name}-login.png`), fullPage: true });
      shots.push(`${viewport.name}-login.png`);

      await fakeJobs(page);
      await login(page, "/dashboard");
      for (const entry of PAGES) {
        await page.goto(entry.path);
        await expect(entry.ready(page)).toBeVisible();
        await settle(page);
        const file = `${viewport.name}-${entry.name}.png`;
        await page.screenshot({ path: path.join(dir, file), fullPage: true });
        shots.push(file);
      }
      writeFileSync(path.join(dir, `${viewport.name}-manifest.json`), `${JSON.stringify({ viewport, shots }, null, 2)}\n`);
    });
  }
});
