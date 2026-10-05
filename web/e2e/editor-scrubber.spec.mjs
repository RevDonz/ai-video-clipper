// Mode Cepat's scrubber (docs/plans/2026-10-02-editor-mode-cepat.md §7, AC8), by pointer and by
// keyboard.
//
// 1. The real Scrubber in a harness page (no server, no login): transcript/__dev__/bundle.mjs
//    compiles scrubber/__dev__/scrubber-harness-entry.jsx over the marker fixtures of the Python
//    vectors, so the drawn marks are checked against the timeline's own marker model.
// 2. The scrubber in the editor on its fakes (`?mode=cepat`): the slider, its keys and the
//    analysis note there.
//
//   E2E_ALLOW_SKIP=1 E2E_NO_WEB_SERVER=1 npx playwright test e2e/editor-scrubber.spec.mjs \
//     --project=desktop-chromium            (the harness part; the editor part needs the fakes)
// On GitHub Actions: gh workflow run editor-gates.yml -f ref=<branch> -f suite=e2e \
//   -f command='e2e/editor-scrubber.spec.mjs'
import { expect, test as base } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FAKE_CLIP_ID, FAKE_JOB_ID, fakeWords } from "../components/editor/__dev__/fakes.mjs";
import {
  MERGE_PX, drawGroups, frameAtPx, nearestMark, nextMark, pxAtFrame, scrubberMarks,
} from "../components/editor/scrubber/scrubber-model.mjs";
import { HARNESS_HTML, bundleHarness } from "../components/editor/transcript/__dev__/bundle.mjs";
import { caseWords } from "../components/editor/timeline/lanes/__dev__/marker-cases.mjs";
import { buildMarkers, unavailableKinds, unavailableNote } from "../components/editor/timeline/lanes/markers.mjs";
import { pieces, totalFrames } from "../lib/editor/timemap.mjs";
import { login, settings } from "./support/harness.mjs";

const ORIGIN = "http://editor-scrubber.test";
const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(WEB, "components", "editor", "scrubber", "__dev__", "scrubber-harness-entry.jsx");
const FIXTURES = path.join(WEB, "..", "tests", "fixtures", "edit_v2");
const CEPAT = `/projects/${FAKE_JOB_ID}/clips/${FAKE_CLIP_ID}/edit?mode=cepat`;

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const vectors = readJson(path.join(FIXTURES, "marker-vectors.json"));
const contextWords = (id) => readJson(path.join(FIXTURES, "docs", "contexts", `${id}.words.json`));

/** A marker-vector case: its document (the join restyled when asked) and words. */
function fixture(name, { style = null, sfx = null } = {}) {
  const kase = vectors.cases.find((entry) => entry.name === name);
  const doc = structuredClone(kase.doc);
  if (style && doc.main.joins[0]) doc.main.joins[0].style = style;
  if (sfx === true && doc.main.joins[0]) doc.main.joins[0].sfx = { id: "whoosh", v: 1 };
  if (sfx === false && doc.main.joins[0]) delete doc.main.joins[0].sfx;
  return { doc, words: caseWords(contextWords(kase.context), kase) };
}

function pinnedChrome() {
  const candidate = path.join(os.homedir(), ".cache", "ms-playwright", "chromium-1217", "chrome-linux64", "chrome");
  return existsSync(candidate) ? candidate : undefined;
}

const chrome = process.env.EDITOR_CHROME || process.env.PARITY_CHROME || pinnedChrome();
// ---------------------------------------------------------------------------------------------
// 1. The harness

const harnessTest = base;
harnessTest.use({ launchOptions: chrome ? { executablePath: chrome } : {}, viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 });

