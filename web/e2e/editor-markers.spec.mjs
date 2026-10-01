// Waveform, markers and cold-open suggestions (plan §11.3 T3.7, §7.2, Appendix C.3).
//
// The real Timeline (every lane of timeline/lanes.mjs) and the real Cold open panel run in a
// self-contained harness page (no Next server, no login): transcript/__dev__/bundle.mjs compiles
// timeline/lanes/__dev__/markers-harness.jsx with Next's SWC binding, over a store that applies
// the real Appendix B commands. The page asks the real URLs for the peaks and the cold-open
// suggestions; this spec answers them from the committed fixtures (or from a prepared real clip).
//
//   E2E_ALLOW_SKIP=1 E2E_NO_WEB_SERVER=1 npx playwright test e2e/editor-markers.spec.mjs \
//     --project=desktop-chromium
//
// Browser: Chrome for Testing 147.0.7727.15 (Playwright build 1217) when installed;
// PARITY_CHROME overrides it. T37_EVIDENCE_DIR receives the gate numbers (marker positions,
// scripted QG-UX U3). T37_REAL_DATA (a directory written by scripts/editor/t37_gates.py
// `browser-data`) adds the same checks on prepared real clips.
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { HARNESS_HTML, bundleHarness } from "../components/editor/transcript/__dev__/bundle.mjs";
import { caseWords } from "../components/editor/timeline/lanes/__dev__/marker-cases.mjs";

const ORIGIN = "http://editor-markers.test";
const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(WEB, "..");
const ENTRY = path.join(WEB, "components", "editor", "timeline", "lanes", "__dev__", "markers-harness.jsx");
const FIXTURES = path.join(REPO, "tests", "fixtures", "edit_v2");
const evidenceDir = process.env.T37_EVIDENCE_DIR || "";
const realDataDir = process.env.T37_REAL_DATA || "";

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const vectors = readJson(path.join(FIXTURES, "marker-vectors.json"));
const coldopenVectors = readJson(path.join(FIXTURES, "coldopen-vectors.json"));
const contextWords = (id) => readJson(path.join(FIXTURES, "docs", "contexts", `${id}.words.json`));
const contextSeed = (id) => readJson(path.join(FIXTURES, "docs", "contexts", `${id}.seed.json`));

function pinnedChrome() {
  const candidate = path.join(os.homedir(), ".cache", "ms-playwright", "chromium-1217", "chrome-linux64", "chrome");
  return existsSync(candidate) ? candidate : undefined;
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

const chrome = process.env.PARITY_CHROME || pinnedChrome();
const AXE = axeSource();
test.use({ launchOptions: chrome ? { executablePath: chrome } : {}, viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 });

let bundle = null;
test.beforeAll(async () => {
  bundle = await bundleHarness({ entry: ENTRY });
});

/** Peaks bytes for a words artifact: a loud band inside every word, near silence elsewhere. */
function peaksFor(words) {
  const [a, b] = words.window_ms;
  const bins = Math.ceil(((b - a) * 100) / 1000);
  const bytes = Buffer.alloc(bins * 2);
  for (let i = 0; i < bins; i += 1) {
    bytes.writeInt8(-3, 2 * i);
    bytes.writeInt8(3, 2 * i + 1);
  }
  words.words.forEach((word, index) => {
    const level = 40 + (index % 5) * 15;
    for (let bin = Math.max(0, Math.floor((word.s - a) / 10)); bin < Math.min(bins, Math.ceil((word.e - a) / 10)); bin += 1) {
      bytes.writeInt8(-level, 2 * bin);
      bytes.writeInt8(level, 2 * bin + 1);
    }
  });
  return bytes;
}

function writeEvidence(name, value) {
  if (!evidenceDir) return;
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(path.join(evidenceDir, name), `${JSON.stringify(value, null, 2)}\n`);
}

function environment(browser) {
  let commit = null;
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    commit = null;
  }
  return {
    browser: browser.browserType().name(), browserVersion: browser.version(),
    executable: chrome ? "chromium-1217 (Chrome for Testing)" : "playwright default",
    machine: { cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model ?? null, loadavg: os.loadavg().map((value) => Number(value.toFixed(2))) },
    commit, harness: "web/components/editor/timeline/lanes/__dev__ (production React, real commands)",
  };
}

