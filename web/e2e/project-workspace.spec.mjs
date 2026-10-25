import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { expect } from "@playwright/test";

import { login, skipWithoutCredentials, test } from "./support/harness.mjs";
import { L } from "./support/i18n.mjs";

// The project page (05-ui-dashboard.md §6.4): the stepper while it runs, the poster grid in
// Terbaik or Urutan video order with the Semua / Skor 8+ / Diedit filters, the clip viewer (a
// Modal at ?klip=N) with ←/→ between clips, "Pilih" mode with "Unduh (n)" and "Unduh semua"
// through the ZIP route, "NN-judul" download names, and the notes of clips that fell back. The
// job API, the clips listing and the ZIP route are faked inside the browser (page.route), so
// nothing on the server changes; only the login is real. Run against a production build, like
// e2e/focus.spec.mjs.

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
  // A started download is a browser download, which page.route never sees: the downloads are
  // read from the page's download events (the URL names the picked clips).
  const downloads = [];
  target.on("download", (download) => {
    downloads.push(new URL(download.url()));
    void download.cancel();
  });
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
      return route.fulfill({ status: 200, contentType: "application/zip", headers: { "Content-Disposition": "attachment; filename=\"podcast-12-klip.zip\"", "Cache-Control": "no-store" }, body: ZIP_BYTES });
    }
    return route.fulfill({ status: 200, contentType: "video/mp4", body: "" });
  });
  return downloads;
}

const posters = (target) => target.getByRole("article");
// The poster of clip `n` (its number, whatever the order), and its button.
const poster = (target, n) => target.getByRole("article").filter({ has: target.locator(`[data-poster="${n}"]`) });
const posterButton = (target, n) => target.locator(`[data-poster="${n}"]`);
const viewer = (target) => target.getByRole("dialog");
const viewerTitle = (target) => viewer(target).getByRole("heading", { level: 3 });
const viewerNotes = (target) => viewer(target).getByRole("list", { name: L("project.viewer.notes") });
const overflow = (target) => target.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const sortBy = (target, key) => target.getByRole("radiogroup", { name: L("project.sort.label") }).getByRole("radio", { name: L(key) }).click();
const filters = (target) => target.getByRole("radiogroup", { name: L("project.filter.label") });

async function openClip(target, n) {
  if (await viewer(target).count()) {
    await target.keyboard.press("Escape");
    await expect(viewer(target)).toHaveCount(0);
  }
  await posterButton(target, n).click();
  await expect(viewer(target)).toBeVisible();
}

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

async function axeSerious(target, selector = "#klip") {
  if (!(await target.evaluate(() => Boolean(window.axe)))) await target.addScriptTag({ content: AXE });
  const result = await target.evaluate((scope) => window.axe.run(scope, { resultTypes: ["violations"] }), selector);
  return result.violations.filter((violation) => ["serious", "critical"].includes(violation.impact))
    // The offending markup too, so a failure names the element.
    .map((violation) => ({ id: violation.id, nodes: violation.nodes.length, html: violation.nodes.map((node) => `${node.html.slice(0, 160)} ${node.failureSummary || ""}`.trim()) }));
}

