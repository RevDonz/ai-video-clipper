import { expect } from "@playwright/test";

import { choose, unchoose } from "./support/choice.mjs";
import { login, skipWithoutCredentials, test } from "./support/harness.mjs";
import { L } from "./support/i18n.mjs";

// Buat klip (05-ui-dashboard.md §6.3): the link (or a file) and Buat klip first, then every
// choice as a valued chip whose popover holds its control, and the newest projects. Enter sends
// the form and the page goes to /projects/<id>; a field error opens its chip and focuses the
// field. The dashboard's own API calls are faked inside the browser (page.route), so these tests
// create no job and change no server data; only the login is real.

const LINK = "https://youtu.be/rBg0ZcwjVKQ";
const CHOICES_KEY = "potongin-dashboard-choices";
const NOW = new Date().toISOString();
const ACTIVE_AI = { state: "active", order: ["uji"], providers: [{ name: "uji", displayName: null }], label: "LLM aktif: uji" };
const JOB_ID = /\/projects\/00000000-0000-4000-8000-0000000000\d\d$/;

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
// recorded before it is sent (the job goes out through XMLHttpRequest for its upload percent):
// files as { filename }. Kept in sessionStorage, since the page then goes to the project.
async function recordJobForms(page) {
  await page.addInitScript(() => {
    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function recorded(body) {
      if (body instanceof FormData) {
        const fields = [...body.entries()].map(([name, value]) => [name, value instanceof File ? { filename: value.name } : value]);
        window.sessionStorage.setItem("job-form", JSON.stringify(fields));
      }
      return send.call(this, body);
    };
  });
  return async () => Object.fromEntries(JSON.parse(await page.evaluate(() => window.sessionStorage.getItem("job-form")) || "[]"));
}

/**
 * Fakes /api/jobs (listing `jobs`), /api/llm/status and /api/storage/status; `editor` and
 * `renderEngine` are the jobs list's flags, `ai` the AI status. Returns the job POSTs.
 */
async function fakeDashboardApi(page, { jobs = [], editor = false, renderEngine = "edit-v2", ai = ACTIVE_AI } = {}) {
  const posts = [];
  const job = (id) => ({ id, status: "queued", progress: 0, createdAt: NOW, updatedAt: NOW, source: { type: "youtube", url: LINK }, options: { selectionMode: "v3" }, clips: [] });
  await page.route(/\/api\/(?:jobs|llm\/status|storage\/status)(?:[/?]|$)/, (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const json = (status, body) => route.fulfill({ status, contentType: "application/json", headers: { "Cache-Control": "no-store" }, body: JSON.stringify(body) });
    if (pathname === "/api/llm/status") return json(200, { llm: ai });
    if (pathname === "/api/storage/status") return json(200, { admission: { allowed: true, code: null } });
    if (pathname === "/api/jobs" && request.method() === "POST") {
      posts.push(multipartFields(request));
      return json(202, { job: job(`00000000-0000-4000-8000-${String(posts.length).padStart(12, "0")}`) });
    }
    if (pathname === "/api/jobs") return json(200, { jobs, total: jobs.length, editor, renderEngine });
    const id = pathname.split("/")[3];
    if (pathname.endsWith("/clips")) return json(404, {});
    return json(200, { job: jobs.find((item) => item.id === id) || job(id) });
  });
  return posts;
}

// The page is prerendered with the defaults; the stored choices and the jobs list's flags arrive
// after hydration, together with the jobs list.
async function openDashboard(page) {
  const listed = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/jobs" && response.request().method() === "GET");
  await login(page, "/dashboard");
  await listed;
  await expect(chip(page, "count")).toBeEnabled();
}

// Back on Buat klip after a job took the page to its project.
async function reopenDashboard(page) {
  const listed = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/jobs" && response.request().method() === "GET");
  await page.goto("/dashboard");
  await listed;
  await expect(chip(page, "count")).toBeEnabled();
}

