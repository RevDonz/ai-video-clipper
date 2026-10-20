import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { expect } from "@playwright/test";

import { login, skipWithoutCredentials, test } from "./support/harness.mjs";

// The project page as a workspace (plan P1 #7 + A5): a poster grid and one detail panel, the
// "Semua" / "Skor 8+" filters, left/right between clips, "Pilih" mode with "Unduh (n)" and
// "Unduh semua" through the ZIP route, "NN-judul" download names, and the notes of clips that
// fell back (A2). The job API, the clips listing and the ZIP route are faked inside the browser
// (page.route), so nothing on the server changes; only the login is real. Run against a
// production build, like e2e/focus.spec.mjs.

const JOB_ID = "8c2e4f60-7a1b-4c3d-9e5f-0a1b2c3d4e5f";
const CLIP_ID = `clip_${"a".repeat(24)}`;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const TITLES = ["Rahasia hook di 3 detik", "Jangan menyerah", "Ngopi di café", "Kenapa 90% orang gagal"];
const SCORES = [8.4, 6.1, 7.95, 9];
// Clips 2 and 4 fell back (pipeline.py `fallbacks`): no face found, and the backup render too.
const FALLBACKS = [null, ["no_face"], null, ["no_face", "engine_fallback"]];
// Clip 3 was cut from a time range the person typed (Rentang waktu, plan 2026-10-20 P2).
const TYPED = [false, false, true, false];

function clip(index) {
  const base = `/api/jobs/${JOB_ID}/files/output/clip-0${index}`;
  return {
    index, score: SCORES[index - 1], start: 60 * index, end: 60 * index + 30, duration: 30 + index, text: "transkrip",
    title: TITLES[index - 1], description: "Deskripsi.\n\n#fyp", hashtags: ["#fyp"], selectionSource: "llm",
    sourceStart: 60 * index, sourceEnd: 60 * index + 30,
    videoUrl: `${base}.mp4`, downloadUrl: `${base}.mp4?download=1`, subtitleUrl: `${base}.srt?download=1`,
    ...(FALLBACKS[index - 1] ? { fallbacks: FALLBACKS[index - 1] } : {}),
    ...(TYPED[index - 1] ? { manual: true, selectionSource: "heuristic" } : {}),
  };
}

const JOB = {
  id: JOB_ID, status: "completed", progress: 100, createdAt: iso(NOW - 3_600_000), updatedAt: iso(NOW - 3_600_000),
  source: { type: "upload", name: "Podcast 12.mp4" },
  options: { renderMode: "fit-blur", limit: 4, minDuration: 20, maxDuration: 60, selectionMode: "v3", llmMode: "auto" },
  selectionV3: {
    mode: "v3", status: "completed", source: "llm", provider: "groq", model: "m", prompt_version: "p", artifact: null,
    transcript_source: "whisper", warnings: [],
  },
  clips: [1, 2, 3, 4].map(clip),
};

const ZIP_BYTES = Buffer.from("504b0506000000000000000000000000000000000000", "hex");

// Clip 2 failed to render: the job keeps it without any file (lib/clip-status.mjs).
function failedClip(index) {
  const { videoUrl: _video, downloadUrl: _download, subtitleUrl: _subtitle, ...rest } = clip(index);
  return { ...rest, status: "failed", errorCode: "render_timeout" };
}
const PARTLY_FAILED_JOB = { ...JOB, clips: [clip(1), failedClip(2), clip(3), clip(4)] };