test.describe("project workspace (faked job API)", () => {
  test.beforeEach(() => skipWithoutCredentials(test));

  test("a running project shows the stepper, the clips ready so far and what its finished stages found", async ({ page }) => {
    const id = "9d3f5a71-8b2c-4d4e-8f60-1b2c3d4e5f60";
    const running = {
      id, status: "processing", progress: 63, stage: "packaging", stageDetail: "Menyiapkan judul, hook, dan caption klip",
      createdAt: iso(NOW), updatedAt: iso(NOW), source: { type: "upload", name: "Podcast 13.mp4" },
      options: { selectionMode: "v3", llmMode: "auto" }, clips: [clip(1)],
      stageSummary: { transcript: { words: 2304, source: "whisper", language: "id" }, moments: { count: 4, source: "llm" } },
    };
    await page.route(new RegExp(`/api/jobs/${id}(?:[/?].*)?$`), (route) => route.fulfill({
      status: 200, contentType: "application/json", headers: { "Cache-Control": "no-store" }, body: JSON.stringify({ job: running }),
    }));
    await login(page, "/projects");
    await page.goto(`/projects/${id}`);
    const panel = page.getByRole("region", { name: `${L("status.process.running")} · Menyiapkan judul, hook, dan caption klip` });
    await expect(panel.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "63");
    // An upload has no download step; packaging is in Pilih momen.
    await expect(panel.getByRole("listitem")).toHaveText([
      new RegExp(`^${L("project.step.transcript")}`), L("project.step.moments"), L("project.step.render"),
    ]);
    await expect(panel.locator('[aria-current="step"]')).toHaveText(L("project.step.moments"));
    await expect(panel.getByText(L("project.progress.ready", { count: 1 }), { exact: true })).toBeVisible();
    // The clip that is ready already shows in the grid.
    await expect(posters(page)).toHaveCount(1);
    const summary = panel.getByLabel("Hasil per tahap");
    await expect(summary.locator("dt")).toHaveText(["Transkrip", "Momen"]);
    await expect(summary.locator("dd")).toHaveText(["2.304 kata · dari audio", "4 dipilih AI"]);
  });

  test("a project whose video is not Indonesian shows the language note", async ({ page }) => {
    await fakeProject(page, { job: { ...JOB, source: { type: "youtube", url: "https://youtu.be/rBg0ZcwjVKQ" }, sourceLanguage: "en", options: { ...JOB.options, videoLanguage: "auto" } } });
    await login(page, "/projects");
    await page.goto(`/projects/${JOB_ID}`);
    await expect(page.getByText("Bahasa video terdeteksi: Inggris. Hasil caption mengikuti bahasa ini.")).toBeVisible();
  });

  test("Terbaik orders by score; a poster opens the viewer at ?klip=N; ←/→ move; Escape returns to the poster", async ({ page }) => {
    await fakeProject(page);
    await login(page, "/projects");
    await page.goto(`/projects/${JOB_ID}`);
    await expect(posters(page)).toHaveCount(4);
    // Terbaik: 9, 8,4, 8,0 (7,95), 6,1.
    await expect(page.locator("[data-poster]").first()).toHaveAttribute("data-poster", /./);
    expect(await page.locator("[data-poster]").evaluateAll((nodes) => nodes.map((node) => node.dataset.poster))).toEqual(["4", "1", "3", "2"]);
    await sortBy(page, "project.sort.timeline");
    expect(await page.locator("[data-poster]").evaluateAll((nodes) => nodes.map((node) => node.dataset.poster))).toEqual(["1", "2", "3", "4"]);

    // The score is a neutral number; only 8 and up carry the mark. No score is called hot or viral.
    for (const [n, high] of [[1, 1], [2, 0], [3, 1], [4, 1]]) await expect(poster(page, n).locator("[data-high]")).toHaveCount(high);
    await expect(page.getByText(/\bhot\b|viral/i)).toHaveCount(0);
    // The editor listing marks clip 1 as edited on its poster.
    await expect(poster(page, 1)).toContainText("Diedit");
    // A clip that fell back says so on its poster.
    await expect(poster(page, 1)).not.toContainText(L("layout.names.fill_center"));
    await expect(poster(page, 2)).toContainText(L("layout.names.fill_center"));
    await expect(poster(page, 4)).toContainText(L("layout.names.fill_center"));
    await expect(poster(page, 4)).not.toContainText("cadangan");

    await openClip(page, 1);
    await expect(page).toHaveURL(/\?klip=1$/);
    await expect(viewerTitle(page)).toHaveText(TITLES[0]);
    await expect(viewer(page).getByRole("heading", { level: 2 })).toHaveText(L("project.viewer.position", { n: 1, total: 4 }));
    // "Edit klip" is a plain link: the editor loads as a full document (COOP/COEP).
    await expect(viewer(page).getByRole("link", { name: L("project.viewer.editClip") })).toHaveAttribute("href", `/projects/${JOB_ID}/clips/${CLIP_ID}/edit`);
    await expect(viewerNotes(page)).toHaveCount(0);

    await page.keyboard.press("ArrowRight");
    await expect(viewerTitle(page)).toHaveText(TITLES[1]);
    await expect(page).toHaveURL(/\?klip=2$/);
    await expect(viewerNotes(page).getByRole("listitem")).toHaveText(["Wajah tidak terdeteksi · potong tengah"]);
    await page.keyboard.press("ArrowRight");
    // A clip cut from the person's own range says so among its tags; downloads keep their names.
    await expect(viewerTitle(page)).toHaveText(TITLES[2]);
    await expect(viewer(page).getByText("Rentang waktu kamu", { exact: true })).toBeVisible();
    await expect(viewer(page).getByRole("link", { name: L("project.viewer.downloadMp4") }))
      .toHaveAttribute("href", `/api/jobs/${JOB_ID}/files/output/clip-03.mp4?download=1&name=03-ngopi-di-cafe`);
    await expect(viewer(page).getByRole("link", { name: L("project.viewer.srtFor", { clip: "Klip 03 · 0:33" }) }))
      .toHaveAttribute("href", `/api/jobs/${JOB_ID}/files/output/clip-03.srt?download=1&name=03-ngopi-di-cafe`);
    await page.keyboard.press("ArrowRight");
    await expect(viewerTitle(page)).toHaveText(TITLES[3]);
    await expect(viewerNotes(page).getByRole("listitem")).toHaveText(["Wajah tidak terdeteksi · potong tengah", "Dirender dengan cara cadangan"]);
    await page.keyboard.press("ArrowRight");
    await expect(viewerTitle(page)).toHaveText(TITLES[3], { timeout: 1000 });
    // The arrows in the header do the same.
    await viewer(page).getByRole("button", { name: L("aria.prev") }).click();
    await expect(viewerTitle(page)).toHaveText(TITLES[2]);
    await page.keyboard.press("Escape");
    await expect(viewer(page)).toHaveCount(0);
    await expect(page).not.toHaveURL(/klip=/);
    await expect(posterButton(page, 3)).toBeFocused();

    await expect(filters(page).getByRole("radio")).toHaveText([/^Semua\s+4$/, /^Skor 8\+\s+3$/, /^Diedit\s+1$/]);
    await filters(page).getByRole("radio", { name: /^Skor 8\+/ }).click();
    await expect(posters(page)).toHaveCount(3);
    await expect(filters(page).getByRole("radio", { name: /^Skor 8\+/ })).toHaveAttribute("aria-checked", "true");
    await filters(page).getByRole("radio", { name: /^Semua/ }).click();
    await expect(posters(page)).toHaveCount(4);
    // "Diedit": the clips whose poster says "Diedit" (the listing names clip 1 as edited).
    await filters(page).getByRole("radio", { name: /^Diedit/ }).click();
    await expect(posters(page)).toHaveCount(1);
    await expect(posters(page).nth(0)).toContainText("Diedit");
    await filters(page).getByRole("radio", { name: /^Semua/ }).click();
    await expect(posters(page)).toHaveCount(4);

    if (AXE) expect(await axeSerious(page)).toEqual([]);
  });

  test("a link with ?klip=N opens that clip in the viewer", async ({ page }) => {
    await fakeProject(page);
    await login(page, "/projects");
    await page.goto(`/projects/${JOB_ID}?klip=3`);
    await expect(viewerTitle(page)).toHaveText(TITLES[2]);
    if (AXE) expect(await axeSerious(page, "[role=dialog]")).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(viewer(page)).toHaveCount(0);
  });
});

