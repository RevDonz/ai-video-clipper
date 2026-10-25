import { expect } from "@playwright/test";

import { choose } from "./support/choice.mjs";
import { expectFailedRequest, login, skipWithoutCredentials, test } from "./support/harness.mjs";
import { L } from "./support/i18n.mjs";

// Proyek (05-ui-dashboard.md §6.8): the status filter with counts and the search kept in the URL,
// ⋯ per row, and the batch delete through one AlertDialog with a toast that counts what went
// and what did not. GET /api/jobs and DELETE /api/jobs/<id> are faked inside the browser
// (page.route), so nothing on the server changes; only the login is real.

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const JOBS = [
  { id: "8c2e4f60-7a1b-4c3d-9e5f-0a1b2c3d4e5f", status: "completed", progress: 100, createdAt: iso(NOW - 2 * 3_600_000), source: { type: "upload", name: "Podcast 12.mp4" }, options: { selectionMode: "v3" }, clips: [{ index: 1, title: "Satu" }, { index: 2, title: "Dua" }] },
  { id: "1d3f5a70-8b2c-4d4e-af60-1b2c3d4e5f60", status: "processing", progress: 40, createdAt: iso(NOW - 300_000), source: { type: "upload", name: "Wawancara pasar.mp4" }, clips: [] },
  { id: "2e4a6b80-9c3d-4e5f-b071-2c3d4e5f6a71", status: "failed", progress: 12, createdAt: iso(NOW - 86_400_000), source: { type: "upload", name: "Kajian subuh.mp4" }, clips: [] },
];

/** Fakes the list and the delete; `refuse` names ids whose DELETE answers 500. Returns the DELETE paths. */
async function fakeJobs(page, { refuse = [] } = {}) {
  const state = { jobs: structuredClone(JOBS), deletes: [] };
  await page.route(/\/api\/jobs(?:\/[^/?]+)?(?:\?.*)?$/, (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/jobs" && request.method() === "GET") {
      return route.fulfill({ status: 200, headers: { "Cache-Control": "no-store" }, json: { jobs: state.jobs, editor: true } });
    }
    const match = /^\/api\/jobs\/([^/]+)$/.exec(url.pathname);
    // The header badge reads the running project on its own.
    if (match && request.method() === "GET") {
      const job = state.jobs.find((item) => item.id === decodeURIComponent(match[1]));
      return job ? route.fulfill({ status: 200, headers: { "Cache-Control": "no-store" }, json: { job } }) : route.continue();
    }
    if (match && request.method() === "DELETE") {
      const id = decodeURIComponent(match[1]);
      state.deletes.push(url.pathname);
      if (refuse.includes(id)) return route.fulfill({ status: 500, json: { error: "Proyek tidak dapat dihapus", code: "delete_failed" } });
      state.jobs = state.jobs.filter((job) => job.id !== id);
      return route.fulfill({ status: 202, json: { job: { id, status: "deleting" }, removed: true } });
    }
    return route.continue();
  });
  return state;
}

const table = (page) => page.getByRole("grid", { name: L("projects.list") });
const row = (page, name) => table(page).getByRole("row").filter({ hasText: name });
const filters = (page) => page.getByRole("radiogroup", { name: L("projects.filter.label") });

