// Logo and watermark (plan §11.3 T3.2, §5.5, §3.3 logo item, Appendix B logo commands, §5.9 G5,
// §10.1 P-LOGO, §10.2 QG-UX U5). Two parts:
//
// 1. The editor shell (EditorApp) on the real store and the real commands over the fakes, in a
//    self-contained harness page (no Next server, no login): gizmos/__dev__/logo-harness-entry.jsx
//    bundled by transcript/__dev__/bundle.mjs. Upload → place → size → opacity → remove, the drag
//    magnet (corner margins, TikTok zone edges), keyboard nudges, the aspect-locked handles, the
//    item_out_of_frame guard, the G5 warning, the upload error states, read-only, axe and the
//    scripted U5 (logo part).
//
//      E2E_ALLOW_SKIP=1 E2E_NO_WEB_SERVER=1 npx playwright test e2e/editor-logo.spec.mjs \
//        --project=desktop-chromium --grep-invert "real stack"
//
//    Optional: AXE_CORE_PATH=<axe.min.js> (QG-A11Y), LOGO_EVIDENCE_DIR=<dir> (U5 numbers).
//
// 2. "real stack": the captures behind P-LOGO at the output size and through truth frames. A
//    private server (never :3000/:3001) with POTONGIN_EDITOR_V3=on and a JOBS_ROOT holding a copy
//    of a real V3 job; synthetic logos go into that copy's asset store
//    (scripts/parity/logo_gates.py assets); each case is saved as a document (PUT, the same
//    commands the panel sends), opened in the real editor (real player, real preview lane), and
//    for a few frames the canvas, the truth frames with and without the logo and the document
//    are written to LOGO_CAPTURES. Then, in the toolchain image:
//      scripts/parity/logo_gates.py score --captures <LOGO_CAPTURES> --job-dir <job copy> --out …
//    Needs E2E_LOGO_REAL=1, E2E_BASE_URL, E2E_USERNAME, E2E_PASSWORD, E2E_EDITOR_JOB_ID,
//    E2E_JOBS_ROOT, LOGO_CAPTURES; optional E2E_LOGO_CLIP (clip index, default the first
//    openable one) and LOGO_PYTHON (default python3).
//
// The browser is Chrome for Testing 147.0.7727.15 (Playwright build 1217) when installed;
// PARITY_CHROME overrides it.
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { fakeDoc, fakeSha256, fakeWords } from "../components/editor/__dev__/fakes.mjs";
import { HARNESS_HTML, bundleHarness } from "../components/editor/transcript/__dev__/bundle.mjs";
import { applyCommand } from "../lib/editor/commands.mjs";
import { createContext } from "../lib/editor/doc-model.mjs";
import { login, settings } from "./support/harness.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENTRY = path.join(repoRoot, "web", "components", "editor", "gizmos", "__dev__", "logo-harness-entry.jsx");
const ORIGIN = "http://editor-harness.test";
const evidenceDir = process.env.LOGO_EVIDENCE_DIR || "";
const U5_LOGO_MS = 60_000; // plan §10.2 QG-UX U5 (logo and ducked music ≤ 60 s; the logo part alone here)

function pinnedChrome() {
  const candidate = path.join(os.homedir(), ".cache", "ms-playwright", "chromium-1217", "chrome-linux64", "chrome");
  return existsSync(candidate) ? candidate : undefined;
}

function axeSource() {
  const explicit = process.env.AXE_CORE_PATH;
  return explicit && existsSync(explicit) ? readFileSync(explicit, "utf8") : null;
}

const chrome = process.env.PARITY_CHROME || pinnedChrome();
const AXE = axeSource();
test.use({
  launchOptions: { ...(chrome ? { executablePath: chrome } : {}), args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] },
  viewport: { width: 1366, height: 768 },
  deviceScaleFactor: 1,
});

function writeEvidence(name, value) {
  if (!evidenceDir) return;
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(path.join(evidenceDir, name), `${JSON.stringify(value, null, 2)}\n`);
}

// --- synthetic images (made at run time; no media in git) ------------------------------------------

function chunk(kind, payload) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(kind, "latin1"), payload])) >>> 0);
  return Buffer.concat([length, Buffer.from(kind, "latin1"), payload, crc]);
}

