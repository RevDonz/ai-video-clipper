// The caption gizmo on the 9:16 stage (CONTRACTS §5.47): the editor shell (EditorApp) on the real
// store and the real commands over the fakes, in the self-contained harness page of the logo spec
// (gizmos/__dev__/logo-harness-entry.jsx, no Next server, no login). A drag up or down with the
// magnet on Atas, Tengah and Bawah, Alt without it, the 20–92 % range, pointer capture, Escape, one
// undo step per drag, the Teks slider and the Caption card in step, the keys, read-only, captions
// off, reduced motion and axe.
//
//   E2E_ALLOW_SKIP=1 E2E_NO_WEB_SERVER=1 npx playwright test e2e/editor-caption-gizmo.spec.mjs \
//     --project=desktop-chromium
//
// In CI: gh workflow run editor-gates.yml -f ref=<branch> -f suite=e2e -f command=e2e/editor-caption-gizmo.spec.mjs
// Optional: AXE_CORE_PATH=<axe.min.js> (QG-A11Y).
import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { HARNESS_HTML, bundleHarness } from "../components/editor/transcript/__dev__/bundle.mjs";
import { openCard } from "./support/editor-cards.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENTRY = path.join(repoRoot, "web", "components", "editor", "gizmos", "__dev__", "logo-harness-entry.jsx");
const ORIGIN = "http://editor-caption.test";
const OUT_H = 1280; // the fakes' output is 720×1280

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
test.use({
  launchOptions: { ...(chrome ? { executablePath: chrome } : {}), args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] },
  viewport: { width: 1366, height: 768 },
  deviceScaleFactor: 1,
});

// --- the harness page ------------------------------------------------------------------------------

let bundle = null;
async function harnessBundle() {
  bundle ??= await bundleHarness({ entry: ENTRY });
  return bundle;
}

