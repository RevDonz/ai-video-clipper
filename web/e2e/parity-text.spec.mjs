// Text parity harness (plan §10.1 P-TIME JASSUB side and P-TXT; §11.1 T1.2b).
//
// Prerequisites (see docs/editor/SPIKES.md "Running the harness"):
//   1. Fixtures and FFmpeg references, made inside the reference image:
//        scripts/parity/reference_text.py --out <dir> --fonts <dir>
//   2. A server started with POTONGIN_PARITY_HARNESS=1 and POTONGIN_PARITY_FIXTURES=<dir>
//      (the Playwright webServer inherits both), plus E2E_USERNAME/E2E_PASSWORD.
//   3. npm run test:parity
//
// The browser is Chrome for Testing 147.0.7727.15 (Playwright build 1217); PARITY_CHROME
// overrides the executable. Outputs (PNG composites, timing, metrics) go to PARITY_OUT_DIR.
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { login, settings } from "./support/harness.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixturesDir = process.env.POTONGIN_PARITY_FIXTURES || "";
const outDir = process.env.PARITY_OUT_DIR || path.join(os.tmpdir(), `potongin-parity-${process.pid}`);
const python = process.env.PARITY_PYTHON || "python3";
// S-COLOR decision (docs/editor/SPIKES.md): the text composite the gate is measured against.
const gateFormat = process.env.PARITY_GATE_FORMAT || "gbrp";

function defaultChrome() {
  const candidate = path.join(os.homedir(), ".cache", "ms-playwright", "chromium-1217", "chrome-linux64", "chrome");
  return existsSync(candidate) ? candidate : undefined;
}

const chrome = process.env.PARITY_CHROME || defaultChrome();
const manifest = fixturesDir && existsSync(path.join(fixturesDir, "manifest.json"))
  ? JSON.parse(readFileSync(path.join(fixturesDir, "manifest.json"), "utf8"))
  : null;

test.use({
  launchOptions: chrome ? { executablePath: chrome } : {},
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
});
test.describe.configure({ mode: "serial" });
test.skip(!manifest, "POTONGIN_PARITY_FIXTURES must name a directory written by scripts/parity/reference_text.py");
test.skip(!settings.username || !settings.password, "E2E_USERNAME and E2E_PASSWORD are required");

function writeJson(name, value) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, name), `${JSON.stringify(value, null, 2)}\n`);
}

async function openHarness(page) {
  await login(page, "/parity-harness");
  await page.waitForFunction(() => window.__parity?.state === "ready" || window.__parity?.state === "error",
    null, { timeout: 60_000 });
  const info = await page.evaluate(() => window.__parity.info());
  expect(info.error ?? null).toBeNull();
  // navigator.userAgent is the device descriptor's; record the browser actually driven.
  return { ...info, browserVersion: page.context().browser()?.version() ?? null, executable: chrome ?? null };
}

// One lane's state: the coverage summary restricted to the lane's colours (fading lanes use
// presence only, because their alpha changes on every frame of a fade).
function laneState(summary, lane) {
  const parts = [];
  for (const color of lane.colors) {
    const entry = summary.colors[color];
    if (lane.fade) parts.push(entry ? `${color}:on` : `${color}:off`);
    else if (entry) parts.push(`${color}:${entry.px}:${entry.box.join(",")}`);
  }
  return parts.join("|");
}

function timingMismatches(clip, summaries) {
  const mismatches = [];
  for (const transition of clip.transitions) {
    const lane = clip.lanes[transition.lane];
    const state = (frame) => laneState(summaries[frame], lane);
    const t = transition.frame;
    const ok = state(t - 1) !== state(t) && state(t - 2) === state(t - 1) && state(t) === state(t + 1);
    if (!ok) {
      mismatches.push({ ...transition, states: [t - 2, t - 1, t, t + 1].map(state) });
    }
  }
  return mismatches;
}

