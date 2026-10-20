import { expect } from "@playwright/test";

import { login, skipWithoutCredentials, test } from "./support/harness.mjs";

// The dashboard form (plan 2026-10-20 P1 #6): link or file and Buat klip in one row, the other
// options folded under a summary, duration presets, "Bahasa video", and the last choices kept
// in this browser. The dashboard's own API calls are faked inside the browser (page.route), so
// these tests create no job and change no server data; only the login is real.

const LINK = "https://youtu.be/rBg0ZcwjVKQ";
const CHOICES_KEY = "potongin-dashboard-choices";
const NOW = new Date().toISOString();
const ACTIVE_AI = { state: "active", order: ["uji"], providers: [{ name: "uji", displayName: null }], label: "LLM aktif: uji" };

/** The text parts of a job POST, in order, as [name, value] pairs. */
function multipartFields(request) {
  const boundary = /boundary=(.+)$/.exec(request.headers()["content-type"] || "")?.[1];
  const body = request.postDataBuffer()?.toString("utf8") || "";
  if (!boundary) return [];
  return body.split(`--${boundary}`).flatMap((part) => {
    const match = /name="([^"]+)"\r\n\r\n([\s\S]*)\r\n$/.exec(part);
    return match ? [[match[1], match[2]]] : [];
  });
}

// The browser may leave a file part out of the intercepted body, so the page's own FormData is
// recorded before it is sent: files as { filename }.
async function recordJobForms(page) {
  await page.addInitScript(() => {
    window.__jobForms = [];
    const send = window.fetch;
    window.fetch = (input, init) => {
      if (String(input) === "/api/jobs" && init?.method === "POST" && init.body instanceof FormData) {
        window.__jobForms.push([...init.body.entries()].map(([name, value]) => [name, value instanceof File ? { filename: value.name } : value]));
      }
      return send(input, init);
    };
  });
  return async () => Object.fromEntries((await page.evaluate(() => window.__jobForms)).at(-1) || []);
}

/** Fakes /api/jobs (listing `jobs`), /api/llm/status and /api/storage/status; `editor` is the jobs list's editor flag. Returns the job POSTs. */
async function fakeDashboardApi(page, { jobs = [], editor = false } = {}) {
  const posts = [];
  const job = (id) => ({ id, status: "queued", progress: 0, createdAt: NOW, updatedAt: NOW, source: { type: "youtube", url: LINK }, options: { selectionMode: "v3" }, clips: [] });
  await page.route(/\/api\/(?:jobs|llm\/status|storage\/status)(?:[/?]|$)/, (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const json = (status, body) => route.fulfill({ status, contentType: "application/json", headers: { "Cache-Control": "no-store" }, body: JSON.stringify(body) });
    if (pathname === "/api/llm/status") return json(200, { llm: ACTIVE_AI });
    if (pathname === "/api/storage/status") return json(200, { admission: { allowed: true, code: null } });
    if (pathname === "/api/jobs" && request.method() === "POST") {
      posts.push(multipartFields(request));
      return json(202, { job: job(`00000000-0000-4000-8000-${String(posts.length).padStart(12, "0")}`) });
    }
    if (pathname === "/api/jobs") return json(200, { jobs, total: jobs.length, editor });
    const id = pathname.split("/")[3];
    return json(200, { job: jobs.find((item) => item.id === id) || job(id) });
  });
  return posts;
}

// Prerendered page: the AI status line appears only after hydration, when typing is kept.
async function openDashboard(page) {
  await login(page, "/dashboard");
  await expect(page.getByText("AI aktif: uji", { exact: true })).toBeVisible();
}

const optionsButton = (page) => page.getByRole("button", { name: /^Pengaturan klip/ });
const submitButton = (page) => page.getByRole("button", { name: "Buat klip", exact: true });
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const choose = (page, text) => page.getByText(text, { exact: true }).click();

async function submitJob(page, posts) {
  const before = posts.length;
  await submitButton(page).click();
  await expect.poll(() => posts.length).toBe(before + 1);
  return Object.fromEntries(posts.at(-1));
}

