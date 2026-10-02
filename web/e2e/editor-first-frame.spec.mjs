// The first frame of the editor player without Play and without any user gesture
// (fix/editor-first-frame; seen on production in Brave on Linux, Chromium 146, no WebGL2: the
// stage stayed black with "Menyiapkan frame…" until Play).
//
// The other browser specs cannot see this: they launch Chrome with
// --autoplay-policy=no-user-gesture-required, and every page.evaluate of Playwright runs with
// userGesture: true in Chromium, so the page has a user activation before the player loads. Here
// the session comes from a separate page, the harness page is driven by an init script (a page's
// own timers carry no activation) and results come back as a console message only. Twice: with the
// browser's default GPU stack, and with the GPU and every WebGL API off, like the owner's browser.
//
// A third run reproduces the stall seen on production under heavy memory pressure: the first video
// decoder the page flushes never settles (a paused frame is decoded with getSample, which flushes;
// playback's sequential route does not need to). Before the paused wait had a budget, that left the
// stage black until Play.
//
// Prerequisites (as for web/e2e/editor-player.spec.mjs): player fixtures from
// `scripts/parity/player_fixtures.py generate --out <dir> [--only <case>,...]`, a server with
// POTONGIN_PARITY_HARNESS=1 and POTONGIN_PARITY_FIXTURES=<dir>, E2E_USERNAME/E2E_PASSWORD, and
//   POTONGIN_PARITY_FIXTURES=<dir> npx playwright test e2e/editor-first-frame.spec.mjs --project=desktop-chromium
// CI: `gh workflow run editor-gates.yml -f ref=<branch> -f suite=player -f command=e2e/editor-first-frame.spec.mjs`.
// Every P-FRAME case of the manifest is opened (E2E_FIRST_FRAME_CASES narrows them).
import { chromium, expect, test } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { login, settings } from "./support/harness.mjs";

const fixturesDir = process.env.POTONGIN_PARITY_FIXTURES || "";
const outDir = path.join(process.env.PARITY_OUT_DIR || path.join(os.tmpdir(), `potongin-first-frame-${process.pid}`), "player");
const manifestPath = fixturesDir ? path.join(fixturesDir, "player", "manifest.json") : "";
const manifest = manifestPath && existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
const wanted = (process.env.E2E_FIRST_FRAME_CASES || "").split(",").map((id) => id.trim()).filter(Boolean);
const cases = (manifest?.cases ?? []).filter((item) => item.kind === "pframe" && (!wanted.length || wanted.includes(item.id)));

function defaultChrome() {
  const candidate = path.join(os.homedir(), ".cache", "ms-playwright", "chromium-1217", "chrome-linux64", "chrome");
  return existsSync(candidate) ? candidate : undefined;
}
const chrome = process.env.PARITY_CHROME || defaultChrome();

const TAG = "potongin-first-frame ";
// Plan §10.3 has no first-paint budget; this only bounds a hang (the harness itself waits 30 s).
const FIRST_FRAME_TIMEOUT_MS = 90_000;

test.skip(!manifest, "POTONGIN_PARITY_FIXTURES must hold player/manifest.json (scripts/parity/player_fixtures.py generate)");
test.skip(!settings.username || !settings.password, "E2E_USERNAME and E2E_PASSWORD are required");

// Runs in the harness page before its scripts: the first VideoDecoder whose flush() is called never
// settles, and neither does any later flush of that decoder; every other decoder works.
function stallFirstDecoder() {
  const Native = globalThis.VideoDecoder;
  if (typeof Native !== "function") return;
  const flush = Native.prototype.flush;
  let stalled = null;
  globalThis.__potonginStalledFlushes = 0;
  Native.prototype.flush = function stalledFlush(...args) {
    stalled ??= this;
    if (this !== stalled) return flush.apply(this, args);
    globalThis.__potonginStalledFlushes += 1;
    return new Promise(() => {});
  };
}

// Runs in the harness page before its scripts: records every AudioContext, waits for the harness,
// opens the case (the harness resolves once the playhead frame is on the canvas), then reports.
function openOnLoad({ tag, caseId }) {
  const contexts = [];
  const Native = globalThis.AudioContext;
  if (typeof Native === "function") {
    globalThis.AudioContext = class extends Native {
      constructor(...args) {
        super(...args);
        contexts.push(this);
      }
    };
  }
  const report = (payload) => console.log(tag + JSON.stringify(payload));
  const started = performance.now();
  const webgl2 = () => Boolean(document.createElement("canvas").getContext("webgl2"));
  const pixels = () => {
    const canvas = document.querySelector('[data-testid="player-host"] canvas');
    if (!canvas) return null;
    const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let lit = 0;
    let sampled = 0;
    for (let i = 0; i < data.length; i += 4 * 101) {
      sampled += 1;
      if (Math.max(data[i], data[i + 1], data[i + 2]) > 16) lit += 1;
    }
    return { lit, sampled, width: canvas.width, height: canvas.height };
  };
  const poll = async () => {
    const api = globalThis.__player;
    if (!api || api.state === "loading") {
      setTimeout(poll, 50);
      return;
    }
    if (api.state === "error") {
      report({ error: api.error });
      return;
    }
    const activeBefore = navigator.userActivation?.hasBeenActive ?? null;
    try {
      await api.open(caseId);
      const firstMs = Math.round(performance.now() - started);
      const shown = api.debugState();
      const picture = pixels();
      const hasBeenActive = navigator.userActivation?.hasBeenActive ?? null;
      // The mix decodes on its own; wait for it only to report the AudioContext state.
      const until = performance.now() + 30_000;
      while (!api.debugState().audio?.ready && performance.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
      report({ case: caseId, firstMs, shown, picture, activeBefore, hasBeenActive, webgl2: webgl2(),
        audioReady: Boolean(api.debugState().audio?.ready), contexts: contexts.map((context) => context.state),
        stalledFlushes: globalThis.__potonginStalledFlushes ?? 0 });
    } catch (error) {
      let shown = null;
      try { shown = api.debugState(); } catch { shown = null; }
      report({ case: caseId, error: String(error?.message || error), shown, picture: pixels(), webgl2: webgl2(),
        contexts: contexts.map((context) => context.state), stalledFlushes: globalThis.__potonginStalledFlushes ?? 0 });
    }
  };
  poll();
}

async function firstFrame(browser, caseId, { stall = false } = {}) {
  const context = await browser.newContext({ baseURL: settings.baseURL, viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  try {
    // The session cookie from a page of its own: the harness page never sees that click.
    const entry = await context.newPage();
    await login(entry, "/parity-harness/player");
    await entry.close();
    const page = await context.newPage();
    if (stall) await page.addInitScript(stallFirstDecoder);
    await page.addInitScript(openOnLoad, { tag: TAG, caseId });
    const message = page.waitForEvent("console", { predicate: (item) => item.text().startsWith(TAG), timeout: FIRST_FRAME_TIMEOUT_MS });
    await page.goto("/parity-harness/player");
    return JSON.parse((await message).text().slice(TAG.length));
  } finally {
    await context.close();
  }
}

function writeJson(name, value) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, name), `${JSON.stringify(value, null, 2)}\n`);
}

