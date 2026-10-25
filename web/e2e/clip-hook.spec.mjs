import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { expect } from "@playwright/test";

import { expectFailedRequest, login, skipWithoutCredentials, test } from "./support/harness.mjs";
import { L } from "./support/i18n.mjs";

// "Hook di video" on the project page (CONTRACTS §5.57): the switch in the caption box saves the
// clip's document (POST …/hook) and exports the new revision (POST …/renders); the page reads the
// clips listing again and shows the export. The job API, the listing, the switch and the export
// are faked inside the browser (page.route), so nothing on the server changes; only the login is
// real. The real route and the CLI are covered by web/tests/clip-hook-api.test.mjs and
// tests/test_edit_v2_hook_toggle.py.

const JOB_ID = "7b2e4d3f-5c6a-4f7b-9b8c-0d1e2f3a4b5c";
const CLIP_IDS = ["clip_0123456789abcdef01234567", "clip_76543210fedcba9876543210"];
const SEED = "a".repeat(64);
const SAVED = "b".repeat(64);
const RENDER = "5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

function clip(index) {
  const base = `/api/jobs/${JOB_ID}/files/output/clip-0${index}`;
  return {
    index, score: 8.2, start: 60 * index, end: 60 * index + 30, duration: 30, text: "transkrip", selectionSource: "llm",
    title: `Klip ${index}`, hookText: "Dia ditahan security", description: "Cerita dari mall.\n\n#fyp", hashtags: ["#fyp"],
    videoUrl: `${base}.mp4`, downloadUrl: `${base}.mp4?download=1`, subtitleUrl: `${base}.srt?download=1`,
  };
}

const JOB = {
  id: JOB_ID, status: "completed", progress: 100, createdAt: iso(NOW - 3_600_000), updatedAt: iso(NOW - 3_600_000),
  source: { type: "upload", name: "Podcast 14.mp4" }, options: { selectionMode: "v3", llmMode: "auto" }, clips: [1, 2].map(clip),
};

function listed(index, { hook = { on: true, available: true }, etag = SEED, revision = 0, latestRender = null } = {}) {
  return {
    clipId: CLIP_IDS[index - 1], index, title: `Klip ${index}`, hookText: "Dia ditahan security", description: null, hashtags: [],
    durationMs: 30000, engine: "edit-v2/1", edit: { state: revision ? "edited" : "seed", revision, etag, updatedAtMs: 1 },
    hook, latestRender, openable: true, reason: null,
  };
}

/** Fakes the job, the listing, the switch and the export; returns the requests it saw. */
async function fakeProject(target, { hook = { status: 200 }, second = { on: false, available: false } } = {}) {
  const seen = { hooks: [], renders: [], listings: 0 };
  let current = listed(1);
  await target.route(new RegExp(`/api/jobs/${JOB_ID}(?:[/?].*)?$`), async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (status, body) => route.fulfill({ status, contentType: "application/json", headers: { "Cache-Control": "no-store" }, body: JSON.stringify(body) });
    if (url.pathname === `/api/jobs/${JOB_ID}`) return json(200, { job: JOB });
    if (url.pathname === `/api/jobs/${JOB_ID}/clips`) {
      seen.listings += 1;
      return json(200, { clips: [current, listed(2, { hook: second })] });
    }
    if (url.pathname === `/api/jobs/${JOB_ID}/clips/${CLIP_IDS[0]}/hook` && request.method() === "POST") {
      const body = request.postDataJSON();
      seen.hooks.push({ body, key: request.headers()["idempotency-key"], contentType: request.headers()["content-type"] });
      if (hook.status !== 200) return json(hook.status, { code: hook.code, error: "x" });
      current = listed(1, { hook: { on: body.on, available: true }, etag: SAVED, revision: 1,
        latestRender: { renderId: RENDER, state: "queued", revision: 1, url: null, srtUrl: null } });
      return json(200, { etag: SAVED, revision: 1, changed: true, hook: { on: body.on, available: true } });
    }
    if (url.pathname === `/api/jobs/${JOB_ID}/clips/${CLIP_IDS[0]}/renders` && request.method() === "POST") {
      seen.renders.push(request.postDataJSON());
      return json(202, { renderId: RENDER, clipId: CLIP_IDS[0], state: "queued", stage: "antre", progressPm: 0, revision: 1 });
    }
    return route.fulfill({ status: 200, contentType: "video/mp4", body: "" });
  });
  return seen;
}