test("the harness page and the fixtures route are closed without a session", async ({ page }) => {
  const route = await page.request.get("/api/parity-fixtures/manifest.json", { failOnStatusCode: false });
  expect([401, 404]).toContain(route.status());
  await page.goto("/parity-harness");
  await expect(page).toHaveURL(/\/login/);
});

test("P-TIME (JASSUB side): every event edge and word onset switches on the plan frame", async ({ page }) => {
  test.setTimeout(300_000);
  const info = await openHarness(page);
  const results = [];
  for (const clip of manifest.clips.filter((item) => item.kind === "ptime")) {
    const frames = [...new Set(clip.transitions.flatMap(({ frame }) => [frame - 3, frame - 2, frame - 1, frame, frame + 1]))]
      .filter((frame) => frame >= 0).sort((a, b) => a - b);
    const summaries = await page.evaluate(({ id, frames: list }) => window.__parity.probe(id, list),
      { id: clip.id, frames });
    const mismatches = timingMismatches(clip, summaries);
    // Negative control: the same check on the libass output one frame late must flag every edge.
    const late = Object.fromEntries(frames.map((frame) => [frame, summaries[frame - 1] ?? summaries[frame]]));
    const lateMismatches = timingMismatches(clip, late).length;
    results.push({
      clip: clip.id,
      fps: clip.fps,
      transitions: clip.transitions.length,
      hazard_transitions: clip.transitions.filter((transition) => transition.hazard).length,
      frames_rendered: frames.length,
      mismatches: mismatches.length,
      control_one_frame_late_mismatches: lateMismatches,
      details: mismatches.slice(0, 10),
    });
  }
  writeJson("p_time_jassub.json", {
    browser: info.browser, browserVersion: info.browserVersion, jassub: info.jassub, clips: results,
  });
  expect(results.length).toBe(5);
  expect(results.reduce((sum, result) => sum + result.mismatches, 0)).toBe(0);
  for (const result of results) expect(result.control_one_frame_late_mismatches).toBe(result.transitions);
});

test("P-TXT: JASSUB composites match the FFmpeg references (plus S-COLOR candidates)", async ({ page }) => {
  test.setTimeout(900_000);
  const info = await openHarness(page);
  const timings = [];
  const leaks = [];
  for (const clip of manifest.clips.filter((item) => item.kind === "ptxt" || item.kind === "pcolor")) {
    for (const frame of clip.probe_frames) {
      const result = await page.evaluate(
        ({ id, frame: n }) => window.__parity.composite(id, n),
        { id: clip.id, frame },
      );
      timings.push({ clip: clip.id, pack: clip.pack, frame, libassMs: result.libassMs, renderMs: result.renderMs });
      for (const [format, png] of Object.entries(result.pngs)) {
        const target = path.join(outDir, "composite", clip.id, format, `${frame}.png`);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, Buffer.from(png, "base64"));
        if (result.outside[format] !== 0) leaks.push({ clip: clip.id, frame, format, px: result.outside[format] });
      }
    }
  }
  writeJson("render_timing.json", {
    browser: info.browser, browserVersion: info.browserVersion, jassub: info.jassub, wasm: info.wasm, frames: timings,
  });
  // Outside the text region the composite must be the plate itself; otherwise the region that
  // the metrics look at would hide a difference.
  expect(leaks).toEqual([]);
  const metricsFile = path.join(outDir, "p_txt.json");
  execFileSync(python, [
    path.join(repoRoot, "scripts", "parity", "compare.py"), "p-txt",
    "--fixtures", fixturesDir, "--browser", outDir, "--out", metricsFile,
  ], { stdio: "inherit" });
  const metrics = JSON.parse(readFileSync(metricsFile, "utf8"));
  const gate = metrics.formats[gateFormat];
  expect(gate, `no P-TXT results for ${gateFormat}`).toBeTruthy();
  expect(gate.gate.failures).toEqual([]);
  expect(gate.gate.pass).toBe(true);
});