let bundle = null;
harnessTest.describe("scrubber (harness, marker fixtures)", () => {
  harnessTest.beforeAll(async () => {
    bundle = await bundleHarness({ entry: ENTRY });
  });

  async function openHarness(page, config) {
    await page.route(`${ORIGIN}/**`, async (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/") return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: HARNESS_HTML });
      if (pathname === "/harness.js") return route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: bundle });
      return route.fulfill({ status: 404, body: "" });
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await page.addInitScript((value) => { window.__HARNESS_CONFIG__ = value; }, config);
    await page.goto(`${ORIGIN}/`);
    await page.waitForFunction(() => window.__harness?.ready === true);
    await expect(page.locator("[data-scrubber]")).toBeVisible();
    return errors;
  }

  const slider = (page) => page.getByRole("slider", { name: "Posisi putar" });
  const track = (page) => page.locator("[data-scrubber] > div").first();
  const frame = (page) => page.evaluate(() => window.__harness.frameBus.get());
  const calls = (page) => page.evaluate(() => window.__harness.player.calls);

  // The track's box as the page measures it (the scrubber's own scale).
  async function geometry(page) {
    const box = await track(page).evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    });
    return { box, scale: { width: box.width, total: await page.evaluate(() => window.__harness.plan().totalFrames) } };
  }

  harnessTest("a mark at every laugh and pause of the marker model, merged under 6 px at the earliest frame", async ({ page }) => {
    for (const name of ["c30/seed", "c25/seed", "c24/dense_cold_open_cut"]) {
      const { doc, words } = fixture(name);
      const errors = await openHarness(page, { doc, words, width: 900 });
      const { box, scale } = await geometry(page);
      expect(scale.total).toBe(totalFrames(pieces(doc)));
      const model = scrubberMarks({ doc, words });
      const groups = drawGroups(model.marks, scale.width / scale.total);
      const drawn = page.locator('[data-scrubber-mark]:not([data-kind="join"])');
      await expect(drawn).toHaveCount(groups.length);
      const shown = await drawn.evaluateAll((nodes) => nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        return { f: Number(node.dataset.f), count: Number(node.dataset.count), kind: node.dataset.kind, label: node.dataset.label,
          centre: rect.left + rect.width / 2 };
      }));
      expect(shown.map(({ f, count, kind, label }) => ({ f, count, kind, label })))
        .toEqual(groups.map((group) => ({ f: group.f, count: group.marks.length, kind: group.kind, label: group.label })));
      for (const [index, mark] of shown.entries()) expect(Math.abs(mark.centre - box.x - groups[index].x)).toBeLessThanOrEqual(0.75);
      // Every laugh and pause frame of buildMarkers (±0) lies in a drawn group, under 6 px from its dot.
      const { markers } = buildMarkers(words, doc);
      const kept = markers.filter((marker) => marker.kind === "laughter" || marker.kind === "silence");
      expect(kept.length).toBeGreaterThan(0);
      for (const marker of kept) {
        const group = groups.find((entry) => entry.marks.some((mark) => mark.f === marker.f0 && mark.kind === marker.kind));
        expect(group, `${name} ${marker.key}`).toBeTruthy();
        expect((marker.f0 - group.f) * (scale.width / scale.total)).toBeLessThan(MERGE_PX);
      }
      expect(errors).toEqual([]);
      await page.unrouteAll({ behavior: "ignoreErrors" });
    }
  });

  harnessTest("the cold-open bar spans [0, J) and the join mark sits at J, drawn per transition", async ({ page }) => {
    const { doc, words } = fixture("c30/seed", { style: "flash_white", sfx: true });
    await openHarness(page, { doc, words, width: 900 });
    const { scale } = await geometry(page);
    const J = scrubberMarks({ doc, words }).coldOpen.f1;
    const bar = page.locator("[data-scrubber-cold]");
    await expect(bar).toHaveAttribute("data-f1", String(J));
    expect(Math.abs((await bar.boundingBox()).width - pxAtFrame(J, scale))).toBeLessThanOrEqual(0.75);
    const join = page.locator('[data-scrubber-mark][data-kind="join"]');
    await expect(join).toHaveAttribute("data-f", String(J));
    await expect(join).toHaveAttribute("data-style", "flash_white");
    await expect(join).toHaveCSS("background-color", "rgb(247, 245, 237)");
    await expect(page.locator("[data-scrubber-legend]")).toHaveText(/Tawa\s*Jeda\s*Cold open\s*Transisi/);
    for (const [style, sfx, shows, fill] of [["dip_black", false, true, "rgb(8, 9, 7)"], ["cut", true, true, "rgba(0, 0, 0, 0)"], ["cut", false, false, null]]) {
      await page.evaluate((next) => window.__harness.setDoc(next), fixture("c30/seed", { style, sfx }).doc);
      await expect(join).toHaveCount(shows ? 1 : 0);
      if (shows) await expect(join).toHaveCSS("background-color", fill);
      await expect(page.locator("[data-scrubber-legend]")).toContainText(shows ? "Transisi" : "Cold open");
      if (!shows) await expect(page.locator("[data-scrubber-legend]")).not.toContainText("Transisi");
    }
  });

  harnessTest("a press seeks; within 6 px of a mark it snaps to the mark; dragging seeks as it goes", async ({ page }) => {
    // c24's join stands apart from its laughs and pauses at this width.
    const { doc, words } = fixture("c24/seed", { style: "dip_black" });
    await openHarness(page, { doc, words, width: 900 });
    const { box, scale } = await geometry(page);
    const model = scrubberMarks({ doc, words });
    const ppf = scale.width / scale.total;
    const groups = drawGroups(model.marks, ppf);
    const joinX = pxAtFrame(model.join.f, scale);
    const xs = [...groups.map((group) => group.x), joinX];
    const alone = (x) => xs.filter((other) => Math.abs(other - x) <= 20).length === 1;
    const y = box.y + box.height / 2;
    // A press 4 px right of a mark seeks to the mark's frame, not to the frame under the pointer.
    const target = groups.find((group) => alone(group.x));
    expect(frameAtPx(target.x + 4, scale)).not.toBe(target.f);
    expect(nearestMark(model.marks, frameAtPx(target.x + 4, scale), ppf)?.f).toBe(target.f);
    await page.mouse.click(box.x + target.x + 4, y);
    await expect.poll(() => frame(page)).toBe(target.f);
    await expect(slider(page)).toBeFocused();
    // The join snaps too.
    expect(alone(joinX)).toBe(true);
    await page.mouse.click(box.x + joinX - 5, y);
    await expect.poll(() => frame(page)).toBe(model.join.f);
    // Far from every mark: the frame under the pointer.
    const free = [0.1, 0.3, 0.5, 0.7, 0.9].map((part) => part * box.width).find((x) => xs.every((markX) => Math.abs(markX - x) > 12));
    await page.mouse.click(box.x + free, y);
    await expect.poll(() => frame(page)).toBe(frameAtPx(free, scale));
    // A drag: several seeks on the way, the last one under the pointer.
    const before = (await calls(page)).length;
    await page.mouse.move(box.x + box.width * 0.2, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, y, { steps: 8 });
    await page.mouse.move(box.x + box.width * 0.62, y, { steps: 4 });
    await page.mouse.up();
    await expect.poll(() => frame(page)).toBe(frameAtPx(box.width * 0.62, scale));
    const seeks = (await calls(page)).slice(before).filter(([name]) => name === "seek");
    expect(seeks.length).toBeGreaterThan(2);
    // The slider shows the playhead, not where the native range would have put it.
    await expect(slider(page)).toHaveValue(String(frameAtPx(box.width * 0.62, scale)));
  });

  harnessTest("hovering a mark shows its label; the merged dot names every mark", async ({ page }) => {
    const { doc, words } = fixture("c24/dense_cold_open_cut");
    await openHarness(page, { doc, words, width: 900 });
    const { box, scale } = await geometry(page);
    const groups = drawGroups(scrubberMarks({ doc, words }).marks, scale.width / scale.total);
    const merged = groups.find((group) => group.marks.length > 1);
    expect(merged).toBeTruthy();
    await page.mouse.move(box.x + merged.x + 2, box.y + box.height / 2);
    await expect(page.locator("[data-scrubber-tip]")).toHaveText(merged.label);
    expect(merged.label).toMatch(/^(Tawa|Jeda)( \(\d+\))?(, (Tawa|Jeda)( \(\d+\))?)? · \d\d:\d\d,\d$/);
    await page.mouse.move(box.x + box.width / 2, box.y - 40);
    await expect(page.locator("[data-scrubber-tip]")).toHaveCount(0);
  });

  harnessTest("keys: a frame, a second, the ends, and PageUp/PageDown through the marks and the cold-open edges", async ({ page }) => {
    const { doc, words } = fixture("c30/seed", { style: "flash_white" });
    await openHarness(page, { doc, words, width: 900 });
    const model = scrubberMarks({ doc, words });
    const total = totalFrames(pieces(doc));
    await page.locator("[data-harness-before]").focus();
    await page.keyboard.press("Tab");
    await expect(slider(page)).toBeFocused();
    await expect(slider(page)).toHaveAttribute("max", String(total - 1));
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => frame(page)).toBe(1);
    await page.keyboard.press("Shift+ArrowRight");
    await expect.poll(() => frame(page)).toBe(31);
    await page.keyboard.press("Shift+ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect.poll(() => frame(page)).toBe(0);
    await page.keyboard.press("End");
    await expect.poll(() => frame(page)).toBe(total - 1);
    await expect(slider(page)).toHaveValue(String(total - 1));
    await page.keyboard.press("Home");
    await expect.poll(() => frame(page)).toBe(0);
    const visited = [];
    for (let at = 0, next = nextMark(model.stops, 0, 1); next !== null; next = nextMark(model.stops, at, 1)) {
      await page.keyboard.press("PageDown");
      await expect.poll(() => frame(page)).toBe(next);
      visited.push(next);
      at = next;
    }
    expect(visited).toEqual(model.stops.filter((stop) => stop > 0));
    expect(visited).toContain(model.coldOpen.f1);
    await page.keyboard.press("PageDown");
    await expect.poll(() => frame(page)).toBe(visited.at(-1));
    await page.keyboard.press("PageUp");
    await expect.poll(() => frame(page)).toBe(visited.at(-2));
    // Landing on a mark shows its label to sighted keyboard users too.
    await expect(page.locator("[data-scrubber-tip]")).toBeVisible();
    await expect(slider(page)).toBeFocused();
  });

  harnessTest("aria-valuetext reads the playhead and the length; while playing the value moves at most 4 times a second", async ({ page }) => {
    const { doc, words } = fixture("c30/seed");
    await openHarness(page, { doc, words, width: 900 });
    const total = totalFrames(pieces(doc));
    await page.evaluate(() => window.__harness.player.seek(66));
    await expect(slider(page)).toHaveAttribute("aria-valuetext", new RegExp(`^00:02,2 dari \\d\\d:\\d\\d,\\d$`));
    await expect(slider(page)).toHaveValue("66");
    const counted = await page.evaluate(async (frames) => {
      const input = document.querySelector('[data-scrubber] input[type="range"]');
      let changes = 0;
      const observer = new MutationObserver((records) => { changes += records.length; });
      observer.observe(input, { attributes: true, attributeFilter: ["aria-valuetext"] });
      await window.__harness.player.play();
      const started = performance.now();
      for (let f = 100; performance.now() - started < 1000 && f < frames; f += 1) {
        window.__harness.frameBus.set(f);
        await new Promise((resolve) => { setTimeout(resolve, 16); });
      }
      window.__harness.player.pause();
      observer.disconnect();
      return changes;
    }, total);
    expect(counted).toBeGreaterThanOrEqual(2);
    expect(counted).toBeLessThanOrEqual(5);
  });

  harnessTest("Space and K play and pause from the focused scrubber; focus stays", async ({ page }) => {
    const { doc, words } = fixture("c30/seed");
    await openHarness(page, { doc, words, width: 900 });
    await slider(page).focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("k");
    await page.keyboard.press("K");
    expect((await calls(page)).map(([name]) => name).filter((name) => name !== "seek")).toEqual(["play", "pause", "play"]);
    await expect(slider(page)).toBeFocused();
  });

  harnessTest("the note under the legend when the job lacks analysis, as the marker lane shows it", async ({ page }) => {
    const { doc, words } = fixture("c24/no_analysis");
    await openHarness(page, { doc, words, width: 900 });
    await expect(page.locator("[data-scrubber-note]")).toHaveText(unavailableNote(unavailableKinds(words)));
    const full = fixture("c30/seed");
    await page.evaluate((next) => window.__harness.setDoc(next), full.doc);
    await expect(page.locator("[data-scrubber-note]")).toHaveText(unavailableNote(unavailableKinds(words)));
  });
});