/** An RGBA PNG: a coloured badge with a black and white band at its edge and a transparent hole. */
function badgePng(width, height, hue = 0) {
  const colours = [[228, 78, 63], [63, 94, 251], [223, 255, 88]];
  const [r0, g0, b0] = colours[hue % colours.length];
  const band = Math.max(3, Math.floor(Math.min(width, height) / 8));
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4);
    for (let x = 0; x < width; x += 1) {
      const edge = Math.min(x, y, width - 1 - x, height - 1 - y);
      const cx = (x - width / 2) / (width / 2);
      const cy = (y - height / 2) / (height / 2);
      let pixel;
      if (edge < band) pixel = (Math.floor(x / (band * 2)) + Math.floor(y / (band * 2))) % 2 ? [0, 0, 0, 255] : [255, 255, 255, 255];
      else if (cx * cx + cy * cy < 0.08) pixel = [0, 0, 0, 0];
      else pixel = [r0, Math.floor(g0 * (1 - y / height)), b0, 255];
      row.set(pixel, 1 + x * 4);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

const FILES = {
  square: { name: "logo-kotak.png", mimeType: "image/png", buffer: badgePng(128, 128, 0), size: [512, 512] },
  wide: { name: "logo-lebar.png", mimeType: "image/png", buffer: badgePng(200, 50, 1), size: [1000, 250] },
  gif: { name: "animasi.gif", mimeType: "image/gif", buffer: Buffer.from("GIF89a") },
  huge: { name: "besar.png", mimeType: "image/png", buffer: Buffer.alloc(11 * 1024 * 1024, 1) },
  rejected: { name: "rusak.png", mimeType: "image/png", buffer: Buffer.from("not really a png") },
  network: { name: "putus.png", mimeType: "image/png", buffer: badgePng(64, 64, 2) },
  slow: { name: "lambat.png", mimeType: "image/png", buffer: badgePng(64, 64, 1) },
};
const shaOf = (file) => fakeSha256(`asset:logo:${file.name}:${file.buffer.length}`);

// --- the harness page ------------------------------------------------------------------------------

let bundle = null;
async function harnessBundle() {
  bundle ??= await bundleHarness({ entry: ENTRY });
  return bundle;
}

async function openHarness(page, config = {}) {
  const script = await harnessBundle();
  const images = new Map(Object.values(FILES).map((file) => [shaOf(file), file.buffer]));
  await page.route(`${ORIGIN}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/") return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: HARNESS_HTML });
    if (pathname === "/harness.js") return route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: script });
    const asset = /^\/api\/jobs\/[0-9a-f-]{36}\/assets\/([0-9a-f]{64})$/.exec(pathname);
    if (asset && images.has(asset[1])) return route.fulfill({ status: 200, contentType: "image/png", body: images.get(asset[1]) });
    return route.fulfill({ status: 404, body: "" });
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !/Failed to load resource/.test(message.text())) errors.push(message.text());
  });
  const sizes = Object.fromEntries(Object.values(FILES).filter((file) => file.size).map((file) => [file.name, file.size]));
  const upload = { sizes, fail: { [FILES.rejected.name]: { status: 422, code: "asset_rejected" }, [FILES.network.name]: "network" },
    ...(config.upload ?? {}) };
  await page.addInitScript((value) => { window.__HARNESS_CONFIG__ = value; }, { ...config, upload });
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => window.__harness?.ready === true);
  await expect(page.locator('[data-editor-ready="true"]')).toBeVisible();
  return errors;
}

const panel = (page) => page.locator('[data-panel="logo"]');
const logoBoxEl = (page) => page.locator("[data-logo-box]");
const stageCanvas = (page) => page.locator('[data-stage="canvas"]');

async function snapshot(page) {
  return page.evaluate(() => {
    const state = window.__harness.store.getState();
    const track = state.doc.tracks.find((entry) => entry.kind === "visual");
    return {
      save: state.save, canUndo: state.canUndo, logo: track?.items[0] ?? null, assets: state.doc.assets,
      planLogo: state.plan?.logo ?? null, warnings: state.plan?.warnings ?? [], planDoc: state.plan?.docSha256 ?? null,
      commands: window.__harness.log.filter((entry) => entry.ok).map((entry) => ({ type: entry.type, args: entry.args })),
      rejected: window.__harness.log.filter((entry) => !entry.ok).map((entry) => ({ type: entry.type, code: entry.code })),
      mergeKeys: window.__harness.log.filter((entry) => entry.ok).map((entry) => entry.mergeKey),
    };
  });
}

/** The plan's logo box for the current document (waits until the plan caught up). */
async function planBox(page) {
  await page.waitForFunction(() => {
    const state = window.__harness.store.getState();
    return !state.pending.includes("text") && Boolean(state.plan?.logo);
  });
  return (await snapshot(page)).planLogo.box;
}

/** The gizmo box in output pixels, measured on the screen. */
async function screenBox(page) {
  const stage = await stageCanvas(page).boundingBox();
  const box = await logoBoxEl(page).boundingBox();
  const scale = 720 / stage.width;
  return {
    x: Math.round((box.x - stage.x) * scale), y: Math.round((box.y - stage.y) * scale),
    w: Math.round(box.width * scale), h: Math.round(box.height * scale), scale,
  };
}

async function uploadFile(page, file) {
  await panel(page).locator('input[type="file"]').setInputFiles({ name: file.name, mimeType: file.mimeType, buffer: file.buffer });
}

async function addLogo(page, file = FILES.square) {
  await uploadFile(page, file);
  await expect(logoBoxEl(page)).toBeVisible();
  return planBox(page);
}

/** Drags from the middle of `locator` by (dx, dy) output pixels, in steps, optionally with Alt. */
async function dragBy(page, locator, dx, dy, { alt = false, steps = 8 } = {}) {
  const stage = await stageCanvas(page).boundingBox();
  const scale = stage.width / 720;
  const box = await locator.boundingBox();
  const x0 = box.x + box.width / 2;
  const y0 = box.y + box.height / 2;
  await page.mouse.move(x0, y0);
  if (alt) await page.keyboard.down("Alt");
  await page.mouse.down();
  await page.mouse.move(x0 + dx * scale, y0 + dy * scale, { steps });
  await page.mouse.up();
  if (alt) await page.keyboard.up("Alt");
}

/** Leaves any focused control, so the stage shortcuts (Ctrl+Z, arrows) go to the shell. */
async function blur(page) {
  await page.evaluate(() => document.activeElement?.blur?.());
}

async function logoTransform(page) {
  return (await snapshot(page)).logo?.transform ?? null;
}

async function undoCount(page) {
  return page.evaluate(() => window.__harness.store.getState().canUndo);
}

test.describe("logo panel and gizmo (harness)", () => {
  test("upload places the logo top right; the outline is the plan's box at the output size; undo and redo", async ({ page }) => {
    const errors = await openHarness(page);
    await expect(panel(page).getByRole("heading", { name: "Logo" })).toBeVisible();
    await expect(panel(page).getByText("PNG, JPEG, atau WebP", { exact: false })).toBeVisible();
    await expect(page.locator('[data-gizmo="logo"]')).toHaveCount(0);
    const box = await addLogo(page);
    expect(await logoTransform(page)).toEqual({ x_e5: 88000, y_e5: 7000, w_e5: 16000, opacity_pm: 850 });
    expect(box).toEqual({ x: 576, y: 32, w: 115, h: 115 });
    const seen = await screenBox(page);
    expect({ x: seen.x, y: seen.y, w: seen.w, h: seen.h }).toEqual(box);
    await expect(panel(page).locator("[data-logo-thumb]")).toBeVisible();
    await expect(panel(page).getByText("512 × 512 px")).toBeVisible();
    const state = await snapshot(page);
    expect(state.commands.map((entry) => entry.type)).toEqual(["SetLogo"]);
    expect(Object.values(state.assets)).toEqual([{ kind: "image", mime: "image/png", w: 512, h: 512 }]);
    // Undo removes it (one step), redo brings it back.
    await blur(page);
    await page.keyboard.press("Control+z");
    await expect(logoBoxEl(page)).toHaveCount(0);
    await expect(panel(page).getByRole("button", { name: "Unggah logo" })).toBeVisible();
    await page.keyboard.press("Control+Shift+z");
    await expect(logoBoxEl(page)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("the corner presets snap the logo (SnapLogo) and show where it sits", async ({ page }) => {
    await openHarness(page);
    await addLogo(page);
    const radio = (name) => panel(page).getByRole("radio", { name });
    await expect(radio("Kanan atas")).toBeChecked();
    const expected = {
      "Kiri atas": ["top_left", { x: 29, y: 32 }], "Kiri bawah": ["bottom_left", { x: 29, y: 1133 }],
      "Kanan bawah": ["bottom_right", { x: 576, y: 1133 }], "Kanan atas": ["top_right", { x: 576, y: 32 }],
    };
    for (const [name, [corner, at]] of Object.entries(expected)) {
      await radio(name).check();
      await expect(radio(name)).toBeChecked();
      const state = await snapshot(page);
      expect(state.commands.at(-1)).toEqual({ type: "SnapLogo", args: { corner } });
      expect(await planBox(page)).toMatchObject(at);
    }
    // Keyboard: arrows move between the presets in the radio group.
    await radio("Kanan atas").focus();
    await page.keyboard.press("ArrowLeft");
    await expect(radio("Kiri atas")).toBeChecked();
  });

  test("dragging snaps to the corner margins and the TikTok zone's edges; Alt drags freely; the frame stops it", async ({ page }) => {
    const errors = await openHarness(page);
    const start = await addLogo(page);
    // Into the safe corner: the box start lands 4 px from the zone's right and top edges.
    await dragBy(page, logoBoxEl(page), 512 + 4 - start.x, 93 + 4 - start.y);
    expect(await planBox(page)).toEqual({ x: 512, y: 93, w: 115, h: 115 });
    let state = await snapshot(page);
    expect(state.commands.slice(1).every((entry) => entry.type === "MoveLogo")).toBe(true);
    await expect(page.locator("[data-logo-unsafe]")).toHaveCount(0);
    // One drag is one undo step.
    await page.keyboard.press("Control+z");
    expect(await planBox(page)).toEqual(start);
    await page.keyboard.press("Control+Shift+z");
    expect(await planBox(page)).toEqual({ x: 512, y: 93, w: 115, h: 115 });
    // Near the top-left margins: exactly the "Kiri atas" preset (SnapLogo's transform).
    await dragBy(page, logoBoxEl(page), 29 + 5 - 512, 32 - 6 - 93);
    expect(await planBox(page)).toEqual({ x: 29, y: 32, w: 115, h: 115 });
    await expect(panel(page).getByRole("radio", { name: "Kiri atas" })).toBeChecked();
    expect(await logoTransform(page)).toEqual({ x_e5: 12014, y_e5: 6992, w_e5: 16000, opacity_pm: 850 });
    // Alt switches the magnet off: the same kind of drag stays where the pointer left it.
    await dragBy(page, logoBoxEl(page), 250, 300, { alt: true });
    const free = await planBox(page);
    expect(free.x).toBeGreaterThanOrEqual(279 - 2);
    expect(free.x).toBeLessThanOrEqual(279 + 2);
    expect([29, 303, 512, 576]).not.toContain(free.x);
    // The frame stops a drag at its edges (item_out_of_frame never reaches the store).
    await dragBy(page, logoBoxEl(page), -3000, -3000);
    expect(await planBox(page)).toMatchObject({ x: 0, y: 0 });
    await dragBy(page, logoBoxEl(page), 5000, 5000, { alt: true });
    expect(await planBox(page)).toMatchObject({ x: 720 - 115, y: 1280 - 115 });
    await expect(page.locator('[role="status"]', { hasText: "Logo harus berada di dalam frame" })).toHaveCount(0);
    state = await snapshot(page);
    expect(state.commands.every((entry) => ["SetLogo", "MoveLogo"].includes(entry.type))).toBe(true);
    expect(state.mergeKeys.slice(1).every((key) => key === "logo:move")).toBe(true);
    expect(state.rejected).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("the guides show while dragging, and the box says when it is inside the TikTok zone", async ({ page }) => {
    await openHarness(page);
    await addLogo(page);
    const stage = await stageCanvas(page).boundingBox();
    const scale = stage.width / 720;
    const box = await logoBoxEl(page).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    // From (576, 32) to about (556, 95): the magnet takes the corner margin and the zone's top edge,
    // and the right edge is still inside the zone's right band.
    await page.mouse.move(box.x + box.width / 2 - 20 * scale, box.y + box.height / 2 + 63 * scale, { steps: 6 });
    await expect(page.locator('[data-gizmo="logo"]')).toHaveAttribute("data-dragging", "true");
    await expect(page.locator('[data-guide="safe_top"]')).toBeVisible();
    await expect(page.locator('[data-guide="margin_right"]')).toBeVisible();
    await expect(page.locator('[data-guide-kind="zone"]').first()).toBeVisible();
    await expect(logoBoxEl(page)).toHaveAttribute("data-unsafe", "true");
    await page.mouse.move(box.x + box.width / 2 - 64 * scale, box.y + box.height / 2 + 200 * scale, { steps: 6 });
    await expect(logoBoxEl(page)).toHaveAttribute("data-unsafe", "false");
    await page.mouse.up();
    await expect(page.locator('[data-gizmo="logo"]')).toHaveAttribute("data-dragging", "false");
    await expect(page.locator("[data-guide]")).toHaveCount(0);
  });

  test("arrow keys nudge the focused logo by 1 px, Shift by 10 px, stop at the frame and merge into one undo step", async ({ page }) => {
    const errors = await openHarness(page);
    const start = await addLogo(page);
    await logoBoxEl(page).focus();
    await page.keyboard.press("ArrowRight");
    expect(await planBox(page)).toMatchObject({ x: start.x + 1, y: start.y });
    await page.keyboard.press("Shift+ArrowDown");
    expect(await planBox(page)).toMatchObject({ x: start.x + 1, y: start.y + 10 });
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowUp");
    expect(await planBox(page)).toMatchObject({ x: start.x, y: start.y + 9 });
    // The arrows moved the logo, not the playhead (the stage shortcut ← / → steps frames).
    expect(await page.evaluate(() => window.__potonginEditor.player.frame())).toBe(0);
    // At the right edge nothing moves and nothing is rejected.
    for (let i = 0; i < 4; i += 1) await page.keyboard.press("Shift+ArrowRight");
    expect(await planBox(page)).toMatchObject({ x: 720 - 115 });
    const before = (await snapshot(page)).commands.length;
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(100);
    expect((await snapshot(page)).commands.length).toBe(before);
    await expect(page.locator('[role="status"]', { hasText: "frame" })).toHaveCount(0);
    // Fast repeats are one undo step (mergeKey logo:move within 500 ms).
    await page.waitForTimeout(600);
    const anchor = await planBox(page);
    for (let i = 0; i < 5; i += 1) await page.keyboard.press("ArrowUp");
    expect(await planBox(page)).toMatchObject({ y: anchor.y - 5 });
    await blur(page);
    await page.keyboard.press("Control+z");
    expect(await planBox(page)).toEqual(anchor);
    // Escape leaves the logo.
    await logoBoxEl(page).focus();
    await page.keyboard.press("Escape");
    await expect(logoBoxEl(page)).not.toBeFocused();
    expect(errors).toEqual([]);
  });

  test("a corner handle resizes with the aspect locked and the opposite corner fixed, in one undo step", async ({ page }) => {
    await openHarness(page);
    await uploadFile(page, FILES.wide);
    await expect(logoBoxEl(page)).toBeVisible();
    await panel(page).getByRole("radio", { name: "Kanan atas" }).check();
    const start = await planBox(page);
    expect(start).toEqual({ x: 576, y: 32, w: 115, h: 29 });
    await logoBoxEl(page).hover();
    const handle = page.locator('[data-logo-handle="bottom_left"]');
    await expect(handle).toBeVisible();
    await dragBy(page, handle, -80, 20);
    const grown = await planBox(page);
    expect(grown.x + grown.w).toBe(start.x + start.w);
    expect(grown.y).toBe(start.y);
    expect(grown.w).toBeGreaterThan(start.w + 60);
    expect(grown.h).toBe(Math.floor((2 * grown.w * 250 + 1000) / 2000));
    const state = await snapshot(page);
    expect(new Set(state.commands.slice(2).map((entry) => entry.type))).toEqual(new Set(["ResizeLogo", "MoveLogo"]));
    expect(new Set(state.mergeKeys.slice(2))).toEqual(new Set(["logo:size"]));
    expect(state.rejected).toEqual([]);
    await page.keyboard.press("Control+z");
    expect(await planBox(page)).toEqual(start);
    await page.keyboard.press("Control+Shift+z");
    // The top-right handle shrinks it towards the bottom-left corner.
    await logoBoxEl(page).hover();
    await dragBy(page, page.locator('[data-logo-handle="top_right"]'), -60, 20);
    const shrunk = await planBox(page);
    expect(shrunk.x).toBe(grown.x);
    expect(shrunk.y + shrunk.h).toBe(grown.y + grown.h);
    expect(shrunk.w).toBeLessThan(grown.w);
    // Past the frame and past 40 % of the width it stops.
    await logoBoxEl(page).hover();
    await dragBy(page, page.locator('[data-logo-handle="bottom_left"]'), -2000, 2000);
    const largest = await planBox(page);
    expect(largest.w).toBe(288);
    expect(largest.x).toBeGreaterThanOrEqual(0);
  });

  test("the size slider keeps the corner the logo sits on; opacity; nothing ever leaves the frame", async ({ page }) => {
    const errors = await openHarness(page);
    await addLogo(page);
    const size = panel(page).getByRole("slider", { name: "Ukuran" });
    const opacity = panel(page).getByRole("slider", { name: "Opasitas" });
    await expect(panel(page).getByText("16% lebar video · 115 px")).toBeVisible();
    await size.focus();
    await page.keyboard.press("End");
    expect(await planBox(page)).toEqual({ x: 720 - 29 - 288, y: 32, w: 288, h: 288 });
    await expect(panel(page).getByRole("radio", { name: "Kanan atas" })).toBeChecked();
    await expect(panel(page).getByText("40% lebar video · 288 px")).toBeVisible();
    await page.keyboard.press("Home");
    expect(await planBox(page)).toEqual({ x: 720 - 29 - 29, y: 32, w: 29, h: 29 });
    // Free placement near the left edge: growing is kept inside the frame.
    await dragBy(page, logoBoxEl(page), -900, 400, { alt: true });
    await size.focus();
    await page.keyboard.press("End");
    const grown = await planBox(page);
    expect(grown.x).toBe(0);
    expect(grown.w).toBe(288);
    await opacity.focus();
    await page.keyboard.press("End");
    expect((await logoTransform(page)).opacity_pm).toBe(1000);
    await expect(panel(page).getByText("100%", { exact: true })).toBeVisible();
    await page.keyboard.press("Home");
    expect((await logoTransform(page)).opacity_pm).toBe(200);
    await page.keyboard.press("ArrowRight");
    expect((await logoTransform(page)).opacity_pm).toBe(210);
    await expect(panel(page).getByText("21%", { exact: true })).toBeVisible();
    const final = await snapshot(page);
    const types = new Set(final.commands.map((entry) => entry.type));
    expect([...types].every((type) => ["SetLogo", "MoveLogo", "ResizeLogo", "SetLogoOpacity"].includes(type))).toBe(true);
    expect(final.rejected).toEqual([]);
    await expect(page.locator('[role="status"]', { hasText: "frame" })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("G5: the TikTok-zone warning shows when the logo is in the zone, and 'Geser ke area aman' clears it", async ({ page }) => {
    await openHarness(page);
    await addLogo(page);
    const warning = panel(page).locator("[data-logo-unsafe]");
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("tombol TikTok");
    await expect(page.getByRole("button", { name: /Perlu dicek \(1\)/ })).toBeVisible();
    await page.getByRole("button", { name: /Perlu dicek/ }).click();
    await expect(page.getByText("Caption, hook, atau logo masuk ke area tombol TikTok")).toBeVisible();
    await page.keyboard.press("Escape");
    await warning.getByRole("button", { name: "Geser ke area aman" }).click();
    expect(await planBox(page)).toEqual({ x: 512, y: 93, w: 115, h: 115 });
    await expect(warning).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Perlu dicek \(0\)/ })).toBeVisible();
    // Into the bottom band again: the warning comes back.
    await dragBy(page, logoBoxEl(page), 0, 1000 - 93);
    await expect(panel(page).locator("[data-logo-unsafe]")).toBeVisible();
    const state = await snapshot(page);
    expect(state.warnings).toEqual([{ code: "unsafe_zone", path: expect.stringMatching(/^\/tracks\/\d+\/items\/0\/transform$/), ref: state.logo.id }]);
  });

  test("upload errors: wrong type, too large, a file the server rejects, a lost connection, a cancelled upload", async ({ page }) => {
    const errors = await openHarness(page, { upload: { stepMs: 250, steps: 8 } });
    const alert = panel(page).locator("[data-logo-error]");
    await uploadFile(page, FILES.gif);
    await expect(alert).toContainText("Format ini tidak didukung. Pakai PNG, JPEG, atau WebP.");
    await uploadFile(page, FILES.huge);
    await expect(alert).toContainText("File terlalu besar. Logo maksimal 10 MB.");
    await uploadFile(page, FILES.rejected);
    await expect(panel(page).locator("[data-logo-upload]")).toBeVisible();
    await expect(alert).toContainText("tidak bisa dibaca", { timeout: 10_000 });
    await uploadFile(page, FILES.network);
    await expect(alert).toContainText("Koneksi terputus");
    // A slow upload shows its progress and can be cancelled.
    await uploadFile(page, FILES.slow);
    const progress = panel(page).getByRole("progressbar", { name: "Unggahan logo" });
    await expect(progress).toBeVisible();
    await expect.poll(async () => Number(await progress.getAttribute("aria-valuenow"))).toBeGreaterThan(0);
    await panel(page).getByRole("button", { name: "Batalkan unggahan" }).click();
    await expect(panel(page).getByText("Unggahan dibatalkan.")).toBeVisible();
    await expect(logoBoxEl(page)).toHaveCount(0);
    expect((await snapshot(page)).commands).toEqual([]);
    // After all that, a good file still works and clears the message.
    await addLogo(page);
    await expect(alert).toHaveCount(0);
    const uploads = await page.evaluate(() => window.__harness.uploads.map((entry) => entry.name));
    expect(uploads).toEqual(["animasi.gif", "besar.png", "rusak.png", "putus.png", "lambat.png", "logo-kotak.png"]);
    expect(errors).toEqual([]);
  });

  test("replace keeps the place; remove clears the gizmo and the panel; undo brings the logo back", async ({ page }) => {
    await openHarness(page);
    await addLogo(page);
    await panel(page).getByRole("radio", { name: "Kiri bawah" }).check();
    const before = await planBox(page);
    await panel(page).locator('input[type="file"]').setInputFiles({ name: FILES.wide.name, mimeType: "image/png", buffer: FILES.wide.buffer });
    await expect.poll(async () => (await planBox(page)).h).toBe(29);
    const replaced = await planBox(page);
    expect(replaced.x).toBe(before.x);
    expect(Object.keys((await snapshot(page)).assets)).toEqual([`sha256:${shaOf(FILES.wide)}`]);
    await panel(page).getByRole("button", { name: "Hapus logo" }).click();
    await expect(logoBoxEl(page)).toHaveCount(0);
    await expect(page.locator('[data-gizmo="logo"]')).toHaveCount(0);
    expect((await snapshot(page)).assets).toEqual({});
    await page.keyboard.press("Control+z");
    await expect(logoBoxEl(page)).toBeVisible();
    expect(await planBox(page)).toEqual(replaced);
  });

  test("read-only: the logo is shown but cannot be changed", async ({ page }) => {
    const doc = readOnlyDoc();
    await openHarness(page, { readOnly: true, doc });
    await expect(page.locator('[data-editor-status="readOnly"]')).toBeVisible();
    await expect(logoBoxEl(page)).toBeVisible();
    await expect(logoBoxEl(page)).toHaveAttribute("aria-disabled", "true");
    await expect(page.locator("[data-logo-handle]")).toHaveCount(0);
    for (const name of ["Kiri atas", "Kanan bawah"]) await expect(panel(page).getByRole("radio", { name })).toBeDisabled();
    await expect(panel(page).getByRole("slider", { name: "Ukuran" })).toBeDisabled();
    await expect(panel(page).getByRole("button", { name: "Hapus logo" })).toBeDisabled();
    const start = await planBox(page);
    await dragBy(page, logoBoxEl(page), 100, 100);
    await logoBoxEl(page).focus();
    await page.keyboard.press("ArrowRight");
    expect(await planBox(page)).toEqual(start);
    expect((await snapshot(page)).commands).toEqual([]);
  });

  for (const viewport of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
    test(`scripted QG-UX U5 (logo part) at ${viewport.width}×${viewport.height}: add, place, size and fade a logo within 60 s`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openHarness(page, { panel: "transcript" });
      const started = Date.now();
      const steps = [];
      const mark = (name) => steps.push({ step: name, ms: Date.now() - started });
      await page.getByRole("tab", { name: "Logo" }).click();
      mark("tab");
      await uploadFile(page, FILES.square);
      await expect(logoBoxEl(page)).toBeVisible();
      mark("uploaded");
      await panel(page).locator("[data-logo-unsafe]").getByRole("button", { name: "Geser ke area aman" }).click();
      mark("safe_area");
      await panel(page).getByRole("slider", { name: "Ukuran" }).focus();
      for (let i = 0; i < 20; i += 1) await page.keyboard.press("ArrowRight");
      mark("sized");
      await panel(page).getByRole("slider", { name: "Opasitas" }).focus();
      for (let i = 0; i < 5; i += 1) await page.keyboard.press("ArrowLeft");
      mark("faded");
      await expect.poll(async () => (await snapshot(page)).save, { timeout: 15_000 }).toBe("saved");
      mark("saved");
      const elapsed = Date.now() - started;
      const state = await snapshot(page);
      const box = await planBox(page);
      expect(state.warnings.filter((warning) => warning.code === "unsafe_zone")).toEqual([]);
      expect(state.logo.transform.opacity_pm).toBe(800);
      expect(state.logo.transform.w_e5).toBe(18000);
      expect(elapsed).toBeLessThanOrEqual(U5_LOGO_MS);
      writeEvidence(`T3.2-QG-UX-U5-${viewport.width}x${viewport.height}.json`, {
        gate: "QG-UX U5 (logo part, scripted)", task: "T3.2", limit_ms: U5_LOGO_MS, elapsed_ms: elapsed, pass: elapsed <= U5_LOGO_MS,
        viewport, steps, final_box: box, browser: page.context().browser().version(),
        note: "harness page: EditorApp on the real store and commands, fake API and upload client; automation speed, the owner times U5 at checkpoint 3",
      });
    });
  }

  test("QG-A11Y: axe finds no critical or serious violation in the Logo panel and gizmo states", async ({ page }) => {
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
    await openHarness(page, { upload: { stepMs: 400, steps: 10 } });
    await run("empty");
    await uploadFile(page, FILES.slow);
    await expect(panel(page).getByRole("progressbar")).toBeVisible();
    await run("uploading");
    await panel(page).getByRole("button", { name: "Batalkan unggahan" }).click();
    await uploadFile(page, FILES.gif);
    await run("error");
    await openHarness(page);
    await addLogo(page);
    await logoBoxEl(page).focus();
    await run("logo focused, in the zone");
    const serious = results.flatMap((entry) => entry.violations.filter((violation) => ["critical", "serious"].includes(violation.impact))
      .map((violation) => ({ state: entry.state, ...violation })));
    writeEvidence("T3.2-QG-A11Y.json", { gate: "QG-A11Y (Logo panel and gizmo)", task: "T3.2", states: results, serious, pass: serious.length === 0 });
    expect(serious).toEqual([]);
  });
});

function readOnlyDoc() {
  const seed = fakeDoc();
  const ctx = createContext({ words: fakeWords(), seed });
  const meta = { sha256: shaOf(FILES.square), kind: "logo", mime: "image/png", w: 512, h: 512 };
  return applyCommand(seed, "SetLogo", { asset: `sha256:${meta.sha256}`, meta }, ctx).doc;
}

// --- the real stack: captures for P-LOGO -----------------------------------------------------------

const REAL = process.env.E2E_LOGO_REAL === "1";
const JOB_ID = process.env.E2E_EDITOR_JOB_ID || "";
const JOBS_ROOT = process.env.E2E_JOBS_ROOT || "";
const CAPTURES = process.env.LOGO_CAPTURES || "";
const PYTHON = process.env.LOGO_PYTHON || "python3";

async function api(page, method, url, { json, headers = {} } = {}) {
  return page.evaluate(async ({ method: verb, url: target, json: body, headers: extra }) => {
    const init = { method: verb, credentials: "same-origin", headers: { Accept: "application/json", ...extra } };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers["Content-Type"] = "application/json";
    }
    const response = await fetch(target, init);
    const text = await response.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, body: parsed, etag: response.headers.get("etag") };
  }, { method, url, json, headers });
}

async function truthFrame(page, clipId, doc, f) {
  return page.evaluate(async ({ url, body }) => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body });
      if (response.status === 429) { await new Promise((resolve) => { setTimeout(resolve, 400); }); continue; }
      if (!response.ok) throw new Error(`truth frame ${response.status}: ${await response.text()}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(binary);
    }
    throw new Error("truth frame: rate limited");
  }, { url: `/api/jobs/${JOB_ID}/clips/${clipId}/preview/frame`, body: JSON.stringify({ doc, f }) });
}