/**
 * Open the harness on `{words, doc}`. `suggestions` answers the cold-open route: an object
 * `{status, body, delayMs}` or a function(request count) → such an object. `peaks`: a Buffer,
 * `{status}` for a failure, or a function(request count) → either.
 */
async function openHarness(page, { words, doc, readOnly = false, suggestions = null, peaks = undefined } = {}) {
  const requests = [];
  let suggestionCalls = 0;
  let peakCalls = 0;
  const peakAnswer = () => {
    peakCalls += 1;
    if (peaks === undefined) return peaksFor(words);
    return typeof peaks === "function" ? peaks(peakCalls) : peaks;
  };
  await page.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname);
    if (url.pathname === "/") return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: HARNESS_HTML });
    if (url.pathname === "/harness.js") return route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: bundle });
    if (url.pathname.endsWith("/coldopen-suggestions")) {
      suggestionCalls += 1;
      const answer = typeof suggestions === "function" ? suggestions(suggestionCalls)
        : suggestions ?? { status: 200, body: { wordsSha256: doc.base.words.sha256, candidates: [] } };
      if (answer.delayMs) await new Promise((resolve) => { setTimeout(resolve, answer.delayMs); });
      return route.fulfill({ status: answer.status, contentType: "application/json", body: JSON.stringify(answer.body) });
    }
    if (url.pathname.includes("/media/peaks/")) {
      const answer = peakAnswer();
      if (Buffer.isBuffer(answer)) return route.fulfill({ status: 200, contentType: "application/octet-stream", body: answer });
      return route.fulfill({ status: answer.status, contentType: "application/json", body: "{}" });
    }
    return route.fulfill({ status: 404, body: "" });
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !/Failed to load resource/.test(message.text())) errors.push(message.text());
  });
  await page.addInitScript((value) => { window.__HARNESS_CONFIG__ = value; }, { words, doc, readOnly });
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => window.__harness?.ready === true);
  return { errors, requests, suggestionCalls: () => suggestionCalls };
}

const markerLane = (page) => page.locator('[data-lane="markers"]');
const audioLane = (page) => page.locator('[data-lane="audio"]');
const panel = (page) => page.locator('[data-panel="coldopen"]');
const suggestionItems = (page) => panel(page).locator("[data-coldopen-suggestion]");

async function domMarkers(page) {
  return page.locator("[data-event-marker]").evaluateAll((nodes) => nodes.map((node) => ({
    kind: node.dataset.kind, src: node.dataset.src, seg: node.dataset.seg,
    f0: Number(node.dataset.f0), f1: Number(node.dataset.f1), left: parseFloat(node.style.left),
  })));
}

async function pxPerFrame(page) {
  return Number(await page.locator("[data-px-per-frame]").getAttribute("data-px-per-frame"));
}

function caseData(kase) {
  return { words: caseWords(contextWords(kase.context), kase), doc: kase.doc };
}

// --- markers ----------------------------------------------------------------------------------