/** Fakes the job, its clips listing and the ZIP route; returns the ZIP downloads it saw. */
async function fakeProject(target, { zipCheck = null, job = JOB } = {}) {
  const downloads = [];
  await target.route(new RegExp(`/api/jobs/${JOB_ID}(?:[/?].*)?$`), (route) => {
    const url = new URL(route.request().url());
    const json = (status, body) => route.fulfill({ status, contentType: "application/json", headers: { "Cache-Control": "no-store" }, body: JSON.stringify(body) });
    if (url.pathname === `/api/jobs/${JOB_ID}`) return json(200, { job });
    if (url.pathname === `/api/jobs/${JOB_ID}/clips`) {
      return json(200, { clips: [{ index: 1, clipId: CLIP_ID, openable: true, reason: null, edit: { state: "edited", revision: 2 }, latestRender: null }] });
    }
    if (url.pathname === `/api/jobs/${JOB_ID}/zip`) {
      const picked = url.searchParams.get("clips");
      const count = picked ? picked.split(",").length : job.clips.filter((item) => item.status !== "failed").length;
      if (url.searchParams.get("check") === "1") {
        return zipCheck ? json(zipCheck.status, zipCheck.body) : json(200, { count, bytes: count * 3_000_000, filename: "podcast-12-klip.zip" });
      }
      downloads.push(url);
      return route.fulfill({ status: 200, contentType: "application/zip", headers: { "Content-Disposition": "attachment; filename=\"podcast-12-klip.zip\"", "Cache-Control": "no-store" }, body: ZIP_BYTES });
    }
    return route.fulfill({ status: 200, contentType: "video/mp4", body: "" });
  });
  return downloads;
}

const posters = (target) => target.getByRole("article");
const detail = (target) => target.locator("[data-clip-detail]");
const detailTitle = (target) => detail(target).getByRole("heading", { level: 3 });
const detailNotes = (target) => detail(target).getByRole("list", { name: "Catatan klip" });
const overflow = (target) => target.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

function axeSource() {
  const explicit = process.env.AXE_CORE_PATH;
  if (explicit && existsSync(explicit)) return readFileSync(explicit, "utf8");
  try {
    return readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
  } catch {
    return null;
  }
}
const AXE = axeSource();

async function axeSerious(target) {
  if (!(await target.evaluate(() => Boolean(window.axe)))) await target.addScriptTag({ content: AXE });
  const result = await target.evaluate(() => window.axe.run("#klip", { resultTypes: ["violations"] }));
  return result.violations.filter((violation) => ["serious", "critical"].includes(violation.impact))
    .map((violation) => ({ id: violation.id, nodes: violation.nodes.length }));
}

