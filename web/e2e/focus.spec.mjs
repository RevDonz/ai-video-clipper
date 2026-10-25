import { expect } from "@playwright/test";

import { login, skipWithoutCredentials, test } from "./support/harness.mjs";
import { L } from "./support/i18n.mjs";

// Fokus klip UI (docs/plans/2026-09-25-fokus-klip.md §3), in the Arahkan chip of Buat klip and in
// the project page's clip viewer (05-ui-dashboard.md §6.3, §6.4). The dashboard's own API calls and
// the job API are faked inside the browser (page.route), so these tests create no job and
// change no server data; only the login is real. Run against a production build
// (`npm run build` then `next start`), like e2e/trends.spec.mjs.

const FOCUS_JOB_ID = "5a0c2d3e-4f50-4a6b-8c7d-8e9f0a1b2c3d";
const PLAIN_JOB_ID = "6b1d3e4f-5061-4b7c-9d8e-9f0a1b2c3d4e";
const HOSTILE = "<img src=x onerror=\"window.__fx=1\">";
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

// The multipart fields of a job POST, in order, as [name, value] pairs (the page sends the job
// through XMLHttpRequest; page.route sees it as it saw the fetch).
function multipartFields(request) {
  const boundary = /boundary=(.+)$/.exec(request.headers()["content-type"] || "")?.[1];
  const body = request.postDataBuffer()?.toString("utf8") || "";
  if (!boundary) return [];
  return body.split(`--${boundary}`).flatMap((part) => {
    const match = /name="([^"]+)"\r\n\r\n([\s\S]*)\r\n$/.exec(part);
    return match ? [[match[1], match[2]]] : [];
  });
}

// The job form names no selection mode: the job API always uses the current one.
// With the editor engine for automatic clips the form also sends the output size and the
// subtitle position and size (CONTRACTS §5.48, §5.54).
const JOB_FIELDS = ["renderMode", "outputSize", "limit", "minDuration", "maxDuration", "coldOpen", "hookOverlay", "captionStyle",
  "captionPosition", "captionSize", "videoLanguage"];
const ACTIVE_AI = { state: "active", order: ["uji"], providers: [{ name: "uji", displayName: null }], label: "LLM aktif: uji" };

/** Fakes /api/jobs, /api/llm/status and /api/storage/status for the dashboard. Returns the job POSTs. */
async function fakeDashboardApi(page, { llm = ACTIVE_AI } = {}) {
  const posts = [];
  const job = (id) => ({ id, status: "completed", progress: 100, stage: "completed", createdAt: iso(NOW), updatedAt: iso(NOW), source: { type: "youtube", url: "https://youtu.be/rBg0ZcwjVKQ" }, options: { selectionMode: "v3" }, clips: [] });
  await page.route(/\/api\/(?:jobs|llm\/status|storage\/status)(?:[/?]|$)/, (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const json = (status, body) => route.fulfill({ status, contentType: "application/json", headers: { "Cache-Control": "no-store" }, body: JSON.stringify(body) });
    if (pathname === "/api/llm/status") return json(200, { llm });
    if (pathname === "/api/storage/status") return json(200, { admission: { allowed: true, code: null } });
    if (pathname === "/api/jobs" && request.method() === "POST") {
      posts.push(multipartFields(request));
      return json(202, { job: job(`00000000-0000-4000-8000-${String(posts.length).padStart(12, "0")}`) });
    }
    if (pathname === "/api/jobs") return json(200, { jobs: [] });
    if (pathname.endsWith("/clips")) return json(404, {});
    return json(200, { job: job(pathname.split("/")[3]) });
  });
  return posts;
}

// The dashboard is prerendered: typing before hydration would be lost, so the page is used once
// the jobs list (fetched after hydration) has answered. The focus field sits in the Arahkan
// chip's popover, which is opened.
async function openDashboard(page) {
  const listed = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/jobs" && response.request().method() === "GET");
  await login(page, "/dashboard");
  await listed;
  await openFocus(page);
}