test.describe("marker lane", () => {
  test("every marker sits on the exact frame of the vectors (0 frames) and at frame × zoom", async ({ page, browser }) => {
    let compared = 0;
    let mismatches = 0;
    const perCase = [];
    for (const kase of vectors.cases) {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      const { errors } = await openHarness(page, caseData(kase));
      await expect(markerLane(page)).toHaveAttribute("data-markers-state", /ready|empty/);
      const got = await domMarkers(page);
      const px = await pxPerFrame(page);
      const want = kase.markers.map(({ kind, src, seg, f0, f1 }) => ({ kind, src, seg, f0, f1 }));
      const plain = got.map(({ kind, src, seg, f0, f1 }) => ({ kind, src, seg, f0, f1 }));
      const sortKey = (m) => `${String(m.f0).padStart(8, "0")}|${m.kind}|${m.src}|${m.seg}|${m.f1}`;
      expect(plain.map(sortKey).sort(), kase.name).toEqual(want.map(sortKey).sort());
      for (const marker of got) {
        if (Math.abs(marker.left - marker.f0 * px) > 0.01) mismatches += 1;
      }
      compared += want.length;
      perCase.push({ name: kase.name, markers: want.length });
      expect(errors, kase.name).toEqual([]);
    }
    expect(mismatches).toBe(0);
    writeEvidence("T3.7-markers-browser.json", {
      gate: "marker positions exact (browser lane vs Python vectors)", threshold_frames: 0,
      cases: perCase.length, markers_compared: compared, frame_mismatches: 0, position_mismatches: mismatches,
      pass: mismatches === 0, per_case: perCase, ...environment(browser),
    });
  });

  test("click and keyboard seek to a marker; the tip names the source", async ({ page }) => {
    const kase = vectors.cases.find((item) => item.name === "c30/seed");
    await openHarness(page, caseData(kase));
    const tag = page.locator('[data-event-marker][data-src="yt-caption"]').first();
    const f0 = Number(await tag.getAttribute("data-f0"));
    await tag.click();
    expect(await page.evaluate(() => window.__harness.player.log.filter((entry) => entry.op === "seek").at(-1).frame)).toBe(f0);
    await expect(page.locator("[data-marker-tip]")).toContainText("tag caption YouTube");
    await expect(tag).toHaveAttribute("aria-label", /^Tawa, dari tag caption YouTube, di \d\d:\d\d,\d$/);

    const markers = page.locator("[data-event-marker]");
    await markers.first().focus();
    await expect(markers.first()).toHaveAttribute("tabindex", "0");
    await page.keyboard.press("ArrowRight");
    await expect(markers.nth(1)).toBeFocused();
    await expect(markers.nth(1)).toHaveAttribute("tabindex", "0");
    await expect(markers.first()).toHaveAttribute("tabindex", "-1");
    await page.keyboard.press("End");
    await expect(markers.last()).toBeFocused();
    await page.keyboard.press("Home");
    await expect(markers.first()).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    const second = Number(await markers.nth(1).getAttribute("data-f0"));
    expect(await page.evaluate(() => window.__harness.player.log.filter((entry) => entry.op === "seek").at(-1).frame)).toBe(second);
    await expect(page.locator("[data-marker-tip]")).toBeVisible();
  });

  test("a job without caption tags says so and still marks laughter from the transcript", async ({ page }) => {
    const kase = vectors.cases.find((item) => item.name === "c25/seed");
    await openHarness(page, caseData(kase));
    await expect(markerLane(page).locator("[data-markers-note]"))
      .toHaveText("Tag tawa dari caption tidak tersedia untuk job ini. Tawa di transkrip tetap ditandai.");
    await expect(page.locator('[data-event-marker][data-src="transcript"]')).toHaveCount(
      kase.markers.filter((marker) => marker.src === "transcript").length);
    await expect(page.locator('[data-event-marker][data-src="yt-caption"]')).toHaveCount(0);
  });

  test("a job without the audio timeline or caption tags names both", async ({ page }) => {
    const kase = vectors.cases.find((item) => item.strip.length === 2);
    await openHarness(page, caseData(kase));
    await expect(markerLane(page).locator("[data-markers-note]")).toHaveText(
      "Jeda, potongan kamera, dan tag tawa dari caption tidak tersedia untuk job ini. Tawa di transkrip tetap ditandai.");
    await expect(page.locator('[data-event-marker][data-kind="silence"]')).toHaveCount(0);
    await expect(page.locator('[data-event-marker][data-kind="camera_cut"]')).toHaveCount(0);
  });

  test("markers follow an edit at once (local time map)", async ({ page }) => {
    const kase = vectors.cases.find((item) => item.name === "c30/seed");
    const cut = vectors.cases.find((item) => item.name === "c30/cuts");
    await openHarness(page, caseData(kase));
    await expect(page.locator("[data-event-marker]")).toHaveCount(kase.markers.length);
    await page.evaluate((doc) => window.__harness.store.replace(doc), cut.doc);
    await expect(page.locator("[data-event-marker]")).toHaveCount(cut.markers.length);
  });
});

// --- waveform ---------------------------------------------------------------------------------