test.describe("project workspace with a clip that failed to render (faked job API)", () => {
  test.beforeEach(() => skipWithoutCredentials(test));

  test("the failed clip says 'Gagal' and why, with nothing to play, download or edit", async ({ page }) => {
    await fakeProject(page, { job: PARTLY_FAILED_JOB });
    await login(page, "/projects");
    await page.goto(`/projects/${JOB_ID}`);
    await expect(posters(page)).toHaveCount(4);
    // The facts line counts the clips that rendered.
    await expect(page.getByText(L("project.clipCount", { count: 3 }), { exact: true })).toBeVisible();
    await expect(poster(page, 2)).toHaveAttribute("data-failed", "true");
    await expect(poster(page, 2)).toContainText("Gagal");
    await expect(page.locator("[data-failed]")).toHaveCount(1);

    await sortBy(page, "project.sort.timeline");
    await openClip(page, 2);
    await expect(viewerTitle(page)).toHaveText(TITLES[1]);
    await expect(viewer(page).locator("video")).toHaveCount(0);
    await expect(viewer(page)).toContainText("Render klip ini melewati batas waktu.");
    await expect(viewer(page)).toContainText("Klip lain tidak terpengaruh. Untuk mencoba lagi, proses ulang videonya.");
    for (const name of [L("project.viewer.downloadMp4"), L("project.viewer.srt"), L("project.viewer.editClip")]) {
      await expect(viewer(page).getByRole("link", { name })).toHaveCount(0);
    }
    // Its title and description cannot be changed either: there is no video to post.
    for (const name of ["Ubah judul dan deskripsi", "Tulis ulang"]) {
      await expect(viewer(page).getByRole("button", { name, exact: true })).toHaveCount(0);
    }
    // The next clip plays and can be changed as before.
    await page.keyboard.press("ArrowRight");
    await expect(viewerTitle(page)).toHaveText(TITLES[2]);
    await expect(viewer(page).locator("video")).toHaveCount(1);
    await expect(viewer(page).getByRole("button", { name: "Ubah judul dan deskripsi", exact: true })).toHaveCount(1);
    if (AXE) expect(await axeSerious(page, "[role=dialog]")).toEqual([]);
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
    await sortBy(probe, "project.sort.timeline");
    return { probe, errors, downloads };
  }

  const pickBar = (probe) => probe.getByRole("group", { name: L("project.bulk.label") });
  const pickButton = (probe) => probe.getByRole("button", { name: L("project.select"), exact: true });

  test("'Pilih' picks clips by click or keyboard and 'Unduh (n)' zips them; 'Unduh semua' zips every clip", async ({ context, page }) => {
    const { probe, errors, downloads } = await openProbe(context, page);
    await pickButton(probe).click();
    const bar = pickBar(probe);
    await expect(bar).toContainText(L("project.bulk.count", { count: 0 }));
    await expect(bar.getByRole("button", { name: L("project.bulk.download", { n: 0 }) })).toBeDisabled();
    await expect(posterButton(probe, 1)).toBeFocused();
    await probe.keyboard.press("Space");
    await probe.keyboard.press("Tab");
    await probe.keyboard.press("Tab");
    await expect(posterButton(probe, 3)).toBeFocused();
    await probe.keyboard.press("Space");
    await expect(bar).toContainText(L("project.bulk.count", { count: 2 }));
    await expect(posterButton(probe, 1)).toHaveAttribute("aria-pressed", "true");
    await expect(posterButton(probe, 2)).toHaveAttribute("aria-pressed", "false");
    await posterButton(probe, 4).click();
    await expect(bar).toContainText(L("project.bulk.count", { count: 3 }));
    // In Pilih a poster toggles; the viewer stays closed.
    await expect(viewer(probe)).toHaveCount(0);

    await bar.getByRole("button", { name: L("project.bulk.download", { n: 3 }) }).click();
    await expect.poll(() => downloads.length).toBe(1);
    expect(downloads[0].searchParams.get("clips")).toBe("1,3,4");
    await expect(probe.getByRole("status").filter({ hasText: L("project.zip.started", { count: 3, size: "9 MB" }) })).toBeVisible();
    await expect(pickButton(probe)).toBeFocused();

    await pickButton(probe).click();
    await probe.getByRole("button", { name: L("project.bulk.all") }).click();
    await expect(bar).toContainText(L("project.bulk.count", { count: 4 }));
    await probe.keyboard.press("Escape");
    await expect(bar).toHaveCount(0);

    await probe.getByRole("button", { name: L("project.downloadAll") }).click();
    await expect.poll(() => downloads.length).toBe(2);
    expect(downloads[1].searchParams.has("clips")).toBe(false);
    expect(errors).toEqual([]);
    await probe.close();
  });

  test("in 'Pilih' a clip that failed to render cannot be picked; 'Pilih semua' leaves it out", async ({ context, page }) => {
    const { probe, errors, downloads } = await openProbe(context, page, { job: PARTLY_FAILED_JOB });
    await pickButton(probe).click();
    const bar = pickBar(probe);
    const failed = posterButton(probe, 2);
    await expect(failed).toHaveAttribute("aria-disabled", "true");
    await expect(failed).not.toHaveAttribute("aria-pressed", /.*/);
    // aria-disabled: Playwright would wait for it to turn enabled; a person can still press it.
    await failed.click({ force: true });
    await expect(bar).toContainText(L("project.bulk.count", { count: 0 }));
    await bar.getByRole("button", { name: L("project.bulk.all") }).click();
    await expect(bar).toContainText(L("project.bulk.count", { count: 3 }));
    await bar.getByRole("button", { name: L("project.bulk.download", { n: 3 }) }).click();
    await expect.poll(() => downloads.length).toBe(1);
    expect(downloads[0].searchParams.get("clips")).toBe("1,3,4");
    expect(errors).toEqual([]);
    await probe.close();
  });

  test("a ZIP over the size limit is refused on the page with the route's message", async ({ context, page }) => {
    const message = "ZIP-nya 2,4 GB, batasnya 2 GB. Pilih lebih sedikit klip, atau unduh satu per satu.";
    const { probe, errors, downloads } = await openProbe(context, page, { zipCheck: { status: 413, body: { error: message, code: "zip_too_large" } } });
    await probe.getByRole("button", { name: L("project.downloadAll") }).click();
    await expect(probe.getByRole("alert").filter({ hasText: message })).toBeVisible();
    expect(downloads).toHaveLength(0);
    expect(errors).toEqual([]);
    await probe.close();
  });
});

test.describe("project workspace at 390 px", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test.beforeEach(() => skipWithoutCredentials(test));

  test("posters two across, the viewer full screen, 44 px targets, no horizontal scroll", async ({ page }) => {
    await fakeProject(page);
    await login(page, "/projects");
    await page.goto(`/projects/${JOB_ID}`);
    await expect(posters(page)).toHaveCount(4);
    const first = await posters(page).nth(0).boundingBox();
    const second = await posters(page).nth(1).boundingBox();
    expect(Math.abs(first.y - second.y)).toBeLessThan(2);
    expect(await overflow(page)).toBeLessThanOrEqual(0);

    const targets = [
      ...await filters(page).getByRole("radio").all(),
      page.getByRole("button", { name: L("project.select"), exact: true }),
      page.getByRole("button", { name: L("project.downloadAll") }),
    ];
    for (const target of targets) {
      const box = await target.boundingBox();
      expect(box.height, await target.textContent()).toBeGreaterThanOrEqual(44);
      expect(box.width, await target.textContent()).toBeGreaterThanOrEqual(44);
    }

    await posterButton(page, 4).tap();
    await expect(viewerTitle(page)).toHaveText(TITLES[3]);
    const dialog = await viewer(page).boundingBox();
    expect(dialog.width).toBeGreaterThan(380);
    for (const name of [L("aria.prev"), L("aria.next"), L("aria.close")]) {
      const box = await viewer(page).getByRole("button", { name }).boundingBox();
      expect(box.height, name).toBeGreaterThanOrEqual(44);
      expect(box.width, name).toBeGreaterThanOrEqual(44);
    }
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: L("project.select"), exact: true }).tap();
    await expect(page.getByRole("group", { name: L("project.bulk.label") })).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });
});