const focusChip = (page) => page.locator('[data-chip="focus"]');
const focusPopover = (page) => page.locator('[data-chip-popover="focus"]');
async function openFocus(page) {
  if (await focusPopover(page).count()) return;
  await focusChip(page).click();
  await expect(focusPopover(page)).toBeVisible();
}
// Closes the popover (React Aria hides the page behind it), so the link and Buat klip can be used.
async function closeFocus(page) {
  if (!(await focusPopover(page).count())) return;
  await page.keyboard.press("Escape");
  await expect(focusPopover(page)).toHaveCount(0);
}

const termsInput = (page) => page.getByLabel(L("dashboard.focus.terms"), { exact: true });
const noteInput = (page) => page.getByLabel(L("dashboard.focus.note"), { exact: true });
const removeTerm = (page, term) => page.getByRole("button", { name: L("dashboard.focus.remove", { term }), exact: true });
const chipTexts = (page) => page.getByRole("list", { name: L("dashboard.focus.list") }).locator("li > span");
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const submitButton = (page) => page.getByRole("button", { name: L("dashboard.submit.idle"), exact: true });
const link = (page) => page.getByLabel(L("dashboard.source.link"), { exact: true });

async function submitJob(page, posts) {
  const before = posts.length;
  await closeFocus(page);
  await submitButton(page).click();
  await expect.poll(() => posts.length).toBe(before + 1);
  await expect(page).toHaveURL(/\/projects\/00000000-/);
  return posts.at(-1);
}