test.describe("audio lane", () => {
  test("the speech waveform is laid out per piece and a click seeks", async ({ page }) => {
    const kase = vectors.cases.find((item) => item.name === "c30/cuts");
    const { errors, requests } = await openHarness(page, caseData(kase));
    await expect(audioLane(page)).toHaveAttribute("data-waveform-state", "ready");
    const pieces = await page.evaluate(() => window.__harness.store.getState().plan.pieces);
    const shapes = await audioLane(page).locator("path[data-piece]").evaluateAll((nodes) => nodes.map((node) => ({
      f0: Number(node.dataset.f0), f1: Number(node.dataset.f1), role: node.dataset.role,
    })));
    expect(shapes).toEqual(pieces.map((piece) => ({ f0: piece.outF0, f1: piece.outF0 + piece.frames, role: piece.role })));
    expect(requests.filter((item) => item.includes("/media/peaks/"))).toHaveLength(1);
    const box = await audioLane(page).boundingBox();
    const px = await pxPerFrame(page);
    await page.mouse.click(box.x + 200.5, box.y + box.height / 2);
    const seek = await page.evaluate(() => window.__harness.player.log.filter((entry) => entry.op === "seek").at(-1).frame);
    expect(seek).toBe(Math.floor(200.5 / px));
    expect(errors).toEqual([]);
  });

  test("a failed peaks load says so and retries", async ({ page }) => {
    const kase = vectors.cases.find((item) => item.name === "c24/seed");
    const data = caseData(kase);
    await openHarness(page, { ...data, peaks: (count) => (count === 1 ? { status: 500 } : peaksFor(data.words)) });
    await expect(audioLane(page)).toHaveAttribute("data-waveform-state", "error");
    await expect(audioLane(page)).toContainText("Waveform tidak bisa dimuat");
    await audioLane(page).getByRole("button", { name: "Muat ulang waveform" }).click();
    await expect(audioLane(page)).toHaveAttribute("data-waveform-state", "ready");
  });

  test("a source without audio shows no waveform, with the reason", async ({ page }) => {
    const kase = vectors.cases.find((item) => item.name === "c24/seed");
    const data = caseData(kase);
    const doc = structuredClone(data.doc);
    doc.base.source.has_audio = false;
    const { requests } = await openHarness(page, { ...data, doc });
    await expect(audioLane(page)).toHaveAttribute("data-waveform-state", "silent");
    await expect(audioLane(page)).toContainText("Video sumber tanpa suara");
    expect(requests.filter((item) => item.includes("/media/peaks/"))).toHaveLength(0);
  });
});

// --- cold-open suggestions --------------------------------------------------------------------

function suggestionsFor(contextId) {
  const entry = coldopenVectors.contexts[contextId];
  return { status: 200, body: { wordsSha256: entry.wordsSha256, candidates: entry.candidates } };
}

