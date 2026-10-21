import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { expect } from "@playwright/test";

import { expectFailedRequest, login, skipWithoutCredentials, test } from "./support/harness.mjs";

// A clip's title and description on the project page (plan 2026-10-20 P2): "Ubah" edits them in
// the caption box and "Simpan" saves through PATCH /clip-text; "Tulis ulang" shows the AI's
// suggestion to use ("Pakai", into the form) or throw away ("Buang"); a failure links to its
// /bantuan entry and Pengaturan. The job API, PATCH /clip-text and POST /clip-text/rewrite are
// faked inside the browser (page.route), so nothing on the server changes and no LLM is asked;
// only the login is real. The real routes are covered by web/tests/clip-text-api.test.mjs.

const JOB_ID = "6a1f3c2e-4b5d-4e6f-8a7b-9c0d1e2f3a4b";
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const TITLES = ["Security tahan sutradara film", "Gaji pertama langsung habis"];

function clip(index) {
  const base = `/api/jobs/${JOB_ID}/files/output/clip-0${index}`;
  return {
    index, score: 8.2, start: 60 * index, end: 60 * index + 30, duration: 30, text: "transkrip", selectionSource: "llm",
    title: TITLES[index - 1], description: "Cerita dari mall. Kamu pernah?\n\n#fyp #mall", hashtags: ["#fyp", "#mall"],
    videoUrl: `${base}.mp4`, downloadUrl: `${base}.mp4?download=1`, subtitleUrl: `${base}.srt?download=1`,
  };
}

const JOB = {
  id: JOB_ID, status: "completed", progress: 100, createdAt: iso(NOW - 3_600_000), updatedAt: iso(NOW - 3_600_000),
  source: { type: "upload", name: "Podcast 14.mp4" }, options: { selectionMode: "v3", llmMode: "auto" }, clips: [1, 2].map(clip),
};
const SUGGESTION = { title: "Sutradara ditahan satpam di filmnya sendiri", description: "Satpam mall cerita salah tahan orang. Kamu pernah?\n\n#ceritanyata #fyp" };