test.describe("project workspace (faked job API)", () => {
  test.beforeEach(() => skipWithoutCredentials(test));

  test("a running project lists what its finished stages found in the progress panel", async ({ page }) => {
    const id = "9d3f5a71-8b2c-4d4e-8f60-1b2c3d4e5f60";
    const running = {
      id, status: "processing", progress: 63, stage: "packaging", stageDetail: "Menyiapkan judul, hook, dan caption klip",
      createdAt: iso(NOW), updatedAt: iso(NOW), source: { type: "upload", name: "Podcast 13.mp4" },
      options: { selectionMode: "v3", llmMode: "auto" }, clips: [],
      stageSummary: { transcript: { words: 2304, source: "whisper", language: "id" }, moments: { count: 4, source: "llm" } },
    };
    await page.route(new RegExp(`/api/jobs/${id}(?:[/?].*)?$`), (route) => route.fulfill({
      status: 200, contentType: "application/json", headers: { "Cache-Control": "no-store" }, body: JSON.stringify({ job: running }),
    }));
    await login(page, "/projects");
    await page.goto(`/projects/${id}`);
    const panel = page.getByRole("region", { name: "Menyiapkan judul, hook, dan caption klip" });
    const summary = panel.getByLabel("Hasil per tahap");
    await expect(summary.locator("dt")).toHaveText(["Transkrip", "Momen"]);
    await expect(summary.locator("dd")).toHaveText(["2.304 kata · dari audio", "4 dipilih AI"]);
  });

  test("posters open one detail panel; the arrows move between clips; 'Skor 8+' filters", async ({ page }) => {
    await fakeProject(page);
    await login(page, "/projects");
    await page.goto(`/projects/${JOB_ID}`);
    await expect(posters(page)).toHaveCount(4);
    await expect(detailTitle(page)).toHaveText(TITLES[0]);
    await expect(posters(page).nth(0).getByRole("button")).toHaveAttribute("aria-current", "true");

    // The score is a neutral number; only 8 and up carry the mark. No score is called hot or viral.
    for (const [position, high] of [[0, 1], [1, 0], [2, 1], [3, 1]]) {
      await expect(posters(page).nth(position).locator("[data-high]")).toHaveCount(high);
    }
    await expect(page.getByText(/\bhot\b|viral/i)).toHaveCount(0);
    // The editor listing marks clip 1 as edited on its poster, and its detail offers "Edit klip" first.
    await expect(posters(page).nth(0)).toContainText("Diedit");
    await expect(detail(page).getByRole("link", { name: "Edit klip" })).toHaveAttribute("href", `/projects/${JOB_ID}/clips/${CLIP_ID}/edit`);

    // A clip that fell back says so: the framing on its poster, every note in the detail panel.
    await expect(detailNotes(page)).toHaveCount(0);
    await expect(posters(page).nth(0)).not.toContainText("Potong tengah");
    await expect(posters(page).nth(1)).toContainText("Potong tengah");
    await expect(posters(page).nth(3)).toContainText("Potong tengah");
    await expect(posters(page).nth(3)).not.toContainText("cadangan");
    await posters(page).nth(1).getByRole("button").click();
    await expect(detailNotes(page).getByRole("listitem")).toHaveText(["Wajah tidak terdeteksi · potong tengah"]);

    await expect(detail(page).getByText("Rentang waktu kamu", { exact: true })).toHaveCount(0);
    await posters(page).nth(2).getByRole("button").click();
    await expect(detailTitle(page)).toHaveText(TITLES[2]);
    await expect(posters(page).nth(2).getByRole("button")).toHaveAttribute("aria-current", "true");
    // A clip cut from the person's own range says so among its tags.
    await expect(detail(page).getByText("Rentang waktu kamu", { exact: true })).toBeVisible();
    await expect(detail(page).getByRole("link", { name: "Unduh MP4" }))
      .toHaveAttribute("href", `/api/jobs/${JOB_ID}/files/output/clip-03.mp4?download=1&name=03-ngopi-di-cafe`);
    await expect(detail(page).getByRole("link", { name: /Unduh subtitle SRT/ }))
      .toHaveAttribute("href", `/api/jobs/${JOB_ID}/files/output/clip-03.srt?download=1&name=03-ngopi-di-cafe`);

    await page.keyboard.press("ArrowRight");
    await expect(detailTitle(page)).toHaveText(TITLES[3]);
    await expect(posters(page).nth(3).getByRole("button")).toBeFocused();
    await expect(detailNotes(page).getByRole("listitem")).toHaveText(["Wajah tidak terdeteksi · potong tengah", "Dirender dengan cara cadangan"]);
    await page.keyboard.press("ArrowRight");
    await expect(detailTitle(page)).toHaveText(TITLES[3]);
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(detailTitle(page)).toHaveText(TITLES[1]);
    // The stepper in the detail panel does the same.
    await detail(page).getByRole("button", { name: "Klip berikutnya" }).click();
    await expect(detailTitle(page)).toHaveText(TITLES[2]);
    // Only the current poster is a tab stop.
    await expect(page.locator("[data-poster][tabindex='0']")).toHaveCount(1);

    const filters = page.getByRole("group", { name: "Saring klip" });
    await expect(filters.getByRole("button")).toHaveText([/^Semua\s+4$/, /^Skor 8\+\s+3$/]);
    await filters.getByRole("button", { name: /^Skor 8\+/ }).click();
    await expect(posters(page)).toHaveCount(3);
    await expect(filters.getByRole("button", { name: /^Skor 8\+/ })).toHaveAttribute("aria-pressed", "true");
    await filters.getByRole("button", { name: /^Semua/ }).click();
    await expect(posters(page)).toHaveCount(4);

    if (AXE) expect(await axeSerious(page)).toEqual([]);
  });
});