test.describe("Fokus klip on the dashboard (faked job API)", () => {
  test.beforeEach(() => skipWithoutCredentials(test));

  test("comma and Enter make chips; bad text stays with a message; chips are removed by keyboard; the POST carries the focus", async ({ page }) => {
    const posts = await fakeDashboardApi(page);
    await openDashboard(page);
    const input = termsInput(page);
    await expect(input).toBeVisible();

    await input.pressSequentially("jomok,");
    await expect(chipTexts(page)).toHaveText(["jomok"]);
    await expect(input).toHaveValue("");
    await input.fill("jomokers");
    await input.press("Enter");
    await expect(chipTexts(page)).toHaveText(["jomok", "jomokers"]);
    expect(posts).toHaveLength(0);

    // Too short: stays in the input with a message. A duplicate is dropped with a message.
    await input.fill("a");
    await input.press("Enter");
    await expect(page.getByRole("alert").filter({ hasText: "Kata kunci “a” terlalu pendek (minimal 2 karakter)." })).toBeVisible();
    await expect(input).toHaveValue("a");
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await input.fill("JOMOK");
    await input.press("Enter");
    await expect(page.getByRole("alert").filter({ hasText: "“JOMOK” sudah ada." })).toBeVisible();
    await expect(chipTexts(page)).toHaveText(["jomok", "jomokers"]);
    await input.fill("x".repeat(41));
    await input.press("Enter");
    await expect(page.getByRole("alert").filter({ hasText: /terlalu panjang \(maksimal 40 karakter\)/ })).toBeVisible();
    await input.fill("");

    // Keyboard removal: focus moves to the next chip, then back to the input.
    await removeTerm(page, "jomok").focus();
    await page.keyboard.press("Enter");
    await expect(chipTexts(page)).toHaveText(["jomokers"]);
    await expect(removeTerm(page, "jomokers")).toBeFocused();
    await page.keyboard.press("Space");
    await expect(page.getByRole("list", { name: L("dashboard.focus.list") })).toHaveCount(0);
    await expect(input).toBeFocused();

    await input.fill("jomok, jomokers");
    await input.press("Enter");
    await expect(chipTexts(page)).toHaveText(["jomok", "jomokers"]);
    const note = noteInput(page);
    await note.fill("momen jomok yang lucu");
    await expect(page.getByText("21/200", { exact: true })).toBeVisible();

    // Text still in the input is committed when the popover closes or the job is created.
    await input.fill("reza auditore");
    await closeFocus(page);
    await expect(focusChip(page)).toHaveText(`${L("dashboard.chip.focus")} · 4`);
    await link(page).fill("https://youtu.be/rBg0ZcwjVKQ");
    const fields = await submitJob(page, posts);
    expect(fields).toEqual([
      ["renderMode", "fit-blur"], ["outputSize", "720x1280"], ["limit", "3"], ["minDuration", "20"], ["maxDuration", "60"],
      ["coldOpen", "true"], ["hookOverlay", "true"], ["captionStyle", "karaoke"], ["captionPosition", "bottom"],
      ["captionSize", "medium"], ["videoLanguage", "id"],
      ["focusTerms", "jomok,jomokers,reza auditore"], ["focusNote", "momen jomok yang lucu"],
      ["youtubeUrl", "https://youtu.be/rBg0ZcwjVKQ"],
    ]);
  });

  test("a pasted list becomes one chip per line; a term the transcript can never say gets a hint", async ({ page }) => {
    const posts = await fakeDashboardApi(page);
    await openDashboard(page);
    const input = termsInput(page);
    const paste = (text) => input.evaluate((element, value) => {
      const data = new DataTransfer();
      data.setData("text/plain", value);
      element.focus();
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, text);

    await paste("jomok\njomokers\r\nreza");
    await expect(chipTexts(page)).toHaveText(["jomok", "jomokers", "reza"]);
    await expect(input).toHaveValue("");

    const hint = page.locator("#focus-terms-hint");
    await expect(hint).toHaveCount(0);
    await input.fill("AI");
    await input.press("Enter");
    await expect(chipTexts(page)).toHaveText(["jomok", "jomokers", "reza", "AI"]);
    await expect(hint).toHaveText("“AI” terlalu pendek atau terlalu umum untuk dicari langsung di transkrip; hanya AI yang bisa mengenalinya dari maknanya.");
    await expect(input).toHaveAttribute("aria-describedby", "focus-terms-help focus-terms-hint");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await overflow(page)).toBe(0);
    await removeTerm(page, "AI").click();
    await expect(hint).toHaveCount(0);
    expect(posts).toHaveLength(0);
  });

  test("without focus the job form sends no focus field and never names a selection mode", async ({ page }) => {
    const posts = await fakeDashboardApi(page);
    await openDashboard(page);
    await closeFocus(page);
    await link(page).fill("https://youtu.be/rBg0ZcwjVKQ");
    const plain = await submitJob(page, posts);
    expect(plain.map(([name]) => name)).toEqual([...JOB_FIELDS, "youtubeUrl"]);
    await expect(page.getByText(/Mode lama|Klasik V1|AI Hook/)).toHaveCount(0);
  });

  test("without an active AI the focus help says only literal mentions count", async ({ page }) => {
    const status = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/llm/status");
    await fakeDashboardApi(page, { llm: { state: "disabled", label: "AI dimatikan di Pengaturan" } });
    await openDashboard(page);
    await status;
    await expect(focusPopover(page).getByText(L("dashboard.focus.noteOff"), { exact: true })).toBeVisible();
    const input = termsInput(page);
    await input.fill("AI");
    await input.press("Enter");
    await expect(page.locator("#focus-terms-hint")).toContainText("Tanpa AI kata kunci itu tidak berpengaruh.");
  });

  test("a note without terms or an overlong note blocks the job with a message", async ({ page }) => {
    const posts = await fakeDashboardApi(page);
    await openDashboard(page);
    await noteInput(page).fill("momen lucu");
    await closeFocus(page);
    await link(page).fill("https://youtu.be/rBg0ZcwjVKQ");
    await submitButton(page).click();
    // The Arahkan chip opens again on its field, with the reason; nothing is sent.
    await expect(focusPopover(page)).toBeVisible();
    await expect(termsInput(page)).toBeFocused();
    await expect(page.getByRole("alert").filter({ hasText: "Isi minimal satu kata kunci fokus, atau kosongkan catatan untuk AI." })).toBeVisible();
    const note = noteInput(page);

    await termsInput(page).fill("jomok");
    await note.fill("n".repeat(201));
    await expect(page.getByText("201/200", { exact: true })).toBeVisible();
    await closeFocus(page);
    await submitButton(page).click();
    await expect(focusPopover(page)).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: "Catatan untuk AI maksimal 200 karakter." })).toBeVisible();
    expect(posts).toHaveLength(0);

    await noteInput(page).fill("n".repeat(200));
    const fields = await submitJob(page, posts);
    expect(Object.fromEntries(fields)).toMatchObject({ focusTerms: "jomok", focusNote: "n".repeat(200) });
  });
});