/** Fakes the job, its clips listing, the save and the rewrite; returns the requests it saw. */
async function fakeProject(target, { rewrite = { status: 200, body: { suggestion: SUGGESTION } } } = {}) {
  const seen = { saves: [], rewrites: [] };
  // The clips listing answers as with the editor off, so the page shows no editor entry.
  expectFailedRequest(target, 404, "GET", `/api/jobs/${JOB_ID}/clips`);
  await target.route(new RegExp(`/api/jobs/${JOB_ID}(?:[/?].*)?$`), async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (status, body) => route.fulfill({ status, contentType: "application/json", headers: { "Cache-Control": "no-store" }, body: JSON.stringify(body) });
    if (url.pathname === `/api/jobs/${JOB_ID}`) return json(200, { job: JOB });
    if (url.pathname === `/api/jobs/${JOB_ID}/clips`) return json(404, { code: "editor_disabled" });
    if (url.pathname === `/api/jobs/${JOB_ID}/clip-text` && request.method() === "PATCH") {
      const body = request.postDataJSON();
      seen.saves.push({ body, contentType: request.headers()["content-type"] });
      const saved = { ...clip(body.index), title: body.title.trim(), description: body.description.trim(), hashtags: body.description.match(/#\w+/g) ?? [] };
      return json(200, { clip: saved });
    }
    if (url.pathname === `/api/jobs/${JOB_ID}/clip-text/rewrite` && request.method() === "POST") {
      seen.rewrites.push(request.postDataJSON());
      return json(rewrite.status, rewrite.body);
    }
    return route.fulfill({ status: 200, contentType: "video/mp4", body: "" });
  });
  return seen;
}

const detail = (target) => target.locator("[data-clip-detail]");
const caption = (target) => detail(target).getByRole("region", { name: "Caption" });
const posters = (target) => target.getByRole("article");
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

async function openProject(page, options) {
  const seen = await fakeProject(page, options);
  await login(page, "/projects");
  await page.goto(`/projects/${JOB_ID}`);
  await expect(posters(page)).toHaveCount(2);
  return seen;
}

test.describe("clip title and description (faked routes)", () => {
  test.beforeEach(() => skipWithoutCredentials(test));

  test("Ubah saves the text in place; the heading, poster, download name and copy follow", async ({ page }) => {
    const seen = await openProject(page);
    const box = caption(page);
    await box.getByRole("button", { name: "Ubah judul dan deskripsi" }).click();
    const title = box.getByLabel("Judul", { exact: true });
    const description = box.getByLabel("Deskripsi", { exact: true });
    await expect(title).toBeFocused();
    await expect(title).toHaveValue(TITLES[0]);
    await expect(description).toHaveValue("Cerita dari mall. Kamu pernah?\n\n#fyp #mall");
    await expect(box.getByText("29/100")).toBeVisible();

    // Nothing to save until the text changes; an empty title is named and not sent.
    await title.fill("");
    await expect(box.getByText("Judul tidak boleh kosong.")).toBeVisible();
    await expect(title).toHaveAttribute("aria-invalid", "true");
    // Simpan says it cannot save (aria-disabled, still focusable); a click on it sends nothing.
    const store = box.getByRole("button", { name: "Simpan" });
    await expect(store).toHaveAttribute("aria-disabled", "true");
    await store.click({ force: true });
    expect(seen.saves).toHaveLength(0);

    await title.fill("Satpam nahan sutradara");
    await description.fill("Cerita lucu dari mall.\n\n#podcast #lucu");
    await box.getByRole("button", { name: "Simpan" }).click();
    await expect.poll(() => seen.saves.length).toBe(1);
    expect(seen.saves[0].body).toEqual({ index: 1, title: "Satpam nahan sutradara", description: "Cerita lucu dari mall.\n\n#podcast #lucu" });
    expect(seen.saves[0].contentType).toMatch(/application\/json/);

    await expect(detail(page).getByRole("heading", { level: 3 })).toHaveText("Satpam nahan sutradara");
    await expect(posters(page).nth(0)).toContainText("Satpam nahan sutradara");
    await expect(box.getByRole("status")).toContainText("Judul dan deskripsi tersimpan.");
    await expect(box.getByRole("button", { name: "Ubah judul dan deskripsi" })).toBeFocused();
    await expect(box.getByText("#podcast", { exact: true })).toBeVisible();
    await expect(detail(page).getByRole("link", { name: "Unduh MP4" }))
      .toHaveAttribute("href", `/api/jobs/${JOB_ID}/files/output/clip-01.mp4?download=1&name=01-satpam-nahan-sutradara`);

    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await detail(page).getByRole("button", { name: "Salin caption" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("Satpam nahan sutradara\n\nCerita lucu dari mall.\n\n#podcast #lucu");
  });

  test("an unsaved draft waits while another clip is shown; Batal drops it", async ({ page }) => {
    const seen = await openProject(page);
    await caption(page).getByRole("button", { name: "Ubah judul dan deskripsi" }).click();
    await caption(page).getByLabel("Judul", { exact: true }).fill("Draf yang belum disimpan");
    await posters(page).nth(1).getByRole("button").click();
    await expect(detail(page).getByRole("heading", { level: 3 })).toHaveText(TITLES[1]);
    await expect(caption(page).getByLabel("Judul", { exact: true })).toHaveCount(0);
    await posters(page).nth(0).getByRole("button").click();
    await expect(caption(page).getByLabel("Judul", { exact: true })).toHaveValue("Draf yang belum disimpan");
    await caption(page).getByRole("button", { name: "Batal" }).click();
    await expect(caption(page).getByLabel("Judul", { exact: true })).toHaveCount(0);
    await expect(caption(page).getByRole("button", { name: "Ubah judul dan deskripsi" })).toBeFocused();
    expect(seen.saves).toHaveLength(0);
  });

  test("Tulis ulang shows a suggestion; Pakai puts it in the form, Buang throws it away", async ({ page }) => {
    const seen = await openProject(page);
    const box = caption(page);
    await box.getByRole("button", { name: "Tulis ulang" }).click();
    const offer = box.getByRole("region", { name: "Saran AI" });
    await expect(offer).toContainText(SUGGESTION.title);
    await expect(offer).toContainText("Satpam mall cerita salah tahan orang.");
    expect(seen.rewrites).toEqual([{ index: 1 }]);
    expect(seen.saves).toHaveLength(0);
    if (AXE) expect(await axeSerious(page)).toEqual([]);

    await offer.getByRole("button", { name: "Pakai" }).click();
    await expect(box.getByLabel("Judul", { exact: true })).toHaveValue(SUGGESTION.title);
    await expect(box.getByLabel("Deskripsi", { exact: true })).toHaveValue(SUGGESTION.description);
    await expect(box.getByLabel("Judul", { exact: true })).toBeFocused();
    expect(seen.saves).toHaveLength(0);
    await box.getByRole("button", { name: "Batal" }).click();
    await expect(detail(page).getByRole("heading", { level: 3 })).toHaveText(TITLES[0]);

    await box.getByRole("button", { name: "Tulis ulang" }).click();
    await offer.getByRole("button", { name: "Buang" }).click();
    await expect(offer).toHaveCount(0);
    await expect(box.getByRole("button", { name: "Tulis ulang" })).toBeFocused();
    expect(seen.saves).toHaveLength(0);
  });

  test("a failed Tulis ulang says why and links to its help entry and Pengaturan", async ({ page }) => {
    await openProject(page, { rewrite: { status: 502, body: {
      error: "AI tidak bisa dipakai sekarang. Cek penyedia di Pengaturan, lalu coba lagi.", code: "llm_unavailable", llmCode: "quota_exhausted",
    } } });
    expectFailedRequest(page, 502, "POST", `/api/jobs/${JOB_ID}/clip-text/rewrite`); // the failed rewrite is the point
    await caption(page).getByRole("button", { name: "Tulis ulang" }).click();
    const alert = caption(page).getByRole("alert");
    await expect(alert).toContainText("Tulis ulang gagal");
    await expect(alert).toContainText("Cek penyedia di Pengaturan");
    await expect(alert.getByRole("link", { name: "Cara memperbaiki" })).toHaveAttribute("href", "/bantuan#llm_quota_exhausted");
    await expect(alert.getByRole("link", { name: "Buka Pengaturan" })).toHaveAttribute("href", "/settings");
  });
});

test.describe("clip title and description at 390 px", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test.beforeEach(() => skipWithoutCredentials(test));

  test("the form fits the panel with 44 px targets and no horizontal scroll", async ({ page }) => {
    await openProject(page);
    const box = caption(page);
    await box.getByRole("button", { name: "Ubah judul dan deskripsi" }).tap();
    await expect(box.getByLabel("Judul", { exact: true })).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    for (const target of [box.getByLabel("Judul", { exact: true }), box.getByRole("button", { name: "Simpan" }), box.getByRole("button", { name: "Batal" }),
      box.getByRole("button", { name: "Tulis ulang" })]) {
      const size = await target.boundingBox();
      expect(size.height).toBeGreaterThanOrEqual(44);
    }
  });
});