const inspect = (page) => page.evaluate(() => {
  const hook = globalThis.__potonginEditorInspect;
  if (!hook) return null;
  const state = hook.state();
  const player = hook.player();
  return { status: state.status, doc: state.doc, plan: state.plan, pending: state.pending,
    player: player ? { mode: player.mode, frame: player.frame, exact: player.exact, presentedFrame: player.presentedFrame, current: player.current } : null };
});

async function settle(page, frame) {
  await expect.poll(async () => {
    const view = await inspect(page);
    const player = view?.player;
    return Boolean(view?.plan?.logo?.state === "ready" && player && player.mode === "live" && player.exact === true
      && player.presentedFrame === frame && player.current?.logo && player.current?.plate && player.current?.text);
  }, { timeout: 120_000, intervals: [250] }).toBe(true);
}

test.describe("real stack", () => {
  test.skip(!REAL, "E2E_LOGO_REAL=1 with a private server and a copy of a real V3 job (see the header)");
  test.use({ baseURL: settings.baseURL, viewport: { width: 1366, height: 900 } });

  test("P-LOGO captures at the output size, with truth frames", async ({ page, browser }) => {
    test.setTimeout(1_800_000);
    expect(JOB_ID && JOBS_ROOT && CAPTURES).toBeTruthy();
    await login(page);
    const prepared = await api(page, "POST", `/api/jobs/${JOB_ID}/clips`, { json: {} });
    expect([200, 202]).toContain(prepared.status);
    let clips = [];
    await expect.poll(async () => {
      const listed = await api(page, "GET", `/api/jobs/${JOB_ID}/clips`);
      clips = (listed.body?.clips ?? []).filter((clip) => clip.openable && clip.clipId);
      return clips.length;
    }, { timeout: 300_000, intervals: [2000] }).toBeGreaterThan(0);
    const wanted = process.env.E2E_LOGO_CLIP ? Number(process.env.E2E_LOGO_CLIP) : null;
    const clip = clips.find((entry) => wanted === null || entry.index === wanted) ?? clips[0];
    const jobDir = path.join(JOBS_ROOT, JOB_ID);
    const logos = JSON.parse(execFileSync(PYTHON, [path.join(repoRoot, "scripts", "parity", "logo_gates.py"), "assets", "--job-dir", jobDir], { encoding: "utf8" }));

    const edit = await api(page, "GET", `/api/jobs/${JOB_ID}/clips/${clip.clipId}/edit?seed=1`);
    const seed = edit.body.doc;
    const words = (await api(page, "GET", edit.body.words.url)).body;
    const ctx = createContext({ words, seed });
    const box = (doc) => {
      const item = doc.tracks.find((track) => track.kind === "visual").items[0];
      return item.transform;
    };
    const run = (doc, steps) => steps.reduce((current, [type, args]) => applyCommand(current, type, args, ctx).doc, doc);
    const withAsset = (name) => ["SetLogo", { asset: logos[name].asset, meta: logos[name].meta }];
    const cases = [
      { id: "square-default", steps: [withAsset("square")] },
      { id: "square-safe-opaque", steps: [withAsset("square"), ["MoveLogo", { x_e5: 76458, y_e5: 11758 }], ["SetLogoOpacity", { opacity_pm: 1000 }]] },
      { id: "wide-bottom-left-max", steps: [withAsset("wide"), ["MoveLogo", { x_e5: 50000, y_e5: 50000 }], ["ResizeLogo", { w_e5: 40000 }], ["SnapLogo", { corner: "bottom_left" }], ["SetLogoOpacity", { opacity_pm: 600 }]] },
      { id: "tall-free-faint", steps: [withAsset("tall"), ["ResizeLogo", { w_e5: 9000 }], ["MoveLogo", { x_e5: 46333, y_e5: 47734 }], ["SetLogoOpacity", { opacity_pm: 200 }]] },
      { id: "square-min-top-left", steps: [withAsset("square"), ["ResizeLogo", { w_e5: 4000 }], ["SnapLogo", { corner: "top_left" }]] },
      { id: "wide-over-captions", steps: [withAsset("wide"), ["MoveLogo", { x_e5: 50000, y_e5: 80500 }], ["ResizeLogo", { w_e5: 27500 }], ["SetLogoOpacity", { opacity_pm: 1000 }]] },
    ];
    const manifest = { schema: "potongin.logo-captures/1", job: JOB_ID, clipId: clip.clipId, browser: browser.version(),
      output: { w: seed.output.w, h: seed.output.h }, cases: [] };
    mkdirSync(CAPTURES, { recursive: true });
    let current = await api(page, "GET", `/api/jobs/${JOB_ID}/clips/${clip.clipId}/edit`);
    for (const entry of cases) {
      const content = run(seed, entry.steps);
      const doc = { ...content, revision: current.body.doc.revision + 1, parent_sha256: current.body.etag };
      const saved = await api(page, "PUT", `/api/jobs/${JOB_ID}/clips/${clip.clipId}/edit`, {
        json: doc, headers: { "If-Match": `"${current.body.etag}"`, "Idempotency-Key": crypto.randomUUID() } });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      current = { body: { doc: saved.body.doc, etag: saved.body.etag } };
      await page.goto(`/projects/${JOB_ID}/clips/${clip.clipId}/edit`);
      await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 60_000 });
      const view = await inspect(page);
      const total = view.plan.totalFrames;
      const fps = view.plan.fps;
      const second = Math.max(1, Math.round(fps[0] / fps[1]));
      // Frame 0, then about a third and two thirds into the clip, reached with Shift+→ (1 s steps).
      const presses = [0, Math.floor(total / 3 / second), Math.floor((2 * total) / 3 / second)];
      const caseDir = path.join(CAPTURES, entry.id);
      mkdirSync(caseDir, { recursive: true });
      const bare = run(view.doc, [["RemoveLogo", {}]]);
      writeFileSync(path.join(caseDir, "doc.json"), JSON.stringify(view.doc));
      await page.locator("body").click({ position: { x: 5, y: 890 } });
      let frame = 0;
      for (const target of presses) {
        while (frame < Math.min(total - 1, target * second)) {
          await page.keyboard.press("Shift+ArrowRight");
          const next = Math.min(total - 1, frame + second);
          await expect.poll(async () => (await inspect(page)).player.frame, { timeout: 30_000 }).toBe(next);
          frame = next;
        }
        await settle(page, frame);
        const png = await page.evaluate(() => document.querySelector('[data-stage="canvas"]').toDataURL("image/png"));
        const frameDir = path.join(caseDir, String(frame));
        mkdirSync(frameDir, { recursive: true });
        writeFileSync(path.join(frameDir, "browser.png"), Buffer.from(png.split(",")[1], "base64"));
        writeFileSync(path.join(frameDir, "truth.png"), Buffer.from(await truthFrame(page, clip.clipId, view.doc, frame), "base64"));
        await page.waitForTimeout(300);
        writeFileSync(path.join(frameDir, "truth-nologo.png"), Buffer.from(await truthFrame(page, clip.clipId, bare, frame), "base64"));
        await page.waitForTimeout(300);
      }
      manifest.cases.push({ id: entry.id, transform: box(view.doc), planLogo: view.plan.logo, frames: presses.length });
    }
    writeFileSync(path.join(CAPTURES, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    expect(manifest.cases.length).toBe(cases.length);
  });
});