async function openHarness(page, config = {}, url = `${ORIGIN}/`) {
  const script = await harnessBundle();
  await page.route(`${ORIGIN}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/") return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: HARNESS_HTML });
    if (pathname === "/harness.js") return route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: script });
    return route.fulfill({ status: 404, body: "" });
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !/Failed to load resource/.test(message.text())) errors.push(message.text());
  });
  await page.addInitScript((value) => { window.__HARNESS_CONFIG__ = value; }, { panel: "text", ...config });
  await page.goto(url);
  await page.waitForFunction(() => window.__harness?.ready === true);
  await expect(page.locator('[data-editor-ready="true"]')).toBeVisible();
  await expect(captionBox(page)).toBeVisible();
  return errors;
}

const captionBox = (page) => page.locator("[data-gizmo='caption'] [data-caption-box]");
const gizmo = (page) => page.locator("[data-gizmo='caption']");
const stageCanvas = (page) => page.locator('[data-stage="canvas"]');
const textPanel = (page) => page.locator('[data-panel="text"]');
const positionSlider = (page) => textPanel(page).getByRole("slider", { name: "Posisi caption" });

async function snapshot(page) {
  return page.evaluate(() => {
    const state = window.__harness.store.getState();
    const mine = window.__harness.log.filter((entry) => entry.type === "SetCaptionOverride" && entry.args.key === "y_e5");
    return {
      y: state.doc.captions.overrides.y_e5,
      canUndo: state.canUndo,
      commands: mine.filter((entry) => entry.ok).map((entry) => ({ value: entry.args.value, mergeKey: entry.mergeKey })),
      rejected: window.__harness.log.filter((entry) => !entry.ok).map((entry) => ({ type: entry.type, code: entry.code })),
    };
  });
}

const yOf = async (page) => (await snapshot(page)).y;

/** The box's bottom edge and sides in output pixels, measured on the screen. */
async function screenBox(page) {
  const stage = await stageCanvas(page).boundingBox();
  const box = await captionBox(page).boundingBox();
  const scale = OUT_H / stage.height;
  return {
    x: Math.round((box.x - stage.x) * scale), w: Math.round(box.width * scale),
    bottom: Math.round((box.y + box.height - stage.y) * scale),
  };
}

/** captions_ass._margin_v: the bottom of a caption at y_e5 in a 1280 px high frame. */
const bottomOf = (yE5) => OUT_H - Math.floor((2 * (100000 - yE5) * OUT_H + 100000) / 200000);

/**
 * Presses the middle of the box and moves the pointer so the bottom would land on `targetE5`,
 * in steps; `release: false` keeps the button down. `x` moves the pointer sideways too (output px).
 */
async function dragTo(page, targetE5, { alt = false, release = true, steps = 8, x = 0 } = {}) {
  const stage = await stageCanvas(page).boundingBox();
  const scale = stage.height / OUT_H;
  const from = await yOf(page);
  const box = await captionBox(page).boundingBox();
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  if (alt) await page.keyboard.down("Alt");
  await page.mouse.down();
  await page.mouse.move(start.x + x * scale, start.y + ((targetE5 - from) * OUT_H * scale) / 100000, { steps });
  if (release) {
    await page.mouse.up();
    if (alt) await page.keyboard.up("Alt");
  }
}

test.describe("caption gizmo (harness)", () => {
  test("the box sits on the caption's bottom at the seed spot (Bawah), with nothing drawn until hover", async ({ page }) => {
    const errors = await openHarness(page);
    const box = captionBox(page);
    await expect(box).toHaveAttribute("role", "slider");
    await expect(page.getByRole("slider", { name: "Caption di video" })).toHaveCount(1);
    await expect(box).toHaveAttribute("aria-orientation", "vertical");
    await expect(box).toHaveAttribute("aria-valuemin", "20");
    await expect(box).toHaveAttribute("aria-valuemax", "92");
    await expect(box).toHaveAttribute("aria-valuenow", "83");
    await expect(box).toHaveAttribute("aria-valuetext", "83% dari atas, Bawah");
    const seen = await screenBox(page);
    expect(Math.abs(seen.bottom - bottomOf(83000))).toBeLessThanOrEqual(1);
    expect(Math.abs(seen.x - 43)).toBeLessThanOrEqual(1);
    expect(Math.abs(seen.w - 634)).toBeLessThanOrEqual(1);
    // At rest the video is not covered by an outline; hovering shows it.
    const outline = () => box.evaluate((element) => getComputedStyle(element).outlineColor);
    expect(await outline()).toBe("rgba(0, 0, 0, 0)");
    await box.hover();
    await expect.poll(outline).not.toBe("rgba(0, 0, 0, 0)");
    await expect(gizmo(page)).toHaveAttribute("data-dragging", "false");
    expect(errors).toEqual([]);
  });

  test("a drag snaps to Tengah, shows the guides while it moves and stores one command on release; one undo step", async ({ page }) => {
    const errors = await openHarness(page);
    await dragTo(page, 60800, { release: false });
    // While it moves: guides for the three presets, the magnet on Tengah, the read-out; nothing stored.
    await expect(gizmo(page)).toHaveAttribute("data-dragging", "true");
    for (const id of ["atas", "tengah", "bawah"]) await expect(gizmo(page).locator(`[data-guide="${id}"]`)).toHaveCount(1);
    await expect(gizmo(page).locator('[data-guide="tengah"]')).toHaveAttribute("data-snapped", "true");
    await expect(gizmo(page).locator('[data-guide="bawah"]')).toHaveAttribute("data-snapped", "false");
    await expect(gizmo(page).locator("[data-caption-readout]")).toHaveText("60% dari atas · Tengah");
    await expect(captionBox(page)).toHaveAttribute("data-y-e5", "60000");
    let state = await snapshot(page);
    expect(state.y).toBe(83000);
    expect(state.commands).toEqual([]);
    await page.mouse.up();
    await expect(gizmo(page)).toHaveAttribute("data-dragging", "false");
    await expect(gizmo(page).locator("[data-guide]")).toHaveCount(0);
    state = await snapshot(page);
    expect(state.y).toBe(60000);
    expect(state.commands).toEqual([{ value: 60000, mergeKey: null }]);
    // The Teks slider follows, and the gizmo names its spot.
    await expect(positionSlider(page)).toHaveValue("60000");
    await expect(textPanel(page).getByText("60% dari atas", { exact: true })).toBeVisible();
    await expect(captionBox(page)).toHaveAttribute("aria-valuetext", "60% dari atas, Tengah");
    expect(Math.abs((await screenBox(page)).bottom - bottomOf(60000))).toBeLessThanOrEqual(1);
    // One drag is one undo step, and redo brings it back.
    await page.keyboard.press("Control+z");
    await expect.poll(() => yOf(page)).toBe(83000);
    await page.keyboard.press("Control+Shift+z");
    await expect.poll(() => yOf(page)).toBe(60000);
    expect(errors).toEqual([]);
  });

  test("Alt drags off the magnet; the range stops the drag at 20 % and 92 %, also with the pointer off the stage", async ({ page }) => {
    const errors = await openHarness(page);
    await dragTo(page, 60800, { alt: true });
    await expect.poll(() => yOf(page)).toBe(61000);
    // Far up, with the pointer leaving the stage sideways: the captured pointer still drives it.
    await dragTo(page, 10000, { x: -420 });
    await expect.poll(() => yOf(page)).toBe(20000);
    await expect(captionBox(page)).toHaveAttribute("aria-valuetext", "20% dari atas");
    await dragTo(page, 100000);
    await expect.poll(() => yOf(page)).toBe(92000);
    const state = await snapshot(page);
    expect(state.commands).toEqual([{ value: 61000, mergeKey: null }, { value: 20000, mergeKey: null }, { value: 92000, mergeKey: null }]);
    expect(state.rejected).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("Escape during a drag puts the box back and stores nothing; a click alone stores nothing", async ({ page }) => {
    await openHarness(page);
    await dragTo(page, 50000, { release: false });
    await expect(gizmo(page)).toHaveAttribute("data-dragging", "true");
    await page.keyboard.press("Escape");
    await expect(gizmo(page)).toHaveAttribute("data-dragging", "false");
    await expect(captionBox(page)).toHaveAttribute("data-y-e5", "83000");
    await page.mouse.up();
    await captionBox(page).click();
    const state = await snapshot(page);
    expect(state.y).toBe(83000);
    expect(state.commands).toEqual([]);
  });

  test("the Teks slider moves the box, and Tengah from the slider keys lands on the guide line", async ({ page }) => {
    await openHarness(page);
    await positionSlider(page).focus();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect.poll(() => yOf(page)).toBe(82000);
    await expect(captionBox(page)).toHaveAttribute("aria-valuenow", "82");
    await expect(captionBox(page)).toHaveAttribute("data-y-e5", "82000");
    expect(Math.abs((await screenBox(page)).bottom - bottomOf(82000))).toBeLessThanOrEqual(1);
  });

  test("keys: a visible focus ring, arrows 0.5 %, Shift 5 %, Home and End; the read-out follows; Escape leaves", async ({ page }) => {
    const errors = await openHarness(page);
    await page.keyboard.press("Tab"); // keyboard modality, so :focus-visible applies
    const box = captionBox(page);
    await box.focus();
    await expect(box).toBeFocused();
    expect(await box.evaluate((element) => element.matches(":focus-visible") && getComputedStyle(element).outlineStyle)).toBe("solid");
    await page.keyboard.press("ArrowUp");
    await expect.poll(() => yOf(page)).toBe(82500);
    await expect(gizmo(page).locator("[data-caption-readout]")).toHaveText("83% dari atas · area tombol TikTok");
    await page.keyboard.press("Shift+ArrowUp");
    await expect.poll(() => yOf(page)).toBe(77500);
    await expect(gizmo(page).locator("[data-caption-readout]")).toHaveText("78% dari atas");
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => yOf(page)).toBe(78000);
    await page.keyboard.press("Home");
    await expect.poll(() => yOf(page)).toBe(20000);
    await page.keyboard.press("End");
    await expect.poll(() => yOf(page)).toBe(92000);
    // No X axis: left and right move nothing, and the arrows stay with the box (not the playhead).
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowRight");
    const state = await snapshot(page);
    expect(state.y).toBe(92000);
    expect(state.commands.every((entry) => entry.mergeKey === "cap:y_e5")).toBe(true);
    expect(state.commands.map((entry) => entry.value)).toEqual([82500, 77500, 78000, 20000, 92000]);
    await page.keyboard.press("Escape");
    await expect(box).not.toBeFocused();
    await expect(gizmo(page).locator("[data-caption-readout]")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("captions off hide the gizmo; read-only shows it but nothing moves", async ({ page }) => {
    await openHarness(page);
    await textPanel(page).getByRole("switch", { name: "Tampilkan caption" }).click();
    await expect(gizmo(page)).toHaveCount(0);
    await textPanel(page).getByRole("switch", { name: "Tampilkan caption" }).click();
    await expect(captionBox(page)).toBeVisible();

    const other = await page.context().newPage();
    await openHarness(other, { readOnly: true });
    await expect(other.locator('[data-editor-status="readOnly"]')).toBeVisible();
    await expect(captionBox(other)).toHaveAttribute("aria-disabled", "true");
    await dragTo(other, 50000);
    await captionBox(other).focus();
    await other.keyboard.press("ArrowUp");
    const state = await snapshot(other);
    expect(state.y).toBe(83000);
    expect(state.commands).toEqual([]);
    await other.close();
  });

  test("Mode Cepat: a drag to Atas presses the Caption card's Atas pill", async ({ page }) => {
    const errors = await openHarness(page, {}, `${ORIGIN}/?mode=cepat`);
    const card = await openCard(page, "caption");
    const positions = card.getByRole("radiogroup", { name: "Posisi" });
    await expect(positions.getByRole("radio", { name: "Bawah" })).toBeChecked();
    await dragTo(page, 38400);
    await expect.poll(() => yOf(page)).toBe(38000);
    await expect(positions.getByRole("radio", { name: "Atas" })).toBeChecked();
    expect((await snapshot(page)).commands).toEqual([{ value: 38000, mergeKey: null }]);
    expect(errors).toEqual([]);
  });

  test("reduced motion: the box and its edge do not animate", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openHarness(page);
    const durations = await captionBox(page).evaluate((element) => [
      getComputedStyle(element).transitionDuration, getComputedStyle(element, "::after").transitionDuration]);
    for (const value of durations) expect(value.split(",").every((part) => Number.parseFloat(part) === 0)).toBe(true);
  });

  test("QG-A11Y: axe finds no critical or serious violation with the box at rest, focused and moved by keys", async ({ page }) => {
    test.skip(!AXE, "AXE_CORE_PATH=<axe.min.js> is required (axe-core is not a dependency)");
    const results = [];
    const run = async (label) => {
      await page.addScriptTag({ content: AXE });
      const outcome = await page.evaluate(async () => {
        const found = await window.axe.run(document, { resultTypes: ["violations"] });
        return found.violations.map((violation) => ({ id: violation.id, impact: violation.impact, nodes: violation.nodes.length }));
      });
      results.push({ state: label, violations: outcome });
    };
    await openHarness(page);
    await run("at rest");
    await captionBox(page).focus();
    await page.keyboard.press("ArrowUp");
    await expect(gizmo(page).locator("[data-caption-readout]")).toBeVisible();
    await run("focused, read-out shown");
    const serious = results.flatMap((entry) => entry.violations.filter((violation) => ["critical", "serious"].includes(violation.impact))
      .map((violation) => ({ state: entry.state, ...violation })));
    expect(serious).toEqual([]);
  });
});