// --- Project page -----------------------------------------------------------------------------

function projectJob(id, { focus = null, clips }) {
  return {
    id, status: "completed", progress: 100, createdAt: iso(NOW - 86_400_000), updatedAt: iso(NOW - 86_400_000), source: { type: "upload", name: "ferry-x-reza.mp4" },
    options: { renderMode: "fit-blur", limit: 3, minDuration: 20, maxDuration: 60, selectionMode: "v3", llmMode: "auto", coldOpen: false, hookOverlay: true, captionStyle: "karaoke", ...(focus ? { focus: { terms: focus.terms, mode: "prefer" } } : {}) },
    selectionV3: {
      mode: "v3", status: "completed", source: "llm", provider: "groq", model: "m", prompt_version: "llm-select-v2", artifact: null, transcript_source: "youtube-captions",
      warnings: focus ? ["focus_few_matches:2"] : [], ...(focus ? { focus } : {}),
    },
    clips,
  };
}

function projectClip(jobId, index, extra = {}) {
  return {
    index, start: 60 * index, end: 60 * index + 30, duration: 30, text: "transkrip", title: `Judul klip ${index}`, description: "Deskripsi.\n\n#fyp", hashtags: ["#fyp"],
    selectionSource: "llm", videoUrl: `/api/jobs/${jobId}/files/output/clip-0${index}.mp4`, downloadUrl: `/api/jobs/${jobId}/files/output/clip-0${index}.mp4?download=1`, ...extra,
  };
}

const FOCUS_JOB = projectJob(FOCUS_JOB_ID, {
  focus: { terms: ["jomok", HOSTILE], matched: 2, requested: 3 },
  clips: [
    projectClip(FOCUS_JOB_ID, 1, { focus: { match: "literal", terms: ["jomok"], at: 754 } }),
    projectClip(FOCUS_JOB_ID, 2, { focus: { match: "semantic", terms: [], at: null } }),
    projectClip(FOCUS_JOB_ID, 3, { focus: { match: "none", terms: [], at: null } }),
  ],
});
const PLAIN_JOB = projectJob(PLAIN_JOB_ID, { clips: [projectClip(PLAIN_JOB_ID, 1), projectClip(PLAIN_JOB_ID, 2)] });

async function fakeProjectApi(page, jobs) {
  await page.route(/\/api\/jobs\/[0-9a-f-]{36}(?:\/.*)?$/, (route) => {
    const { pathname } = new URL(route.request().url());
    const [, , , id, ...rest] = pathname.split("/");
    const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (!rest.length) return json({ job: jobs[id] });
    if (rest[0] === "clips") return json({}, 404);
    return route.fulfill({ status: 200, contentType: "video/mp4", body: "" });
  });
}