function checkFirstFrame(report) {
  expect(report.error ?? null, JSON.stringify(report)).toBeNull();
  expect(report.activeBefore, "no user activation before the player loaded").toBe(false);
  expect(report.hasBeenActive, "no user activation until the first frame was drawn").toBe(false);
  expect(report.shown.mode).toBe("live");
  expect(report.shown.frame).toBe(0);
  expect(report.shown.presentedFrame, JSON.stringify(report.shown)).toBe(0);
  expect(report.picture.width).toBe(720);
  expect(report.picture.height).toBe(1280);
  // A black canvas has no lit sample at all; the barcode sources light a large share of it.
  expect(report.picture.lit / report.picture.sampled, JSON.stringify(report.picture)).toBeGreaterThan(0.05);
}

const STACKS = [
  { name: "default GPU stack", args: [] },
  // As on the owner's browser: WebCodecs and Canvas2D, but no GPU process and no WebGL at all.
  { name: "no GPU, no WebGL", args: ["--disable-gpu", "--disable-software-rasterizer", "--disable-3d-apis"], webgl2: false },
];

for (const stack of STACKS) {
  test.describe(`first frame without Play or a gesture (${stack.name})`, () => {
    // Without fixtures the file still declares its test, which the skips above then skip.
    for (const item of cases.length ? cases : [{ id: "no-p-frame-case" }]) {
      test(`${item.id}: frame 0 is on the canvas before Play`, async () => {
        test.setTimeout(FIRST_FRAME_TIMEOUT_MS + 60_000);
        expect(cases.length, "the fixtures hold a P-FRAME case").toBeGreaterThan(0);
        // A browser per test: the launch flags differ per stack (a worker option cannot).
        const browser = await chromium.launch({ ...(chrome ? { executablePath: chrome } : {}), args: ["--mute-audio", ...stack.args] });
        try {
          const report = await firstFrame(browser, item.id);
          writeJson(`first_frame_${item.id}_${stack.args.length ? "nogpu" : "gpu"}.json`,
            { browser: browser.version(), executable: chrome ?? null, args: stack.args, ...report });
          test.info().annotations.push({ type: "first-frame",
            description: `${browser.version()} ${report.firstMs ?? "-"} ms, webgl2 ${report.webgl2}, contexts ${JSON.stringify(report.contexts)}` });
          if (stack.webgl2 === false) expect(report.webgl2, "the stack under test has no WebGL2").toBe(false);
          checkFirstFrame(report);
        } finally {
          await browser.close();
        }
      });
    }
  });
}

test.describe("first frame when the decoder stalls (its flush never settles), without Play", () => {
  for (const item of cases.length ? cases : [{ id: "no-p-frame-case" }]) {
    test(`${item.id}: frame 0 is on the canvas after the stalled decode is given up`, async () => {
      test.setTimeout(FIRST_FRAME_TIMEOUT_MS + 60_000);
      expect(cases.length, "the fixtures hold a P-FRAME case").toBeGreaterThan(0);
      const browser = await chromium.launch({ ...(chrome ? { executablePath: chrome } : {}), args: ["--mute-audio"] });
      try {
        const report = await firstFrame(browser, item.id, { stall: true });
        writeJson(`first_frame_${item.id}_stall.json`, { browser: browser.version(), executable: chrome ?? null, ...report });
        test.info().annotations.push({ type: "first-frame-stall",
          description: `${browser.version()} ${report.firstMs ?? "-"} ms, stalled flushes ${report.stalledFlushes}, `
            + `plate ${JSON.stringify(report.shown?.plate ?? null)}` });
        expect(report.stalledFlushes, "the first decoder's flush stalled").toBeGreaterThan(0);
        checkFirstFrame(report);
        expect(report.shown.plate?.abandoned, "the stalled pass was given up").toBeGreaterThanOrEqual(1);
        expect(report.shown.error ?? null, "a frame that came is not reported as failed").toBeNull();
      } finally {
        await browser.close();
      }
    });
  }
});