test.describe("cold-open suggestions", () => {
  test("the list shows every candidate with its label, the current one marked", async ({ page }) => {
    const words = contextWords("c30");
    const doc = contextSeed("c30");
    const { errors } = await openHarness(page, { words, doc, suggestions: suggestionsFor("c30") });
    const expected = coldopenVectors.contexts.c30.candidates;
    await expect(suggestionItems(page)).toHaveCount(expected.length);
    await expect(suggestionItems(page).first()).toHaveAttribute("data-current", "true");
    await expect(suggestionItems(page).first().getByRole("button", { name: /Pakai saran 1/ })).toBeDisabled();
    for (const [index, candidate] of expected.entries()) {
      const item = suggestionItems(page).nth(index);
      await expect(item).toHaveAttribute("data-source", candidate.source);
      await expect(item.locator("[data-suggestion-text]")).toHaveText(`“${candidate.text}”`);
    }
    // the T2.7 controls are untouched
    await expect(panel(page).locator("[data-coldopen-line]")).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test("Putar auditions the candidate where the clip shows it; Pakai replaces the cold open", async ({ page }) => {
    const words = contextWords("c30");
    const doc = contextSeed("c30");
    await openHarness(page, { words, doc, suggestions: suggestionsFor("c30") });
    const candidate = coldopenVectors.contexts.c30.candidates[1];
    const item = suggestionItems(page).nth(1);
    await item.getByRole("button", { name: "Putar saran 2" }).click();
    await expect.poll(() => page.evaluate(() => window.__harness.player.log.map((entry) => entry.op).join(","))).toMatch(/seek,play.*pause/);
    const log = await page.evaluate(() => window.__harness.player.log);
    const seek = log.find((entry) => entry.op === "seek");
    const pause = log.findLast((entry) => entry.op === "pause");
    const audition = await item.getAttribute("data-audition");
    const [f0, f1] = audition.split("-").map(Number);
    expect(seek.frame).toBe(f0);
    expect(pause.frame).toBeGreaterThanOrEqual(f1 - 1);
    expect(pause.frame).toBeLessThanOrEqual(f1 + 2);
    await item.getByRole("button", { name: "Pakai saran 2 sebagai cold open" }).click();
    const last = await page.evaluate(() => window.__harness.store.log.at(-1));
    expect(last).toEqual({ type: "SetColdOpen", args: { firstWord: candidate.firstWord, lastWord: candidate.lastWord }, mergeKey: null, ok: true });
    await expect(item).toHaveAttribute("data-current", "true");
    await expect(suggestionItems(page).first()).toHaveAttribute("data-current", "false");
    await expect(panel(page).locator("[data-coldopen-line]")).toHaveText(`“${candidate.text}”`);
    const co = await page.evaluate(() => window.__harness.store.getState().doc.main.segments[0]);
    expect([co.role, co.in_sf, co.out_sf]).toEqual(["cold_open", candidate.inSf, candidate.outSf]);
  });

  test("a candidate the current clip can no longer use is disabled with its reason", async ({ page }) => {
    const words = contextWords("c25");
    const seed = contextSeed("c25");
    const candidate = coldopenVectors.contexts.c25.candidates.find((item) => item.source === "strong");
    await openHarness(page, { words, doc: seed, suggestions: suggestionsFor("c25") });
    await page.evaluate((gapWord) => window.__harness.store.dispatch("TrimStart", { gapWord }), candidate.firstWord);
    const item = suggestionItems(page).filter({ has: page.locator(`[data-suggestion-text]`, { hasText: candidate.text }) });
    await expect(item.getByRole("button", { name: /^Pakai saran/ })).toBeDisabled();
    await expect(item.locator("[data-suggestion-reason]")).toHaveText("Cold open ini hanya mengulang awal klip");
  });

  test("loading, empty and error states; a retry recovers", async ({ page }) => {
    const words = contextWords("c24");
    const doc = contextSeed("c24");
    const answers = [
      { status: 503, body: { error: "Layanan editor sedang tidak tersedia", code: "backend_unavailable" }, delayMs: 400 },
      { status: 200, body: { wordsSha256: doc.base.words.sha256, candidates: [] } },
    ];
    const harness = await openHarness(page, { words, doc, suggestions: (count) => answers[Math.min(count, answers.length) - 1] });
    await expect(panel(page).locator("[data-suggestions-state]")).toHaveAttribute("data-suggestions-state", "loading");
    await expect(panel(page).locator("[data-suggestions-state]")).toContainText("Mencari saran cold open");
    await expect(panel(page).locator("[data-suggestions-state]")).toHaveAttribute("data-suggestions-state", "error");
    await expect(panel(page).locator("[data-suggestions-state]")).toContainText("Saran belum bisa dimuat");
    await panel(page).getByRole("button", { name: "Coba lagi" }).click();
    await expect(panel(page).locator("[data-suggestions-state]")).toHaveAttribute("data-suggestions-state", "empty");
    await expect(panel(page).locator("[data-suggestions-state]")).toContainText("Belum ada kalimat di klip ini yang cocok jadi cold open");
    expect(harness.suggestionCalls()).toBe(2);
  });

  test("read-only: suggestions can be heard but not applied", async ({ page }) => {
    await openHarness(page, { words: contextWords("c30"), doc: contextSeed("c30"), readOnly: true, suggestions: suggestionsFor("c30") });
    await expect(suggestionItems(page).nth(1).getByRole("button", { name: /^Pakai saran 2/ })).toBeDisabled();
    await expect(suggestionItems(page).nth(1).getByRole("button", { name: "Putar saran 2" })).toBeEnabled();
  });

  test("axe: no critical or serious violations in the panel and the lanes", async ({ page }) => {
    test.skip(!AXE, "axe-core is not installed; set AXE_CORE_PATH");
    await openHarness(page, { words: contextWords("c30"), doc: contextSeed("c30"), suggestions: suggestionsFor("c30") });
    await expect(suggestionItems(page)).toHaveCount(coldopenVectors.contexts.c30.candidates.length);
    await expect(audioLane(page)).toHaveAttribute("data-waveform-state", "ready");
    await page.addScriptTag({ content: AXE });
    const serious = async () => {
      const result = await page.evaluate(async () => window.axe.run(document, { resultTypes: ["violations"] }));
      return result.violations.filter((violation) => ["critical", "serious"].includes(violation.impact)).map((violation) => violation.id);
    };
    expect(await serious()).toEqual([]);
    await page.locator("[data-event-marker]").first().focus(); // the tip is showing
    await expect(page.locator("[data-marker-tip]")).toBeVisible();
    expect(await serious()).toEqual([]);
    await suggestionItems(page).nth(1).getByRole("button", { name: "Putar saran 2" }).click(); // listening state
    expect(await serious()).toEqual([]);
  });
});

// --- scripted QG-UX U3 with suggestions (≤ 30 s) -----------------------------------------------

// Keystroke-level model (Card, Moran & Newell): M 1.35 s, P 1.1 s, B 0.1 s, K 0.28 s.
function klmSeconds(operators) {
  const time = { M: 1.35, P: 1.1, B: 0.1, K: 0.28 };
  return Number(operators.split(/\s+/).reduce((sum, token) => {
    const match = /^(\d*)([MPBK])$/.exec(token);
    return sum + (match ? Number(match[1] || 1) * time[match[2]] : 0);
  }, 0).toFixed(2));
}

async function scriptedU3(page, { words, doc, suggestions }) {
  await openHarness(page, { words, doc, suggestions });
  const started = Date.now();
  await page.getByRole("tab", { name: "Cold open" }).click();
  await expect(suggestionItems(page).first()).toBeVisible();
  const usable = suggestionItems(page).and(page.locator('[data-current="false"][data-usable="true"]'));
  if (await usable.count() === 0) return null; // only the current cold open is suggested
  const item = usable.first();
  const number = Number(await item.getAttribute("data-number"));
  const text = await item.locator("[data-suggestion-text]").textContent();
  await item.getByRole("button", { name: `Putar saran ${number}` }).click();
  await expect.poll(() => page.evaluate(() => window.__harness.player.log.some((entry) => entry.op === "pause")),
    { timeout: 15_000 }).toBe(true);
  await item.getByRole("button", { name: `Pakai saran ${number} sebagai cold open` }).click();
  await expect(panel(page).locator("[data-coldopen-line]")).toHaveText(text);
  const elapsedMs = Date.now() - started;
  const log = await page.evaluate(() => window.__harness.player.log);
  const auditionS = (log.findLast((entry) => entry.op === "pause").at - log.find((entry) => entry.op === "play").at) / 1000;
  const co = await page.evaluate(() => window.__harness.store.getState().doc.main.segments[0]);
  return { elapsedMs, auditionS, co, fps: doc.output.fps };
}

for (const viewport of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
  test.describe(`scripted QG-UX at ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport });
    test("U3: replace the cold open from a suggestion ≤ 30 s", async ({ page, browser }) => {
      const doc = contextSeed("c30");
      const result = await scriptedU3(page, { words: contextWords("c30"), doc, suggestions: suggestionsFor("c30") });
      expect(result).not.toBeNull();
      const lengthS = ((result.co.out_sf - result.co.in_sf) * result.fps[1]) / result.fps[0];
      expect(result.co.role).toBe("cold_open");
      expect(lengthS).toBeGreaterThanOrEqual(0.5);
      expect(lengthS).toBeLessThanOrEqual(8);
      // open the tab; wait for the list; Putar; listen; Pakai; check the line
      const operators = "M P B B M P B B M P B B M";
      const klm = Number((klmSeconds(operators) + result.auditionS).toFixed(2));
      expect(result.elapsedMs).toBeLessThanOrEqual(30_000);
      expect(klm).toBeLessThanOrEqual(30);
      writeEvidence(`T3.7-QG-UX-U3-${viewport.width}x${viewport.height}.json`, {
        gate: "QG-UX U3 with suggestions (scripted e2e)", task: "replace the cold open from a suggestion", limit_s: 30,
        viewport, elapsed_s: result.elapsedMs / 1000, audition_s: Number(result.auditionS.toFixed(3)),
        cold_open_s: Number(lengthS.toFixed(3)), user_actions: { clicks: 3, keys: 0 }, klm_operators: operators,
        klm_estimate_s: klm, pass: result.elapsedMs <= 30_000 && klm <= 30, ...environment(browser),
      });
    });
  });
}

// --- prepared real clips (optional) -----------------------------------------------------------

const realClips = realDataDir && existsSync(realDataDir)
  ? readdirSync(realDataDir).filter((name) => existsSync(path.join(realDataDir, name, "words.json"))).sort()
  : [];

test.describe("prepared real clips", () => {
  test.skip(realClips.length === 0, "T37_REAL_DATA is not set (scripts/editor/t37_gates.py browser-data)");

  test("markers exact on every real clip and document", async ({ page, browser }) => {
    test.setTimeout(30 * 60_000); // one harness page per clip and document
    let compared = 0;
    const perClip = [];
    for (const name of realClips) {
      const dir = path.join(realDataDir, name);
      const words = readJson(path.join(dir, "words.json"));
      const peaks = readFileSync(path.join(dir, "peaks.bin"));
      for (const kase of readJson(path.join(dir, "markers.json")).cases) {
        await page.unrouteAll({ behavior: "ignoreErrors" });
        await openHarness(page, { words, doc: kase.doc, peaks });
        await expect(markerLane(page)).toHaveAttribute("data-markers-state", /ready|empty/);
        const got = (await domMarkers(page)).map(({ kind, src, seg, f0, f1 }) => `${f0}|${f1}|${kind}|${src}|${seg}`).sort();
        const want = kase.markers.map(({ kind, src, seg, f0, f1 }) => `${f0}|${f1}|${kind}|${src}|${seg}`).sort();
        expect(got, `${name} ${kase.name}`).toEqual(want);
        await expect(audioLane(page)).toHaveAttribute("data-waveform-state", "ready");
        compared += want.length;
        perClip.push({ clip: name, doc: kase.name, markers: want.length });
      }
    }
    writeEvidence("T3.7-markers-browser-real.json", {
      gate: "marker positions exact on prepared real clips (browser lane vs Python)", threshold_frames: 0,
      clips: realClips.length, documents: perClip.length, markers_compared: compared, frame_mismatches: 0, pass: true,
      per_document: perClip, ...environment(browser),
    });
  });

  test("U3 with suggestions ≤ 30 s on every real clip", async ({ page, browser }) => {
    test.setTimeout(30 * 60_000); // one scripted run per clip
    const runs = [];
    for (const name of realClips) {
      const dir = path.join(realDataDir, name);
      const words = readJson(path.join(dir, "words.json"));
      const doc = readJson(path.join(dir, "seed.json"));
      const candidates = readJson(path.join(dir, "candidates.json"));
      const usable = candidates.candidates.length > 0;
      if (!usable) {
        runs.push({ clip: name, skipped: "no candidates" });
        continue;
      }
      await page.unrouteAll({ behavior: "ignoreErrors" });
      const result = await scriptedU3(page, { words, doc, suggestions: { status: 200, body: candidates } });
      if (!result) {
        runs.push({ clip: name, skipped: "only the current cold open is suggested" });
        continue;
      }
      const operators = "M P B B M P B B M P B B M";
      const klm = Number((klmSeconds(operators) + result.auditionS).toFixed(2));
      expect(result.elapsedMs).toBeLessThanOrEqual(30_000);
      expect(klm).toBeLessThanOrEqual(30);
      runs.push({ clip: name, elapsed_s: result.elapsedMs / 1000, audition_s: Number(result.auditionS.toFixed(3)), klm_estimate_s: klm });
    }
    // A clip without another usable suggestion cannot run U3; the gate never passes on skips alone.
    const ran = runs.filter((run) => !run.skipped);
    expect(ran.length, "at least one real clip runs U3").toBeGreaterThan(0);
    const skipped = Object.entries(Object.groupBy(runs.filter((run) => run.skipped), (run) => run.skipped))
      .map(([reason, list]) => ({ reason, clips: list.length }));
    writeEvidence("T3.7-QG-UX-U3-real.json", {
      gate: "QG-UX U3 with suggestions on prepared real clips (scripted e2e)", limit_s: 30,
      clips: runs.length, ran: ran.length, skipped,
      max_elapsed_s: Math.max(...ran.map((run) => run.elapsed_s)), max_klm_estimate_s: Math.max(...ran.map((run) => run.klm_estimate_s)),
      runs, pass: ran.every((run) => run.elapsed_s <= 30 && run.klm_estimate_s <= 30), ...environment(browser),
    });
  });
});