const chip = (page, id) => page.locator(`[data-chip="${id}"]`);
const popover = (page, id) => page.locator(`[data-chip-popover="${id}"]`);
const link = (page) => page.getByLabel(L("dashboard.source.link"), { exact: true });
const submitButton = (page) => page.getByRole("button", { name: L("dashboard.submit.idle"), exact: true });
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const seconds = (min, max) => L("dashboard.chip.seconds", { min, max });

async function openChip(page, id) {
  await chip(page, id).click();
  await expect(popover(page, id)).toBeVisible();
  return popover(page, id);
}

/** Sends the form; the page goes to the new project. Returns the job's fields. */
async function submitJob(page, posts, { by = "click" } = {}) {
  const before = posts.length;
  if (by === "enter") await link(page).press("Enter");
  else await submitButton(page).click();
  await expect.poll(() => posts.length).toBe(before + 1);
  await expect(page).toHaveURL(JOB_ID);
  return Object.fromEntries(posts.at(-1));
}

test.describe("Buat klip composer (faked job API)", () => {
  test.beforeEach(() => skipWithoutCredentials(test));

  test("the link and Buat klip share the top row; every choice is a chip that reads its value", async ({ page }) => {
    await fakeDashboardApi(page);
    await openDashboard(page);
    const linkBox = await link(page).boundingBox();
    const submit = await submitButton(page).boundingBox();
    expect(Math.abs((linkBox.y + linkBox.height / 2) - (submit.y + submit.height / 2))).toBeLessThan(4);
    // The head is the title alone: no sentence (P2), and no AI line while the AI is fine (P6).
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(L("dashboard.title"));
    await expect(page.locator("header.pageHead p")).toHaveCount(0);
    // Scoped to the page: Next.js keeps its own route announcer (role=alert) in a shadow root.
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
    const values = {
      count: L("dashboard.chip.count", { count: 3 }),
      duration: L("dashboard.chip.duration", { value: L("dashboard.duration.auto") }),
      format: "9:16 · 720p",
      layout: L("dashboard.chip.layout", { value: L("layout.names.fit_blur") }),
      subtitle: L("dashboard.chip.subtitle", { value: L("dashboard.style.karaoke") }),
      hook: L("dashboard.chip.hook", { value: L("dashboard.hook.both") }),
      focus: L("dashboard.chip.focus"),
      language: L("dashboard.language.id"),
    };
    for (const [id, text] of Object.entries(values)) {
      await expect(chip(page, id)).toHaveText(text);
      await expect(chip(page, id)).toHaveAttribute("aria-expanded", "false");
    }
    await expect(chip(page, "count")).toHaveAccessibleName(`${L("dashboard.chip.countLabel")}: ${values.count}`);
    // A chip opens its popover with the control; one popover at a time.
    const count = await openChip(page, "count");
    await expect(count.getByLabel(L("dashboard.chip.countLabel"), { exact: true })).toHaveValue("3");
    await expect(chip(page, "count")).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(popover(page, "count")).toHaveCount(0);
    await expect(chip(page, "count")).toBeFocused();
    const layout = await openChip(page, "layout");
    await expect(layout.getByRole("radio", { name: L("layout.names.fit_blur") })).toBeChecked();
    await expect(layout.getByRole("radio")).toHaveCount(3);
    await expect(layout.getByRole("radio", { name: L("layout.names.split") })).toHaveCount(0);
  });

  test("Enter in the link sends the job and lands on its project; the choices come back, the link does not", async ({ page }) => {
    const posts = await fakeDashboardApi(page);
    await openDashboard(page);
    const count = await openChip(page, "count");
    await count.getByLabel(L("dashboard.chip.countLabel"), { exact: true }).fill("5");
    await page.keyboard.press("Escape");
    const duration = await openChip(page, "duration");
    await choose(duration.getByRole("radio", { name: `${L("dashboard.duration.short")} · ${seconds(15, 30)}` }));
    await page.keyboard.press("Escape");
    const language = await openChip(page, "language");
    await choose(language.getByRole("radio", { name: L("dashboard.language.en") }));
    await page.keyboard.press("Escape");
    await expect(chip(page, "count")).toHaveText(L("dashboard.chip.count", { count: 5 }));
    await link(page).fill(LINK);
    expect(await submitJob(page, posts, { by: "enter" })).toMatchObject({ limit: "5", minDuration: "15", maxDuration: "30", videoLanguage: "en", youtubeUrl: LINK });

    await reopenDashboard(page);
    await expect(chip(page, "count")).toHaveText(L("dashboard.chip.count", { count: 5 }));
    await expect(chip(page, "duration")).toHaveText(L("dashboard.chip.duration", { value: L("dashboard.duration.short") }));
    await expect(chip(page, "language")).toHaveText(L("dashboard.language.en"));
    await expect(link(page)).toHaveValue("");
    const stored = await page.evaluate((key) => window.localStorage.getItem(key), CHOICES_KEY);
    expect(stored).not.toContain("youtu");
  });

  test("Atur sendiri opens two fields; a bad range opens the chip on the wrong field and sends nothing", async ({ page }) => {
    const posts = await fakeDashboardApi(page);
    await openDashboard(page);
    let duration = await openChip(page, "duration");
    await choose(duration.getByRole("radio", { name: L("dashboard.duration.custom") }));
    await duration.getByLabel(L("dashboard.duration.min"), { exact: true }).fill("61");
    await duration.getByLabel(L("dashboard.duration.max"), { exact: true }).fill("60");
    await page.keyboard.press("Escape");
    await link(page).fill(LINK);
    await submitButton(page).click();
    duration = popover(page, "duration");
    await expect(duration).toBeVisible();
    const max = duration.getByLabel(L("dashboard.duration.max"), { exact: true });
    await expect(max).toBeFocused();
    await expect(max).toHaveAttribute("aria-invalid", "true");
    await expect(max).toHaveAccessibleDescription(L("dashboard.problem.durationOrder"));
    await expect(chip(page, "duration")).toHaveAttribute("data-invalid", "true");
    expect(posts).toHaveLength(0);
    await duration.getByLabel(L("dashboard.duration.min"), { exact: true }).fill("25");
    await max.fill("45");
    // Enter inside the popover sends the form too.
    await max.press("Enter");
    await expect.poll(() => posts.length).toBe(1);
    expect(Object.fromEntries(posts[0])).toMatchObject({ minDuration: "25", maxDuration: "45" });
    await expect(page).toHaveURL(JOB_ID);
  });

  test("a wrong count or time range opens its chip and takes the focus; nothing is sent", async ({ page }) => {
    const posts = await fakeDashboardApi(page);
    await openDashboard(page);
    let count = await openChip(page, "count");
    await count.getByLabel(L("dashboard.chip.countLabel"), { exact: true }).fill("12");
    await page.keyboard.press("Escape");
    await link(page).fill(LINK);
    await submitButton(page).click();
    count = popover(page, "count");
    const field = count.getByLabel(L("dashboard.chip.countLabel"), { exact: true });
    await expect(field).toBeFocused();
    await expect(count.getByText(L("dashboard.problem.count", { min: 1, max: 10 }), { exact: true })).toBeVisible();
    await field.fill("2");
    await page.keyboard.press("Escape");

    const focus = await openChip(page, "focus");
    await focus.getByLabel(L("dashboard.focus.ranges"), { exact: true }).fill("10.30-12.05, 1:00-1:30, 2:00-2:30");
    await page.keyboard.press("Escape");
    await expect(chip(page, "focus")).toHaveText(`${L("dashboard.chip.focus")} · 3`);
    await submitButton(page).click();
    const ranges = popover(page, "focus").getByLabel(L("dashboard.focus.ranges"), { exact: true });
    await expect(ranges).toBeFocused();
    await expect(ranges).toHaveAttribute("aria-invalid", "true");
    expect(posts).toHaveLength(0);

    await ranges.fill("10.30-12.05\n1:02:10-1:03:00");
    await expect(ranges).not.toHaveAttribute("aria-invalid", "true");
    await page.keyboard.press("Escape");
    const sent = await submitJob(page, posts);
    expect(sent.limit).toBe("2");
    expect(sent.timeRanges.replace(/\r\n/g, "\n")).toBe("10.30-12.05\n1:02:10-1:03:00");
    // The ranges belong to this video: the browser keeps no copy of them.
    const stored = await page.evaluate((key) => window.localStorage.getItem(key), CHOICES_KEY);
    expect(stored).not.toContain("10.30");
  });

  test("an empty link is named under the link field, which takes the focus", async ({ page }) => {
    const posts = await fakeDashboardApi(page);
    await openDashboard(page);
    await submitButton(page).click();
    await expect(link(page)).toBeFocused();
    await expect(link(page)).toHaveAccessibleDescription(L("dashboard.problem.linkEmpty"));
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
    await expect(chip(page, "count")).toHaveText(L("dashboard.chip.count", { count: 3 }));
    const duration = await openChip(page, "duration");
    await choose(duration.getByRole("radio", { name: `${L("dashboard.duration.long")} · ${seconds(60, 90)}` }));
    await page.keyboard.press("Escape");
    const language = await openChip(page, "language");
    await choose(language.getByRole("radio", { name: L("dashboard.language.auto") }));
    await page.keyboard.press("Escape");
    await link(page).fill(LINK);
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
    await expect(page.getByText(L("dashboard.problem.videoFormat"), { exact: true })).toBeVisible();
    await drop("podcast-ep12.mp4", "video/mp4");
    await expect(page.getByText("podcast-ep12.mp4", { exact: true })).toBeVisible();
    await expect(link(page)).toHaveCount(0);
    await expect(page.getByText(L("dashboard.problem.videoFormat"), { exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: L("dashboard.source.remove", { name: "podcast-ep12.mp4" }) }).click();
    await expect(link(page)).toBeFocused();
    await drop("podcast-ep12.mp4", "video/mp4");
    await submitJob(page, posts);
    const form = await lastForm();
    expect(form.video).toEqual({ filename: "podcast-ep12.mp4" });
    expect(form.youtubeUrl).toBeUndefined();
    expect(form.videoLanguage).toBe("id");
  });

  test("an uploaded video takes an optional .srt that reaches the job; removing the video drops it", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    const posts = await fakeDashboardApi(page);
    const lastForm = await recordJobForms(page);
    await openDashboard(page);
    await expect(page.locator("#subtitle-file")).toHaveCount(0);
    await page.locator("#video-file").setInputFiles({ name: "podcast-ep12.mp4", mimeType: "video/mp4", buffer: Buffer.from("video") });
    await page.locator("#subtitle-file").setInputFiles({ name: "catatan.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
    await expect(page.getByText(L("dashboard.problem.srtType"), { exact: true })).toBeVisible();
    await page.locator("#subtitle-file").setInputFiles({ name: "podcast-ep12.srt", mimeType: "application/x-subrip", buffer: Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nHalo.\n") });
    await expect(page.getByText("podcast-ep12.srt", { exact: true })).toBeVisible();
    await expect(page.getByText(L("dashboard.problem.srtType"), { exact: true })).toHaveCount(0);
    await expect(page.getByText(L("dashboard.source.replaceSrt"), { exact: true })).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    const small = await page.evaluate(() => [...document.querySelectorAll("label:has(> #subtitle-file), label:has(> #video-file)")]
      .map((element) => element.getBoundingClientRect()).filter((box) => box.width < 44 || box.height < 44).length);
    expect(small).toBe(0);
    await page.getByRole("button", { name: L("dashboard.source.remove", { name: "podcast-ep12.srt" }) }).click();
    await expect(page.getByText(L("dashboard.source.srt"), { exact: true })).toBeVisible();
    await page.locator("#subtitle-file").setInputFiles({ name: "lagi.srt", mimeType: "application/x-subrip", buffer: Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nHalo.\n") });
    await submitJob(page, posts);
    const form = await lastForm();
    expect(form.video).toEqual({ filename: "podcast-ep12.mp4" });
    expect(form.subtitle).toEqual({ filename: "lagi.srt" });
  });

  test("removing the video drops its subtitle", async ({ page }) => {
    await fakeDashboardApi(page);
    await openDashboard(page);
    await page.locator("#video-file").setInputFiles({ name: "podcast-ep12.mp4", mimeType: "video/mp4", buffer: Buffer.from("video") });
    await page.locator("#subtitle-file").setInputFiles({ name: "lagi.srt", mimeType: "application/x-subrip", buffer: Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nHalo.\n") });
    await page.getByRole("button", { name: L("dashboard.source.remove", { name: "podcast-ep12.mp4" }) }).click();
    await expect(page.getByText("lagi.srt", { exact: true })).toHaveCount(0);
    await expect(page.locator("#subtitle-file")).toHaveCount(0);
  });

  test("the 9:16 preview in the Subtitle chip follows the layout, the style and the hook switch", async ({ page }) => {
    const posts = await fakeDashboardApi(page);
    await openDashboard(page);
    let subtitle = await openChip(page, "subtitle");
    const preview = subtitle.getByRole("img", { name: L("dashboard.look.label", { ratio: "9:16", layout: L("layout.names.fit_blur"), style: L("dashboard.style.karaoke") }) });
    await expect(preview).toHaveAttribute("data-layout", "fit");
    await expect(subtitle.getByText(L("dashboard.look.zone"), { exact: true })).toBeVisible();
    // Without the editor the note names no Edit klip.
    await expect(subtitle.getByText(L("dashboard.look.inZone"), { exact: true })).toBeVisible();
    // Every pack's thumbnail is a real image.
    expect(await subtitle.evaluate((root) => [...root.querySelectorAll("label img")].map((img) => img.complete && img.naturalWidth === 320))).toEqual([true, true, true, true, true, true]);
    await choose(subtitle.getByRole("radio", { name: L("dashboard.style.classic") }));
    await expect(subtitle.locator("[data-look-preview]")).toHaveAttribute("data-pack", "classic");
    await page.keyboard.press("Escape");
    await expect(chip(page, "subtitle")).toHaveText(L("dashboard.chip.subtitle", { value: L("dashboard.style.classic") }));

    const layout = await openChip(page, "layout");
    await choose(layout.getByRole("radio", { name: L("layout.names.fill_center") }));
    await page.keyboard.press("Escape");
    const hook = await openChip(page, "hook");
    await unchoose(hook.getByRole("switch", { name: L("dashboard.hook.text") }));
    await page.keyboard.press("Escape");
    await expect(chip(page, "hook")).toHaveText(L("dashboard.chip.hook", { value: L("dashboard.hook.coldOpen") }));
    subtitle = await openChip(page, "subtitle");
    await expect(subtitle.locator("[data-look-preview]")).toHaveAttribute("data-layout", "fill");
    await expect(subtitle.locator("[data-look-preview]")).toHaveAttribute("data-hook", "off");
    await page.keyboard.press("Escape");
    await link(page).fill(LINK);
    expect(await submitJob(page, posts)).toMatchObject({ captionStyle: "classic", renderMode: "center-crop", hookOverlay: "false", coldOpen: "true" });
  });

  test("Rasio and Resolusi reach the job as its output size; 1:1 previews square without the TikTok zone (CONTRACTS 5.54)", async ({ page }) => {
    const posts = await fakeDashboardApi(page);
    await openDashboard(page);
    const format = await openChip(page, "format");
    const ratio = format.getByRole("radiogroup", { name: L("dashboard.format.ratio") });
    const resolution = format.getByRole("radiogroup", { name: L("dashboard.format.resolution") });
    await expect(ratio.getByRole("radio", { name: "9:16" })).toBeChecked();
    await expect(resolution.getByRole("radio", { name: "720p" })).toBeChecked();
    await ratio.getByRole("radio", { name: "1:1" }).click();
    await resolution.getByRole("radio", { name: "1080p" }).click();
    await page.keyboard.press("Escape");
    await expect(chip(page, "format")).toHaveText("1:1 · 1080p");
    const subtitle = await openChip(page, "subtitle");
    const preview = subtitle.locator("[data-look-preview]");
    await expect(preview).toHaveAttribute("data-ratio", "1:1");
    await expect(subtitle.getByText(L("dashboard.look.zone"), { exact: true })).toHaveCount(0);
    const box = await preview.boundingBox();
    expect(Math.abs(box.width - box.height)).toBeLessThan(2);
    await page.keyboard.press("Escape");
    await link(page).fill(LINK);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    expect(await submitJob(page, posts)).toMatchObject({ outputSize: "1080x1080" });
  });

  test("with the editor on, the note says Edit klip changes the subtitle per clip", async ({ page }) => {
    await fakeDashboardApi(page, { editor: true });
    await openDashboard(page);
    const subtitle = await openChip(page, "subtitle");
    const note = `${L("dashboard.look.inZone")} · ${L("dashboard.look.editor")}`;
    await expect(subtitle.getByText(note, { exact: true })).toBeVisible();
    await expect(subtitle.getByRole("radiogroup", { name: L("dashboard.chip.subtitleLabel") })).toHaveAccessibleDescription(note);
  });

  test("every pack, Atas/Tengah/Bawah and the size reach the job and the preview (CONTRACTS 5.48)", async ({ page }) => {
    const posts = await fakeDashboardApi(page);
    await openDashboard(page);
    let subtitle = await openChip(page, "subtitle");
    const advanced = L("dashboard.look.advanced", { position: L("dashboard.position.bottom"), size: L("dashboard.size.medium") });
    await subtitle.getByText(advanced, { exact: true }).click();
    const spot = subtitle.getByRole("radiogroup", { name: L("dashboard.look.position") });
    const size = subtitle.getByRole("radiogroup", { name: L("dashboard.look.size") });
    await expect(spot.getByRole("radio", { name: L("dashboard.position.bottom") })).toBeChecked();
    await expect(size.getByRole("radio", { name: L("dashboard.size.medium") })).toBeChecked();
    await choose(subtitle.getByRole("radio", { name: L("dashboard.style.sorot") }));
    await spot.getByRole("radio", { name: L("dashboard.position.top") }).click();
    await size.getByRole("radio", { name: L("dashboard.size.large") }).click();
    const preview = subtitle.locator("[data-look-preview]");
    await expect(preview).toHaveAttribute("data-pack", "sorot");
    await expect(preview).toHaveAttribute("data-position", "top");
    await expect(preview).toHaveAttribute("data-size", "large");
    // Away from the bottom the subtitle is clear of the TikTok buttons, so that note goes.
    await expect(subtitle.getByText(L("dashboard.look.inZone"), { exact: true })).toHaveCount(0);
    await expect(subtitle.getByText(L("dashboard.look.advanced", { position: L("dashboard.position.top"), size: L("dashboard.size.large") }), { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await link(page).fill(LINK);
    expect(await submitJob(page, posts)).toMatchObject({ captionStyle: "sorot", captionPosition: "top", captionSize: "large" });

    // The choice comes back on the next visit.
    await reopenDashboard(page);
    await expect(chip(page, "subtitle")).toHaveText(L("dashboard.chip.subtitle", { value: L("dashboard.style.sorot") }));
    subtitle = await openChip(page, "subtitle");
    await expect(subtitle.getByText(L("dashboard.look.advanced", { position: L("dashboard.position.top"), size: L("dashboard.size.large") }), { exact: true })).toBeVisible();
  });

  test("with the legacy engine (rollback) only Karaoke and Klasik at the bottom are offered and sent", async ({ page }) => {
    const posts = await fakeDashboardApi(page, { renderEngine: "legacy" });
    await openDashboard(page);
    const subtitle = await openChip(page, "subtitle");
    await expect(subtitle.getByRole("radiogroup", { name: L("dashboard.chip.subtitleLabel") }).getByRole("radio")).toHaveCount(2);
    await expect(subtitle.locator("details")).toHaveCount(0);
    await expect(subtitle.locator("[data-look-preview]")).toHaveAttribute("data-position", "bottom");
    await choose(subtitle.getByRole("radio", { name: L("dashboard.style.classic") }));
    await page.keyboard.press("Escape");
    await link(page).fill(LINK);
    const sent = await submitJob(page, posts);
    expect(sent).toMatchObject({ captionStyle: "classic" });
    expect(sent).not.toHaveProperty("captionPosition");
    expect(sent).not.toHaveProperty("captionSize");
  });

  test("AI not set up shows one alert with Atur AI; Proses ulang fills the chips from a job", async ({ page }) => {
    const earlier = {
      id: "00000000-0000-4000-8000-000000000201", status: "completed", progress: 100, createdAt: NOW, updatedAt: NOW,
      source: { type: "youtube", url: LINK },
      options: { selectionMode: "v3", renderMode: "face-track", limit: 6, minDuration: 30, maxDuration: 60, captionStyle: "bold", coldOpen: true, hookOverlay: false, outputSize: "1080x1920", videoLanguage: "en" },
      clips: [],
    };
    await fakeDashboardApi(page, { jobs: [earlier], ai: { state: "unconfigured" } });
    await login(page, "/dashboard");
    await page.goto(`/dashboard?ulang=${earlier.id}`);
    const alert = page.locator(".alert", { hasText: L("dashboard.ai.missing") });
    await expect(alert).toBeVisible();
    await expect(alert.getByRole("link", { name: L("dashboard.ai.setup") })).toHaveAttribute("href", "/settings#ai");
    await expect(link(page)).toHaveValue(LINK);
    await expect(chip(page, "count")).toHaveText(L("dashboard.chip.count", { count: 6 }));
    await expect(chip(page, "duration")).toHaveText(L("dashboard.chip.duration", { value: L("dashboard.duration.medium") }));
    await expect(chip(page, "format")).toHaveText("9:16 · 1080p");
    await expect(chip(page, "layout")).toHaveText(L("dashboard.chip.layout", { value: L("layout.names.camera") }));
    await expect(chip(page, "hook")).toHaveText(L("dashboard.chip.hook", { value: L("dashboard.hook.coldOpen") }));
    await expect(chip(page, "language")).toHaveText(L("dashboard.language.en"));
  });

  test("Terbaru shows the newest projects as posters that open them", async ({ page }) => {
    const jobs = [1, 2, 3, 4, 5].map((n) => ({
      id: `00000000-0000-4000-8000-00000000030${n}`, status: n === 1 ? "processing" : "completed", progress: n === 1 ? 40 : 100,
      createdAt: NOW, updatedAt: NOW, source: { type: "upload", name: `Podcast ${n}.mp4` }, options: { selectionMode: "v3" }, clips: [],
    }));
    await fakeDashboardApi(page, { jobs });
    await openDashboard(page);
    const recent = page.getByRole("region", { name: L("dashboard.recent") });
    await expect(recent.getByRole("link", { name: /Podcast/ })).toHaveCount(4);
    await expect(recent.getByRole("link", { name: /Podcast 1\.mp4/ })).toHaveAttribute("href", `/projects/${jobs[0].id}`);
    await expect(recent.getByRole("link", { name: L("dashboard.allProjects") })).toHaveAttribute("href", "/projects");
  });

  test("at 360 px nothing scrolls sideways, every control is a 44 px target and Buat klip sits under the chips", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await fakeDashboardApi(page);
    await openDashboard(page);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    const small = await page.evaluate(() => [...document.querySelectorAll(
      "#youtube-url, label:has(> #video-file), form button[type=submit], [data-chip]",
    )].filter((element) => element.getClientRects().length > 0).map((element) => {
      const box = element.getBoundingClientRect();
      return { control: element.id || element.textContent.trim().slice(0, 30), width: Math.round(box.width), height: Math.round(box.height) };
    }).filter((box) => box.width < 44 || box.height < 44));
    expect(small).toEqual([]);
    const lastChip = await chip(page, "language").boundingBox();
    const submit = await submitButton(page).boundingBox();
    expect(submit.y).toBeGreaterThan(lastChip.y + lastChip.height - 1);
    expect(submit.width).toBeGreaterThan(300);
    for (const id of ["duration", "subtitle", "focus"]) {
      await openChip(page, id);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await page.keyboard.press("Escape");
    }
  });
});