const focusLine = (page) => page.locator("p").filter({ hasText: new RegExp(`^${L("project.focus")}`) });
const clipCard = (page, index) => page.getByRole("article", { name: `Judul klip ${index}`, exact: true });
// A clip's poster opens it in the clip viewer (a dialog); Escape closes it before the next one.
async function clipDetail(page, index) {
  if (await page.locator("[data-clip-detail]").count()) {
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  await clipCard(page, index).getByRole("button").click();
  const detail = page.getByRole("dialog");
  await expect(detail.getByRole("heading", { level: 3 })).toHaveText(`Judul klip ${index}`);
  return detail;
}

test.describe("Fokus klip on the project page (faked job API)", () => {
  test.beforeEach(() => skipWithoutCredentials(test));

  test("focus line and per-clip labels; hostile terms stay text; a job without focus looks as before", async ({ page }) => {
    await fakeProjectApi(page, { [FOCUS_JOB_ID]: FOCUS_JOB, [PLAIN_JOB_ID]: PLAIN_JOB });
    await login(page, "/projects");
    await page.goto(`/projects/${FOCUS_JOB_ID}`);
    await expect(focusLine(page)).toHaveText(`Fokus: jomok, ${HOSTILE} · 2 dari 3 klip cocok`);
    await expect((await clipDetail(page, 1)).locator("[data-focus]")).toHaveText("Menyebut 'jomok' · 12:34");
    await expect((await clipDetail(page, 1)).locator("[data-focus]")).toHaveAttribute("data-focus", "literal");
    await expect((await clipDetail(page, 2)).locator("[data-focus]")).toHaveText(`Terkait 'jomok', '${HOSTILE}' (menurut AI)`);
    await expect((await clipDetail(page, 3)).locator("[data-focus]")).toHaveText("Di luar fokus");
    await expect(page.locator("main article img, [data-clip-detail] img")).toHaveCount(0);
    expect(await page.evaluate(() => window.__fx)).toBeUndefined();
    await page.keyboard.press("Escape");
    // The clip outside the focus has its own filter; no warning code on the page (05 §6.4 drops
    // the closed notes list).
    const filters = page.getByRole("radiogroup", { name: L("project.filter.label") });
    await filters.getByRole("radio", { name: new RegExp(`^${L("project.filter.outsideFocus")}`) }).click();
    await expect(page.getByRole("article")).toHaveCount(1);
    await expect(clipCard(page, 3)).toBeVisible();
    await expect(page.getByText(/focus_few_matches|Kode peringatan|Catatan pemilihan/)).toHaveCount(0);

    await page.goto(`/projects/${PLAIN_JOB_ID}`);
    await expect(clipCard(page, 1)).toBeVisible();
    await expect(focusLine(page)).toHaveCount(0);
    await expect(page.locator("[data-focus]")).toHaveCount(0);
    await expect(page.getByText(/Di luar fokus|Menyebut '|menurut AI/)).toHaveCount(0);
  });
});

test.describe("Fokus klip at 390 px", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test.beforeEach(() => skipWithoutCredentials(test));

  test("eight long chips and a full note fit without horizontal scroll; chips are reachable with Shift+Tab", async ({ page }) => {
    const posts = await fakeDashboardApi(page);
    await openDashboard(page);
    const input = termsInput(page);
    const terms = Array.from({ length: 8 }, (_, index) => `${index}${"panjangsekali".repeat(3)}`.slice(0, 40));
    await input.fill(terms.join(","));
    await input.press("Enter");
    await expect(chipTexts(page)).toHaveText(terms);
    await expect(input).toHaveAttribute("placeholder", L("dashboard.focus.full", { max: 8 }));
    await noteInput(page).fill("catatan ".repeat(25).trim());
    await input.fill("satu lagi");
    await input.press("Enter");
    await expect(page.getByRole("alert").filter({ hasText: "Maksimal 8 kata kunci." })).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);

    await input.fill("");
    await input.focus();
    await page.keyboard.press("Shift+Tab");
    await expect(removeTerm(page, terms[7])).toBeFocused();
    expect(posts).toHaveLength(0);
  });

  test("the project page's focus line and labels fit without horizontal scroll", async ({ page }) => {
    const long = "katakuncipanjangsekalitanpaspasi12345678";
    const job = projectJob(FOCUS_JOB_ID, {
      focus: { terms: [long, "jomok"], matched: 1, requested: 2 },
      clips: [projectClip(FOCUS_JOB_ID, 1, { focus: { match: "literal", terms: [long, "jomok"], at: 3723 } }), projectClip(FOCUS_JOB_ID, 2, { focus: { match: "none", terms: [], at: null } })],
    });
    await fakeProjectApi(page, { [FOCUS_JOB_ID]: job });
    await login(page, "/projects");
    await page.goto(`/projects/${FOCUS_JOB_ID}`);
    await expect((await clipDetail(page, 1)).locator("[data-focus]")).toHaveText(`Menyebut '${long}', 'jomok' · 1:02:03`);
    await expect(focusLine(page)).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });
});