test.describe("Proyek (faked job list)", () => {
  test.use({ viewport: { width: 1280, height: 900 } });
  test.beforeEach(() => skipWithoutCredentials(test));

  test("filters by status with counts, searches, and keeps both in the URL", async ({ page }) => {
    await fakeJobs(page);
    await login(page, "/projects");
    await expect(page.getByRole("heading", { level: 1, name: L("projects.title") })).toBeVisible();
    await expect(page.getByRole("tab", { name: L("projects.tab.projects") })).toHaveAttribute("aria-selected", "true");
    await expect(table(page).getByRole("row")).toHaveCount(4);
    await expect(filters(page).getByRole("radio", { name: L("projects.filter.all", { count: 3 }) })).toBeChecked();

    await filters(page).getByRole("radio", { name: L("projects.filter.failed", { count: 1 }) }).click();
    await expect(table(page).getByRole("row")).toHaveCount(2);
    await expect(row(page, "Kajian subuh.mp4")).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.get("status")).toBe("gagal");

    await page.reload();
    await expect(filters(page).getByRole("radio", { name: L("projects.filter.failed", { count: 1 }) })).toBeChecked();
    await filters(page).getByRole("radio", { name: L("projects.filter.all", { count: 3 }) }).click();
    await page.getByRole("searchbox", { name: L("projects.search") }).fill("wawancara");
    await expect(table(page).getByRole("row")).toHaveCount(2);
    await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("wawancara");
    await page.getByRole("searchbox", { name: L("projects.search") }).fill("tidak ada");
    await expect(page.getByRole("heading", { level: 2, name: L("projects.notFound") })).toBeVisible();
    await page.getByRole("button", { name: L("projects.showAll") }).click();
    await expect(table(page).getByRole("row")).toHaveCount(4);

    // ⋯ opens Buka, Edit klip (finished project, editor on) and Hapus; Edit klip is a plain link.
    await row(page, "Podcast 12.mp4").getByRole("button", { name: L("projects.action.more", { name: "Podcast 12.mp4" }) }).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: L("projects.action.edit") })).toHaveAttribute("href", `/projects/${JOBS[0].id}/clips/klip-1/edit`);
    await expect(menu.getByRole("menuitem", { name: L("projects.action.open") })).toHaveAttribute("href", `/projects/${JOBS[0].id}`);
    await page.keyboard.press("Escape");
    await row(page, "Kajian subuh.mp4").getByRole("button", { name: L("projects.action.more", { name: "Kajian subuh.mp4" }) }).click();
    await expect(page.getByRole("menu").getByRole("menuitem", { name: L("projects.action.edit") })).toHaveCount(0);
    await page.keyboard.press("Escape");

    // The Klip tab is in the URL too.
    await page.getByRole("tab", { name: L("projects.tab.clips") }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("tab")).toBe("klip");
  });

  test("one delete from ⋯ asks in an AlertDialog; Batal keeps the project, the confirmation removes it", async ({ page }) => {
    const state = await fakeJobs(page);
    await login(page, "/projects");
    const trigger = row(page, "Podcast 12.mp4").getByRole("button", { name: L("projects.action.more", { name: "Podcast 12.mp4" }) });
    await trigger.click();
    await page.getByRole("menu").getByRole("menuitem", { name: L("projects.action.delete") }).click();
    const dialog = page.getByRole("alertdialog", { name: L("projects.delete.confirm", { count: 1 }) });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: L("projects.delete.cancel") }).click();
    await expect(dialog).toHaveCount(0);
    expect(state.deletes).toEqual([]);

    await trigger.click();
    await page.getByRole("menu").getByRole("menuitem", { name: L("projects.action.delete") }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: L("projects.delete.submit") }).click();
    await expect(row(page, "Podcast 12.mp4")).toHaveCount(0);
    await expect(page.getByText(L("projects.delete.done", { count: 1 }), { exact: true })).toBeVisible();
    expect(state.deletes).toEqual([`/api/jobs/${JOBS[0].id}`]);
  });

  test("a batch delete that partly fails says how many went and keeps the refused one selected", async ({ page }) => {
    expectFailedRequest(page, 500, "DELETE", `/api/jobs/${JOBS[2].id}`);
    const state = await fakeJobs(page, { refuse: [JOBS[2].id] });
    await login(page, "/projects");
    await choose(row(page, "Podcast 12.mp4").getByRole("checkbox"));
    await choose(row(page, "Kajian subuh.mp4").getByRole("checkbox"));
    const bar = page.getByRole("region", { name: L("projects.selection.count", { count: 2 }) });
    await expect(bar).toBeVisible();
    await bar.getByRole("button", { name: L("projects.selection.delete", { count: 2 }) }).click();
    const dialog = page.getByRole("alertdialog", { name: L("projects.delete.confirm", { count: 2 }) });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: L("projects.delete.submit") }).click();
    await expect(page.getByText(L("projects.delete.partial", { ok: 1, failed: 1 }))).toBeVisible();
    await expect(row(page, "Podcast 12.mp4")).toHaveCount(0);
    await expect(row(page, "Kajian subuh.mp4")).toBeVisible();
    await expect(row(page, "Kajian subuh.mp4").getByRole("checkbox")).toBeChecked();
    expect(state.deletes.sort()).toEqual([`/api/jobs/${JOBS[0].id}`, `/api/jobs/${JOBS[2].id}`].sort());
  });
});

test.describe("Proyek at 360 px", () => {
  test.use({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });
  test.beforeEach(() => skipWithoutCredentials(test));

  test("a card list with Buat klip in the head, 44 px targets and no horizontal scroll", async ({ page }) => {
    await fakeJobs(page);
    await login(page, "/projects");
    const list = page.getByRole("list", { name: L("projects.list") });
    await expect(list.getByRole("listitem")).toHaveCount(3);
    await expect(page.getByRole("link", { name: L("projects.create") })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.getByRole("button", { name: L("projects.action.select") }).tap();
    await expect(list.getByRole("checkbox")).toHaveCount(3);
    for (const target of [
      ...await page.getByRole("tab").all(),
      ...await filters(page).getByRole("radio").all(),
      ...await list.getByRole("link").all(),
    ]) {
      const box = await target.boundingBox();
      if (!box) continue;
      expect(box.height, await target.textContent()).toBeGreaterThanOrEqual(44);
    }
  });
});