test.describe("project workspace with a clip that failed to render (faked job API)", () => {
  test.beforeEach(() => skipWithoutCredentials(test));

  test("the failed clip says 'Gagal' and why, with nothing to play, download or edit", async ({ page }) => {
    await fakeProject(page, { job: PARTLY_FAILED_JOB });
    await login(page, "/projects");
    await page.goto(`/projects/${JOB_ID}`);
    await expect(posters(page)).toHaveCount(4);
    await expect(page.getByRole("heading", { level: 2, name: "3 dari 4 klip siap diunggah" })).toBeVisible();
    await expect(page.getByText("3 klip · 1 gagal", { exact: true })).toBeVisible();
    await expect(posters(page).nth(1)).toHaveAttribute("data-failed", "true");
    await expect(posters(page).nth(1)).toContainText("Gagal");
    await expect(page.locator("[data-failed]")).toHaveCount(1);

    await posters(page).nth(1).getByRole("button").click();
    await expect(detailTitle(page)).toHaveText(TITLES[1]);
    await expect(detail(page).locator("video")).toHaveCount(0);
    await expect(detail(page)).toContainText("Render klip ini melewati batas waktu.");
    await expect(detail(page)).toContainText("Klip lain tidak terpengaruh. Untuk mencoba lagi, proses ulang videonya.");
    for (const name of ["Unduh MP4", /Unduh subtitle SRT/, "Edit klip"]) {
      await expect(detail(page).getByRole("link", { name })).toHaveCount(0);
    }
    // The next clip plays as before.
    await page.keyboard.press("ArrowRight");
    await expect(detailTitle(page)).toHaveText(TITLES[2]);
    await expect(detail(page).locator("video")).toHaveCount(1);
    await posters(page).nth(1).getByRole("button").click();
    if (AXE) expect(await axeSerious(page)).toEqual([]);
  });
});

test.describe("project workspace downloads (faked ZIP route)", () => {
  test.beforeEach(() => skipWithoutCredentials(test));

  // A second tab, as in read-only.spec: a started download and the refused ZIP's 413 are the
  // point here, and the watched tab's diagnostics count both as failures. Page errors are checked.
  async function openProbe(context, page, options) {
    await login(page, "/projects");
    const probe = await context.newPage();
    const errors = [];
    probe.on("pageerror", (error) => errors.push(error.message));
    const downloads = await fakeProject(probe, options);
    await probe.goto(`/projects/${JOB_ID}`);
    await expect(posters(probe)).toHaveCount(4);
    return { probe, errors, downloads };
  }

  test("'Pilih' picks clips by click or keyboard and 'Unduh (n)' zips them; 'Unduh semua' zips every clip", async ({ context, page }) => {
    const { probe, errors, downloads } = await openProbe(context, page);
    await probe.getByRole("button", { name: "Pilih", exact: true }).click();
    const bar = probe.getByRole("group", { name: "Pilih klip untuk diunduh" });
    await expect(bar).toContainText("0 dipilih");
    await expect(bar.getByRole("button", { name: "Unduh (0)" })).toBeDisabled();
    await expect(posters(probe).nth(0).getByRole("button")).toBeFocused();
    await probe.keyboard.press("Space");
    await probe.keyboard.press("ArrowRight");
    await probe.keyboard.press("ArrowRight");
    await probe.keyboard.press("Space");
    await expect(bar).toContainText("2 dipilih");
    await expect(posters(probe).nth(0).getByRole("button")).toHaveAttribute("aria-pressed", "true");
    await expect(posters(probe).nth(1).getByRole("button")).toHaveAttribute("aria-pressed", "false");
    await posters(probe).nth(3).getByRole("button").click();
    await expect(bar).toContainText("3 dipilih");

    await bar.getByRole("button", { name: "Unduh (3)" }).click();
    await expect.poll(() => downloads.length).toBe(1);
    expect(downloads[0].searchParams.get("clips")).toBe("1,3,4");
    await expect(probe.getByRole("status").filter({ hasText: "ZIP 3 klip (9 MB) mulai diunduh." })).toBeVisible();
    await expect(probe.getByRole("button", { name: "Pilih", exact: true })).toBeFocused();

    await probe.getByRole("button", { name: "Pilih", exact: true }).click();
    await probe.getByRole("button", { name: "Pilih semua" }).click();
    await expect(bar).toContainText("4 dipilih");
    await probe.keyboard.press("Escape");
    await expect(bar).toHaveCount(0);

    await probe.getByRole("button", { name: "Unduh semua" }).click();
    await expect.poll(() => downloads.length).toBe(2);
    expect(downloads[1].searchParams.has("clips")).toBe(false);
    expect(errors).toEqual([]);
    await probe.close();
  });

  test("in 'Pilih' a clip that failed to render cannot be picked; 'Pilih semua' leaves it out", async ({ context, page }) => {
    const { probe, errors, downloads } = await openProbe(context, page, { job: PARTLY_FAILED_JOB });
    await probe.getByRole("button", { name: "Pilih", exact: true }).click();
    const bar = probe.getByRole("group", { name: "Pilih klip untuk diunduh" });
    const failed = posters(probe).nth(1).getByRole("button");
    await expect(failed).toHaveAttribute("aria-disabled", "true");
    await expect(failed).not.toHaveAttribute("aria-pressed", /.*/);
    // aria-disabled: Playwright would wait for it to turn enabled; a person can still press it.
    await failed.click({ force: true });
    await expect(bar).toContainText("0 dipilih");
    await bar.getByRole("button", { name: "Pilih semua" }).click();
    await expect(bar).toContainText("3 dipilih");
    await bar.getByRole("button", { name: "Unduh (3)" }).click();
    await expect.poll(() => downloads.length).toBe(1);
    expect(downloads[0].searchParams.get("clips")).toBe("1,3,4");
    expect(errors).toEqual([]);
    await probe.close();
  });

  test("a ZIP over the size limit is refused on the page with the route's message", async ({ context, page }) => {
    const message = "ZIP-nya 2,4 GB, batasnya 2 GB. Pilih lebih sedikit klip, atau unduh satu per satu.";
    const { probe, errors, downloads } = await openProbe(context, page, { zipCheck: { status: 413, body: { error: message, code: "zip_too_large" } } });
    await probe.getByRole("button", { name: "Unduh semua" }).click();
    await expect(probe.getByRole("alert").filter({ hasText: message })).toBeVisible();
    expect(downloads).toHaveLength(0);
    expect(errors).toEqual([]);
    await probe.close();
  });
});