const detail = (target) => target.locator("[data-clip-detail]");
const caption = (target) => detail(target).getByRole("region", { name: L("project.viewer.caption") });
const hookSwitch = (target) => caption(target).getByRole("switch", { name: "Hook di video" });
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

// The project opened on clip 1 in the clip viewer (?klip=1, 05-ui-dashboard.md §6.4).
async function openProject(page, options) {
  const seen = await fakeProject(page, options);
  await login(page, "/projects");
  await page.goto(`/projects/${JOB_ID}?klip=1`);
  await expect(posters(page)).toHaveCount(2);
  await expect(detail(page)).toHaveAttribute("data-clip-detail", "1");
  return seen;
}

test.describe("Hook di video (faked routes)", () => {
  test.beforeEach(() => skipWithoutCredentials(test));

  test("the switch hides the hook: one save, one export, and the listing shows the export", async ({ page }) => {
    const seen = await openProject(page);
    const toggle = hookSwitch(page);
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(caption(page).getByRole("status").filter({ hasText: "Hook disembunyikan" })).toBeVisible();
    await expect(toggle).not.toBeChecked();
    expect(seen.hooks).toHaveLength(1);
    expect(seen.hooks[0].body).toEqual({ on: false, etag: SEED });
    expect(seen.hooks[0].contentType).toContain("application/json");
    expect(seen.hooks[0].key).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen.renders).toEqual([{ editEtag: SAVED }]);
    await expect(detail(page).getByText("Ekspor sedang diproses")).toBeVisible();
    expect(seen.listings).toBeGreaterThanOrEqual(2);
    // Switched on again from the saved revision.
    await toggle.click();
    await expect(toggle).toBeChecked();
    expect(seen.hooks[1].body).toEqual({ on: true, etag: SAVED });
  });

  test("Space and Enter switch it from the keyboard", async ({ page }) => {
    const seen = await openProject(page);
    const toggle = hookSwitch(page);
    await toggle.focus();
    await page.keyboard.press("Space");
    await expect(toggle).not.toBeChecked();
    // The switch is busy while a save runs; the next key waits for its answer.
    await expect(caption(page).getByRole("status").filter({ hasText: "Hook disembunyikan" })).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(toggle).toBeChecked();
    await expect.poll(() => seen.hooks.map((hook) => hook.body.on)).toEqual([false, true]);
  });

  test("a clip without a hook has no switch", async ({ page }) => {
    await openProject(page);
    await detail(page).getByRole("button", { name: L("aria.next") }).click();
    await expect(detail(page)).toHaveAttribute("data-clip-detail", "2");
    await expect(caption(page).getByRole("switch")).toHaveCount(0);
  });

  test("a save that lost to the editor says so and keeps the switch as it was", async ({ page }) => {
    const seen = await openProject(page, { hook: { status: 409, code: "revision_conflict" } });
    expectFailedRequest(page, 409, "POST", `/api/jobs/${JOB_ID}/clips/${CLIP_IDS[0]}/hook`); // the conflict is the point
    const toggle = hookSwitch(page);
    await toggle.click();
    await expect(caption(page).getByRole("status").filter({ hasText: "Klip ini sudah diubah di editor" })).toBeVisible();
    await expect(toggle).toBeChecked();
    expect(seen.renders).toHaveLength(0);
  });

  test("axe finds nothing serious in the caption box with the switch", async ({ page }) => {
    test.skip(!AXE, "axe-core is not installed (set AXE_CORE_PATH)");
    await openProject(page);
    await expect(hookSwitch(page)).toBeVisible();
    await page.addScriptTag({ content: AXE });
    const result = await page.evaluate(() => window.axe.run("[role=dialog]", { resultTypes: ["violations"] }));
    expect(result.violations.filter((violation) => ["serious", "critical"].includes(violation.impact))
      .map((violation) => violation.id)).toEqual([]);
  });
});

test.describe("Hook di video at 390 px", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test.beforeEach(() => skipWithoutCredentials(test));

  test("the switch is a 44 px target and the panel does not scroll sideways", async ({ page }) => {
    await openProject(page);
    const label = caption(page).locator("label").filter({ hasText: "Hook di video" });
    await expect(label).toBeVisible();
    expect((await label.boundingBox()).height).toBeGreaterThanOrEqual(44);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await label.tap();
    await expect(hookSwitch(page)).not.toBeChecked();
  });
});
