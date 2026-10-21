import { expect } from "@playwright/test";

import { login, skipWithoutCredentials, test } from "./support/harness.mjs";

// Riwayat's "Klip" view (plan A7): the "Proyek | Klip" switch, remembered across reloads; a grid of
// the project page's posters across projects, grouped under "Hari ini" and "Lebih lama"; search,
// "Skor 8+" and "Minggu ini" asked of the server; "Muat lagi"; each card opening its clip in its
// project (?klip=N). The clip listing and the job API are faked inside the browser (page.route),
// so nothing on the server changes; only the login is real. Run against a production build, like
// e2e/project-workspace.spec.mjs.

const JOB_A = "8c2e4f60-7a1b-4c3d-9e5f-0a1b2c3d4e5f";
const JOB_B = "1d3f5a70-8b2c-4d4e-af60-1b2c3d4e5f60";
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

function item(jobId, index, title, score, ageDays) {
  return {
    jobId, index, title, duration: 30 + index, posterUrl: null, score,
    projectName: jobId === JOB_A ? "Podcast 12.mp4" : "YouTube · abcDEF12345",
    sourceUrl: jobId === JOB_A ? null : "https://www.youtube.com/watch?v=abcDEF12345",
    createdAt: iso(NOW - ageDays * 86_400_000),
  };
}

const LIBRARY = [
  item(JOB_A, 1, "Rahasia hook di 3 detik", 8.4, 0),
  item(JOB_A, 2, "Ngopi di café", 6.1, 0),
  item(JOB_A, 3, "Kenapa 90% orang gagal", 9, 0),
  item(JOB_B, 1, "Wawancara panjang", 7.2, 20),
  item(JOB_B, 2, "Penutup yang manis", null, 20),
];
const PAGE_SIZE = 3;

/** Fakes GET /api/clips (search, chips, cursor) and the job behind JOB_A; returns the listing URLs it saw. */
async function fakeLibrary(target, { fail = false } = {}) {
  const requests = [];
  await target.route(/\/api\/clips(?:\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    if (fail && requests.length === 1) {
      return route.fulfill({ status: 503, json: { error: "Klip tidak bisa dibaca sekarang. Coba lagi sebentar lagi.", code: "read_failed" } });
    }
    const q = (url.searchParams.get("q") || "").toLowerCase();
    const since = url.searchParams.has("since") ? Date.parse(url.searchParams.get("since")) : null;
    const matched = LIBRARY.filter((clip) => (!q || `${clip.title}\n${clip.projectName}`.toLowerCase().includes(q))
      && (url.searchParams.get("high") !== "1" || (clip.score ?? 0) >= 8)
      && (since === null || Date.parse(clip.createdAt) >= since));
    const from = url.searchParams.has("cursor") ? Number(url.searchParams.get("cursor")) : 0;
    const clips = matched.slice(from, from + PAGE_SIZE);
    const next = from + clips.length < matched.length ? String(from + clips.length) : null;
    return route.fulfill({
      status: 200, headers: { "Cache-Control": "no-store" },
      json: { clips, matched: matched.length, total: LIBRARY.length, projects: 2, nextCursor: next, partial: false },
    });
  });
  await target.route(new RegExp(`/api/jobs/${JOB_A}(?:[/?].*)?$`), (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === `/api/jobs/${JOB_A}`) {
      const clips = LIBRARY.filter((clip) => clip.jobId === JOB_A).map((clip) => ({
        index: clip.index, title: clip.title, score: clip.score, selectionSource: "llm", duration: clip.duration, text: "transkrip",
        description: "Deskripsi.\n\n#fyp", hashtags: ["#fyp"],
        videoUrl: `/api/jobs/${JOB_A}/files/output/clip-0${clip.index}.mp4`,
        downloadUrl: `/api/jobs/${JOB_A}/files/output/clip-0${clip.index}.mp4?download=1`,
      }));
      const job = {
        id: JOB_A, status: "completed", progress: 100, createdAt: iso(NOW), updatedAt: iso(NOW),
        source: { type: "upload", name: "Podcast 12.mp4" }, options: { selectionMode: "v3" }, clips,
      };
      return route.fulfill({ status: 200, headers: { "Cache-Control": "no-store" }, json: { job } });
    }
    if (url.pathname === `/api/jobs/${JOB_A}/clips`) return route.fulfill({ status: 200, json: { clips: [] } });
    return route.fulfill({ status: 200, contentType: "video/mp4", body: "" });
  });
  return requests;
}