test.describe("project workspace at 390 px", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test.beforeEach(() => skipWithoutCredentials(test));

  test("one column, posters two across, the detail under them, 44 px targets, no horizontal scroll", async ({ page }) => {
    await fakeProject(page);
    await login(page, "/projects");
    await page.goto(`/projects/${JOB_ID}`);
    await expect(posters(page)).toHaveCount(4);
    const first = await posters(page).nth(0).boundingBox();
    const second = await posters(page).nth(1).boundingBox();
    expect(Math.abs(first.y - second.y)).toBeLessThan(2);
    const panel = await detail(page).boundingBox();
    expect(panel.y).toBeGreaterThan(first.y + first.height);
    expect(await overflow(page)).toBeLessThanOrEqual(0);

    await posters(page).nth(3).getByRole("button").tap();
    await expect(detailTitle(page)).toHaveText(TITLES[3]);
    await expect(detail(page)).toBeInViewport();

    const targets = [
      ...await page.getByRole("group", { name: "Saring klip" }).getByRole("button").all(),
      page.getByRole("button", { name: "Pilih", exact: true }),
      page.getByRole("button", { name: "Unduh semua" }),
      detail(page).getByRole("button", { name: "Klip sebelumnya" }),
      detail(page).getByRole("button", { name: "Klip berikutnya" }),
    ];
    for (const target of targets) {
      const box = await target.boundingBox();
      expect(box.height, await target.textContent()).toBeGreaterThanOrEqual(44);
      expect(box.width, await target.textContent()).toBeGreaterThanOrEqual(44);
    }
    await page.getByRole("button", { name: "Pilih", exact: true }).tap();
    await expect(page.getByRole("group", { name: "Pilih klip untuk diunduh" })).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });
});