test.describe("Dashboard form (faked job API)", () => {
  test.beforeEach(() => skipWithoutCredentials(test));

  test("the link and Buat klip share the top row; the other options fold under a summary", async ({ page }) => {
    await fakeDashboardApi(page);
    await openDashboard(page);
    const link = await page.getByLabel("Link video").boundingBox();
    const submit = await submitButton(page).boundingBox();
    expect(Math.abs((link.y + link.height / 2) - (submit.y + submit.height / 2))).toBeLessThan(4);
    await expect(optionsButton(page)).toHaveAttribute("aria-expanded", "false");
    await expect(optionsButton(page)).toContainText("3 klip · Otomatis 20–60 detik · Utuh + latar blur · Karaoke · Bahasa Indonesia");
    await expect(page.getByLabel("Jumlah klip")).toBeHidden();

    await optionsButton(page).click();
    await expect(optionsButton(page)).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByLabel("Jumlah klip")).toBeVisible();
    await expect(page.getByRole("radio", { name: /^Otomatis/ })).toBeChecked();
    await expect(page.getByRole("radio", { name: "Indonesia", exact: true })).toBeChecked();
    // Fixed ranges need no number fields; "Atur sendiri" brings them.
    await expect(page.getByLabel("Durasi minimum")).toHaveCount(0);
  });

  test("presets and the video language reach the job; the choices come back, the link does not", async ({ page }) => {
    const posts = await fakeDashboardApi(page);
    await openDashboard(page);
    await optionsButton(page).click();
    await page.getByLabel("Jumlah klip").fill("5");
    await choose(page, "Pendek");
    await choose(page, "Inggris");
    await page.getByLabel("Link video").fill(LINK);
    expect(await submitJob(page, posts)).toMatchObject({ limit: "5", minDuration: "15", maxDuration: "30", videoLanguage: "en", youtubeUrl: LINK });

    await page.reload();
    await expect(page.getByText("AI aktif: uji", { exact: true })).toBeVisible();
    await expect(optionsButton(page)).toContainText("5 klip · Pendek 15–30 detik · Utuh + latar blur · Karaoke · Bahasa Inggris");
    await expect(optionsButton(page)).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByLabel("Link video")).toHaveValue("");
    const stored = await page.evaluate((key) => window.localStorage.getItem(key), CHOICES_KEY);
    expect(stored).not.toContain("youtu");

    // "Atur sendiri" opens the two fields on the range in use; a bad range blocks the job.
    await choose(page, "Atur sendiri");
    await expect(page.getByLabel("Durasi minimum")).toHaveValue("15");
    await expect(page.getByLabel("Durasi maksimum")).toHaveValue("30");
    await page.getByLabel("Durasi minimum").fill("61");
    await page.getByLabel("Durasi maksimum").fill("60");
    await page.getByLabel("Link video").fill(LINK);
    await submitButton(page).click();
    await expect(page.getByText("Durasi maksimum tidak boleh kurang dari minimum.")).toBeVisible();
    await expect(page.getByLabel("Durasi maksimum")).toBeFocused();
    expect(posts).toHaveLength(1);
    await page.getByLabel("Durasi minimum").fill("25");
    await page.getByLabel("Durasi maksimum").fill("45");
    expect(await submitJob(page, posts)).toMatchObject({ minDuration: "25", maxDuration: "45", videoLanguage: "en" });
  });

  test("time ranges are checked before anything is sent and reach the job as typed", async ({ page }) => {
    const posts = await fakeDashboardApi(page);
    await openDashboard(page);
    await optionsButton(page).click();
    await page.getByLabel("Jumlah klip").fill("2");
    const ranges = page.getByLabel("Rentang waktu (opsional)");
    await ranges.fill("10.30-12.05, 1:00-1:30, 2:00-2:30");
    await expect(optionsButton(page)).toContainText("2 klip · Otomatis 20–60 detik · Utuh + latar blur · Karaoke · Bahasa Indonesia · 3 rentang waktu");
    await optionsButton(page).click();
    await page.getByLabel("Link video").fill(LINK);
    await submitButton(page).click();
    // The folded options open again on the field, with the reason under it; nothing is sent.
    await expect(ranges).toBeFocused();
    await expect(ranges).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByText("Ada 3 rentang waktu, tetapi jumlah klip 2. Naikkan jumlah klip atau kurangi rentang.", { exact: true })).toBeVisible();
    expect(posts).toHaveLength(0);

    await ranges.fill("10.30-12.05\n1:02:10-1:03:00");
    await expect(ranges).not.toHaveAttribute("aria-invalid", "true");
    const sent = await submitJob(page, posts);
    expect(sent.limit).toBe("2");
    expect(sent.timeRanges.replace(/\r\n/g, "\n")).toBe("10.30-12.05\n1:02:10-1:03:00");
    // The ranges belong to this video: the browser keeps no copy of them.
    const stored = await page.evaluate((key) => window.localStorage.getItem(key), CHOICES_KEY);
    expect(stored).not.toContain("10.30");
  });

  test("a problem inside the folded options opens them and focuses the field", async ({ page }) => {
    const posts = await fakeDashboardApi(page);
    await openDashboard(page);
    await optionsButton(page).click();
    await page.getByLabel("Jumlah klip").fill("12");
    await optionsButton(page).click();
    await expect(page.getByLabel("Jumlah klip")).toBeHidden();
    await page.getByLabel("Link video").fill(LINK);
    await submitButton(page).click();
    await expect(page.getByLabel("Jumlah klip")).toBeFocused();
    await expect(page.getByText("Isi 1 sampai 10 klip.")).toBeVisible();
    expect(posts).toHaveLength(0);
  });

  test("with storage blocked the page runs on today's defaults", async ({ page }) => {
    await page.addInitScript((key) => {
      const blocked = () => { throw new DOMException("blocked", "SecurityError"); };
      for (const name of ["getItem", "setItem"]) {
        const original = Storage.prototype[name];
        Storage.prototype[name] = function guarded(storedKey, ...rest) {
          return storedKey === key ? blocked() : original.call(this, storedKey, ...rest);
        };
      }
    }, CHOICES_KEY);
    const posts = await fakeDashboardApi(page);
    await openDashboard(page);
    await expect(optionsButton(page)).toContainText("3 klip · Otomatis 20–60 detik");
    await optionsButton(page).click();
    await choose(page, "Panjang");
    await choose(page, "Deteksi otomatis");
    await page.getByLabel("Link video").fill(LINK);
    expect(await submitJob(page, posts)).toMatchObject({ limit: "3", minDuration: "60", maxDuration: "90", videoLanguage: "auto" });
  });

  test("a video dropped on the page becomes the source; another file is refused", async ({ page }) => {
    const posts = await fakeDashboardApi(page);
    const lastForm = await recordJobForms(page);
    await openDashboard(page);
    const drop = async (name, type) => {
      const dataTransfer = await page.evaluateHandle(([fileName, fileType]) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File(["bukan video sungguhan"], fileName, { type: fileType }));
        return transfer;
      }, [name, type]);
      for (const event of ["dragenter", "dragover", "drop"]) await page.dispatchEvent("h1", event, { dataTransfer });
    };
    await drop("catatan.txt", "text/plain");
    await expect(page.getByText("Format tidak didukung. Pakai MP4, MOV, MKV atau WEBM.")).toBeVisible();
    await drop("podcast-ep12.mp4", "video/mp4");
    await expect(page.getByText("podcast-ep12.mp4", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Link video")).toHaveCount(0);
    await expect(page.getByText("Format tidak didukung", { exact: false })).toHaveCount(0);
    await submitJob(page, posts);
    const form = await lastForm();
    expect(form.video).toEqual({ filename: "podcast-ep12.mp4" });
    expect(form.youtubeUrl).toBeUndefined();
    expect(form.videoLanguage).toBe("id");

    await page.getByRole("button", { name: "Hapus file podcast-ep12.mp4" }).click();
    await expect(page.getByLabel("Link video")).toBeFocused();
  });

  test("a running job lists what its finished stages found under the progress bar", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    const running = {
      id: "00000000-0000-4000-8000-000000000101", status: "processing", progress: 60, stage: "llm", stageDetail: "AI (LLM) memilih momen terbaik",
      createdAt: NOW, updatedAt: NOW, source: { type: "youtube", url: LINK }, options: { selectionMode: "v3", videoLanguage: "auto" }, clips: [],
      stageSummary: { video: { duration: 2892.4 }, transcript: { words: 2304, source: "youtube-captions", language: "en" } },
    };
    await fakeDashboardApi(page, { jobs: [running] });
    await openDashboard(page);
    const results = page.getByRole("complementary", { name: "Hasil" });
    const summary = results.getByLabel("Hasil per tahap");
    await expect(summary).toBeVisible();
    await expect(summary.locator("dt")).toHaveText(["Video", "Transkrip"]);
    await expect(summary.locator("dd")).toHaveText(["48:12", "2.304 kata · dari subtitle YouTube · bahasa Inggris"]);
    // Under the bar and the live line, before the clips.
    const bar = await results.getByRole("progressbar", { name: "Progres job" }).boundingBox();
    const box = await summary.boundingBox();
    expect(box.y).toBeGreaterThan(bar.y + bar.height);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  test("the 9:16 preview follows the layout, the subtitle style and the hook switch", async ({ page }) => {
    const posts = await fakeDashboardApi(page);
    await openDashboard(page);
    await optionsButton(page).click();
    const preview = page.getByRole("img", { name: /^Pratinjau klip 9:16/ });
    await expect(preview).toHaveAccessibleName("Pratinjau klip 9:16: Utuh + latar blur, subtitle Karaoke di bawah, teks hook di atas.");
    await expect(preview).toHaveAttribute("data-layout", "fit");
    await expect(page.getByText("Area tombol TikTok", { exact: true })).toBeVisible();
    // Without the editor the note names no Edit klip.
    await expect(page.getByText("Subtitle ada di bawah, dekat area tombol TikTok.", { exact: true })).toBeVisible();
    // Both style thumbnails are real images.
    expect(await page.evaluate(() => [...document.querySelectorAll("#job-options img")].map((img) => img.complete && img.naturalWidth === 320))).toEqual([true, true]);

    await choose(page, "Klasik");
    await expect(preview).toHaveAttribute("data-pack", "classic");
    await choose(page, "Crop tengah");
    await expect(preview).toHaveAttribute("data-layout", "fill");
    await choose(page, "Teks hook di 4 detik pertama");
    await expect(preview).toHaveAttribute("data-hook", "off");
    await expect(preview).toHaveAccessibleName("Pratinjau klip 9:16: Crop tengah, subtitle Klasik di bawah, tanpa teks hook.");
    await page.getByLabel("Link video").fill(LINK);
    expect(await submitJob(page, posts)).toMatchObject({ captionStyle: "classic", renderMode: "center-crop", hookOverlay: "false" });
  });

  test("with the editor on, the note says where to move the subtitle", async ({ page }) => {
    await fakeDashboardApi(page, { editor: true });
    await openDashboard(page);
    await optionsButton(page).click();
    await expect(page.getByText("Subtitle ada di bawah, dekat area tombol TikTok. Geser atau ubah ukurannya per klip lewat Edit klip.", { exact: true })).toBeVisible();
    await expect(page.getByRole("group", { name: "Gaya subtitle" })).toHaveAccessibleDescription(/Edit klip/);
  });

  test("at 360 px nothing scrolls sideways and every control is a 44 px target", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await fakeDashboardApi(page);
    await openDashboard(page);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await optionsButton(page).click();
    await choose(page, "Atur sendiri");
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    // The controls this form adds: the source row, the fold, the presets and the number fields.
    const small = await page.evaluate(() => [...document.querySelectorAll(
      "#youtube-url, label:has(> #video-file), form[aria-label=\"Buat klip\"] button[type=submit], [aria-controls=job-options], #job-options label:has(> input[type=radio]), #job-options input[type=number]",
    )].filter((element) => element.getClientRects().length > 0).map((element) => {
      const box = element.getBoundingClientRect();
      return { control: element.id || element.textContent.trim().slice(0, 30), width: Math.round(box.width), height: Math.round(box.height) };
    }).filter((box) => box.width < 44 || box.height < 44));
    expect(small).toEqual([]);
    // The link has the whole width; "Pilih file" and Buat klip share the line below it.
    const link = await page.getByLabel("Link video").boundingBox();
    const pick = await page.getByText("Pilih file", { exact: true }).boundingBox();
    const submit = await submitButton(page).boundingBox();
    expect(pick.y).toBeGreaterThan(link.y + link.height - 1);
    expect(Math.abs(pick.y - submit.y)).toBeLessThan(4);
  });
});