const cards = (target) => target.getByRole("list", { name: "Klip" }).getByRole("article");
const views = (target) => target.getByRole("group", { name: "Tampilan riwayat" });
const chips = (target) => target.getByRole("group", { name: "Saring klip" });
const overflow = (target) => target.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe("Riwayat: Klip view (faked clip listing)", () => {
  test.beforeEach(() => skipWithoutCredentials(test));

  test("the switch opens the clip grid and remembers it; 'Muat lagi' appends; a card opens its clip", async ({ page }) => {
    const requests = await fakeLibrary(page);
    await login(page, "/projects");
    await expect(page.getByRole("heading", { level: 1, name: "Riwayat proyek" })).toBeVisible();
    await views(page).getByRole("button", { name: "Klip" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Riwayat klip" })).toBeVisible();
    await expect(views(page).getByRole("button", { name: "Klip" })).toHaveAttribute("aria-pressed", "true");
    await expect(cards(page)).toHaveCount(3);
    await expect(page.getByText("5 klip dari 2 proyek")).toBeVisible();
    // Neutral score pills; only 8 and up carry the mark. No score is called hot or viral.
    for (const [position, high] of [[0, 1], [1, 0], [2, 1]]) await expect(cards(page).nth(position).locator("[data-high]")).toHaveCount(high);
    await expect(page.getByText(/\bhot\b|viral/i)).toHaveCount(0);
    await expect(cards(page).nth(0)).toContainText("Podcast 12.mp4");
    // Grouped by day: today's clips under "Hari ini"; the older page lands under "Lebih lama".
    await expect(page.getByRole("heading", { level: 2, name: "Hari ini" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Lebih lama" })).toHaveCount(0);

    await page.getByRole("button", { name: "Muat lagi" }).click();
    await expect(cards(page)).toHaveCount(5);
    await expect(cards(page).nth(3).getByRole("link")).toBeFocused();
    await expect(page.getByRole("heading", { level: 2, name: "Lebih lama" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Muat lagi" })).toHaveCount(0);
    expect(requests.at(-1).searchParams.get("cursor")).toBe("3");

    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Riwayat klip" })).toBeVisible();
    await expect(cards(page)).toHaveCount(3);

    await page.getByRole("searchbox", { name: "Cari klip" }).fill("ngopi");
    await expect(cards(page)).toHaveCount(1);
    expect(requests.at(-1).searchParams.get("q")).toBe("ngopi");
    await chips(page).getByRole("button", { name: "Skor 8+" }).click();
    await expect(chips(page).getByRole("button", { name: "Skor 8+" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("strong", { hasText: "Tidak ada klip yang cocok" })).toBeVisible();
    await page.getByRole("button", { name: "Tampilkan semua klip" }).click();
    await expect(cards(page)).toHaveCount(3);
    await expect(page.getByRole("searchbox", { name: "Cari klip" })).toHaveValue("");

    await chips(page).getByRole("button", { name: "Minggu ini" }).click();
    await expect.poll(() => requests.at(-1).searchParams.has("since")).toBe(true);
    await expect(cards(page)).toHaveCount(3);

    await cards(page).nth(1).getByRole("link").click();
    await page.waitForURL((url) => url.pathname === `/projects/${JOB_A}` && url.searchParams.get("klip") === "2");
    await expect(page.locator("[data-clip-detail]").getByRole("heading", { level: 3 })).toHaveText("Ngopi di café");
    await expect(page.locator("[data-poster='2']")).toBeFocused();
  });

  test("a listing that cannot be read says so and loads again on 'Coba lagi'", async ({ context, page }) => {
    // A second tab: the refused request is the point here, and the watched tab counts it as a failure.
    await login(page, "/projects");
    const probe = await context.newPage();
    const errors = [];
    probe.on("pageerror", (error) => errors.push(error.message));
    await fakeLibrary(probe, { fail: true });
    await probe.goto("/projects");
    await views(probe).getByRole("button", { name: "Klip" }).click();
    await expect(probe.getByRole("alert").filter({ hasText: "Klip tidak bisa dimuat" })).toBeVisible();
    await probe.getByRole("button", { name: "Coba lagi" }).click();
    await expect(cards(probe)).toHaveCount(3);
    expect(errors).toEqual([]);
    await probe.close();
  });
});

test.describe("Riwayat: Klip view at 390 px", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test.beforeEach(() => skipWithoutCredentials(test));

  test("posters two across, 44 px targets, no horizontal scroll", async ({ page }) => {
    await fakeLibrary(page);
    await login(page, "/projects");
    await views(page).getByRole("button", { name: "Klip" }).tap();
    await expect(cards(page)).toHaveCount(3);
    const first = await cards(page).nth(0).boundingBox();
    const second = await cards(page).nth(1).boundingBox();
    expect(Math.abs(first.y - second.y)).toBeLessThan(2);
    expect(second.x).toBeGreaterThan(first.x);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    const targets = [
      ...await views(page).getByRole("button").all(),
      ...await chips(page).getByRole("button").all(),
      page.getByRole("button", { name: "Muat lagi" }),
    ];
    for (const target of targets) {
      const box = await target.boundingBox();
      expect(box.height, await target.textContent()).toBeGreaterThanOrEqual(44);
      expect(box.width, await target.textContent()).toBeGreaterThanOrEqual(44);
    }
    await page.getByRole("button", { name: "Muat lagi" }).tap();
    await expect(cards(page)).toHaveCount(5);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });
});