// ---------------------------------------------------------------------------------------------
// 2. The editor on its fakes, Mode Cepat

const test = base.extend({
  workerStorageState: [async ({ browser }, use) => {
    const context = await browser.newContext({ baseURL: settings.baseURL });
    const page = await context.newPage();
    await login(page, "/projects");
    const state = await context.storageState();
    await context.close();
    await use(state);
  }, { scope: "worker" }],
  storageState: ({ workerStorageState }, use) => use(workerStorageState),
});

test.describe("scrubber (editor fakes, Mode Cepat)", () => {
  test.use({ launchOptions: chrome ? { executablePath: chrome } : {}, viewport: { width: 1366, height: 650 }, deviceScaleFactor: 1 });
  test.skip(process.env.E2E_EDITOR_FAKES !== "1",
    "E2E_EDITOR_FAKES=1 is required (server with POTONGIN_EDITOR_V3=on and POTONGIN_EDITOR_FAKES=1)");
  test.skip(!settings.username || !settings.password, "E2E_USERNAME and E2E_PASSWORD are required");

  async function openCepat(page) {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(CEPAT);
    await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 30_000 });
    return errors;
  }

  const slider = (page) => page.getByRole("slider", { name: "Posisi putar" });
  const frame = (page) => page.evaluate(() => window.__potonginEditor.player.frame());

  test("the slider seeks by keys and by pointer, and Space and K play and pause from it", async ({ page }) => {
    const errors = await openCepat(page);
    const total = await page.evaluate(() => window.__potonginEditor.store.getState().plan.totalFrames);
    await expect(slider(page)).toHaveAttribute("max", String(total - 1));
    await expect(slider(page)).toHaveAttribute("aria-valuetext", /^00:00,0 dari \d\d:\d\d,\d$/);
    await slider(page).focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => frame(page)).toBe(1);
    await page.keyboard.press("Shift+ArrowRight");
    await expect.poll(() => frame(page)).toBe(31);
    await page.keyboard.press("End");
    await expect.poll(() => frame(page)).toBe(total - 1);
    await page.keyboard.press("Home");
    await expect.poll(() => frame(page)).toBe(0);
    // The fakes have no laughs or pauses and no cold open: PageDown has nowhere to go.
    await page.keyboard.press("PageDown");
    await expect.poll(() => frame(page)).toBe(0);
    const box = await slider(page).boundingBox();
    await page.mouse.click(box.x + box.width / 4, box.y + box.height / 2);
    await expect.poll(() => frame(page)).toBe(frameAtPx(box.width / 4, { width: box.width, total }));
    await page.evaluate(() => {
      const player = window.__potonginEditor.player;
      window.__scrubberCalls = [];
      for (const name of ["play", "pause"]) {
        const original = player[name];
        player[name] = (...args) => { window.__scrubberCalls.push(name); return original(...args); };
      }
    });
    await slider(page).focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("k");
    expect(await page.evaluate(() => window.__scrubberCalls)).toEqual(["play", "pause"]);
    await expect(slider(page)).toBeFocused();
    expect(errors).toEqual([]);
  });

  test("the legend and the note for the analysis the job lacks", async ({ page }) => {
    await openCepat(page);
    await expect(page.locator("[data-scrubber-legend]")).toHaveText(/Tawa\s*Jeda\s*Cold open/);
    await expect(page.locator("[data-scrubber-note]")).toHaveText(unavailableNote(unavailableKinds(fakeWords())));
    await expect(page.locator("[data-scrubber-mark]")).toHaveCount(0);
  });
});
