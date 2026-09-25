// Browser player gates (plan §10.1 P-FRAME, P-TIME, P-TXT, P-LOGO, P-AUD (browser half), P-SYNC;
// §10.3 PF-SEEK, PF-PLAY, PF-LIBASS, PF-MEM; §11.2 T2.4), measured through createPlayer in the
// pinned browser.
//
// Prerequisites:
//   1. Fixtures made in the toolchain image (plate cells, mixes, reference PCM, server
//      composites, truth frames, the auto render):
//        scripts/parity/player_fixtures.py generate --out <dir>
//      (writes <dir>/player/manifest.json; see the script's docstring for the docker command).
//   2. A server started with POTONGIN_PARITY_HARNESS=1 and POTONGIN_PARITY_FIXTURES=<dir>, plus
//      E2E_USERNAME/E2E_PASSWORD (as for web/e2e/parity-text.spec.mjs).
//   3. npx playwright test e2e/editor-player.spec.mjs --project=desktop-chromium
//
// The browser is Chrome for Testing 147.0.7727.15 (Playwright build 1217); PARITY_CHROME
// overrides the executable. Audio output is muted (headless Chrome cannot "hear"; P-SYNC is the
// instrumented probe of plan §10.1). Results go to PARITY_OUT_DIR/player/*.json; composites are
// scored by player_fixtures.py score and the evidence written by player_fixtures.py evidence.
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { login, settings } from "./support/harness.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixturesDir = process.env.POTONGIN_PARITY_FIXTURES || "";
const outDir = path.join(process.env.PARITY_OUT_DIR || path.join(os.tmpdir(), `potongin-parity-${process.pid}`), "player");
const python = process.env.PARITY_PYTHON || "python3";

function defaultChrome() {
  const candidate = path.join(os.homedir(), ".cache", "ms-playwright", "chromium-1217", "chrome-linux64", "chrome");
  return existsSync(candidate) ? candidate : undefined;
}

const chrome = process.env.PARITY_CHROME || defaultChrome();
const manifestPath = fixturesDir ? path.join(fixturesDir, "player", "manifest.json") : "";
const manifest = manifestPath && existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;

// Plan §10.1 / §10.3 thresholds (never weakened here).
const P_FRAME_MIN_FRAMES = 2_000;
const P_SYNC_MAX_FRAMES_P99 = 1;
const PF_SEEK_P95_MS = 50;
const PF_LIBASS_P95_MS = 12;
const PF_MEM_MAX_BYTES = 1.2e9;
const PF_PLAY_MAX_DROPS_PER_10S = 1;
const P_AUD_MAX_LSB = 1;

test.use({
  launchOptions: {
    ...(chrome ? { executablePath: chrome } : {}),
    args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  },
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 1,
});
test.describe.configure({ mode: "serial" });
test.skip(!manifest, "POTONGIN_PARITY_FIXTURES must hold player/manifest.json (scripts/parity/player_fixtures.py generate)");
test.skip(!settings.username || !settings.password, "E2E_USERNAME and E2E_PASSWORD are required");

function writeJson(name, value) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, name), `${JSON.stringify(value, null, 2)}\n`);
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((sorted.length * p) / 100) - 1)];
}

const cases = (kind) => manifest.cases.filter((item) => item.kind === kind);

async function openHarness(page) {
  await login(page, "/parity-harness/player");
  await page.waitForFunction(() => window.__player?.state === "ready" || window.__player?.state === "error",
    null, { timeout: 60_000 });
  const info = await page.evaluate(() => window.__player.info());
  expect(info.error ?? null).toBeNull();
  return { ...info, browserVersion: page.context().browser()?.version() ?? null, executable: chrome ?? null };
}

test("the player harness and its fixtures are closed without a session", async ({ page }) => {
  const route = await page.request.get("/api/parity-fixtures/player/manifest.json", { failOnStatusCode: false });
  expect([401, 404]).toContain(route.status());
  await page.goto("/parity-harness/player");
  await expect(page).toHaveURL(/\/login/);
});

test("P-FRAME: the source frame and crop read back from the canvas equal the grid, every frame", async ({ page }) => {
  test.setTimeout(900_000);
  const info = await openHarness(page);
  const results = [];
  for (const item of cases("pframe")) {
    await page.evaluate((id) => window.__player.open(id), item.id);
    const outcome = await page.evaluate(({ total, crop }) => window.__player.readFrames(
      Array.from({ length: total }, (_, n) => n), { crop }), { total: item.total_frames, crop: item.expected.crop_x !== null });
    let mismatches = 0;
    let cropMismatches = 0;
    let unpresented = 0;
    const details = [];
    outcome.frames.forEach((frame, n) => {
      if (!frame.presented) unpresented += 1;
      const want = item.expected.index[n];
      if (frame.index === null || frame.index !== want) {
        mismatches += 1;
        if (details.length < 10) details.push({ n, want, got: frame.index });
      }
      if (item.expected.crop_x !== null && frame.cropX !== item.expected.crop_x[n]) cropMismatches += 1;
    });
    results.push({ case: item.id, fps: item.fps, layout: item.layout, vfr: item.vfr, pieces: item.pieces,
      frames: outcome.frames.length, mismatches, crop_x_checked: item.expected.crop_x !== null ? outcome.frames.length : 0,
      crop_x_mismatches: cropMismatches, unpresented, details, seek_ms: outcome.seekMs });
  }
  const totals = { frames: results.reduce((sum, r) => sum + r.frames, 0),
    mismatches: results.reduce((sum, r) => sum + r.mismatches + r.crop_x_mismatches + r.unpresented, 0) };
  writeJson("p_frame.json", { browser: info.browserVersion, executable: info.executable, cases: results, totals });
  expect(totals.frames).toBeGreaterThanOrEqual(P_FRAME_MIN_FRAMES);
  expect(results.filter((r) => r.layout !== "fit_blur").every((r) => r.crop_x_checked > 0)).toBe(true);
  expect(totals.mismatches).toBe(0);
});

test("P-TIME: every event edge and word onset switches on the plan frame through the player", async ({ page }) => {
  test.setTimeout(600_000);
  const info = await openHarness(page);
  const results = [];
  for (const item of cases("ptime")) {
    await page.evaluate((id) => window.__player.open(id), item.id);
    const frames = [...new Set(item.transitions.flatMap(({ frame }) => [frame - 2, frame - 1, frame, frame + 1]))]
      .filter((frame) => frame >= 0 && frame < item.total_frames).sort((a, b) => a - b);
    const states = await page.evaluate(({ list, lanes }) => window.__player.laneStates(list, lanes),
      { list: frames, lanes: item.lanes });
    const check = (shift) => {
      const bad = [];
      for (const transition of item.transitions) {
        const state = (frame) => states[String(frame + shift)]?.[transition.lane] ?? null;
        const t = transition.frame;
        const ok = state(t - 1) !== state(t) && state(t - 2) === state(t - 1) && state(t) === state(t + 1);
        if (!ok) bad.push({ ...transition, states: [t - 2, t - 1, t, t + 1].map(state) });
      }
      return bad;
    };
    const mismatches = check(0);
    // Negative control: the same check one frame late must flag every edge that has room.
    const late = item.transitions.filter(({ frame }) => frame >= 3).length;
    const lateFlagged = check(-1).filter(({ frame }) => frame >= 3).length;
    results.push({ case: item.id, fps: item.fps, transitions: item.transitions.length,
      hazard_transitions: item.transitions.filter((t) => t.hazard).length, frames_rendered: frames.length,
      mismatches: mismatches.length, control_one_frame_late_flagged: lateFlagged, control_edges: late,
      details: mismatches.slice(0, 10) });
  }
  writeJson("p_time.json", { browser: info.browserVersion, jassub: info.jassub, cases: results });
  expect(results.length).toBe(5);
  expect(results.reduce((sum, r) => sum + r.mismatches, 0)).toBe(0);
  for (const r of results) expect(r.control_one_frame_late_flagged).toBe(r.control_edges);
});

test("P-TXT and P-LOGO: the player's canvas against the server composite of the same plate frame", async ({ page }) => {
  test.setTimeout(900_000);
  const info = await openHarness(page);
  const written = [];
  for (const item of cases("pframe").filter((entry) => entry.variants.length)) {
    for (const variant of item.variants) {
      await page.evaluate(({ id, v }) => window.__player.open(id, v), { id: item.id, v: variant.id });
      const shots = await page.evaluate((frames) => window.__player.composite(frames), variant.probe_frames);
      for (const shot of shots) {
        expect(shot.presented, `${item.id}/${variant.id} frame ${shot.frame}`).toBe(true);
        const target = path.join(outDir, "composite", item.id, variant.id, `${shot.frame}.png`);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, Buffer.from(shot.png, "base64"));
        written.push(target);
      }
    }
  }
  writeJson("composite_run.json", { browser: info.browserVersion, files: written.length });
  const scoreFile = path.join(outDir, "scores.json");
  execFileSync(python, [path.join(repoRoot, "scripts", "parity", "player_fixtures.py"), "score",
    "--fixtures", fixturesDir, "--browser", outDir, "--out", scoreFile], { stdio: "inherit" });
  const scores = JSON.parse(readFileSync(scoreFile, "utf8"));
  expect(scores.p_txt.frames).toBeGreaterThanOrEqual(30);
  expect(scores.p_txt.failures).toEqual([]);
  expect(scores.p_logo.frames).toBeGreaterThanOrEqual(5);
  expect(scores.p_logo.failures).toEqual([]);
});

test("P-AUD (browser half): the AudioBuffer of the mix equals the reference PCM", async ({ page }) => {
  test.setTimeout(300_000);
  const info = await openHarness(page);
  const results = [];
  for (const item of cases("pframe").filter((entry) => entry.pcm)) {
    await page.evaluate((id) => window.__player.open(id), item.id);
    results.push({ case: item.id, ...(await page.evaluate(() => window.__player.audioCheck())) });
  }
  writeJson("p_aud.json", { browser: info.browserVersion, cases: results });
  expect(results.length).toBeGreaterThanOrEqual(4);
  for (const r of results) {
    expect(r.contextRate).toBe(48000);
    expect(r.bufferRate).toBe(48000);
    expect(r.length).toBe(r.referenceLength);
    expect(r.length).toBe(r.planSamples);
    expect(r.maxDiffLsb).toBeLessThanOrEqual(P_AUD_MAX_LSB);
  }
});

test("P-SYNC and PF-PLAY: instrumented playback on 20-cut clips", async ({ page }) => {
  test.setTimeout(600_000);
  const info = await openHarness(page);
  const results = [];
  for (const item of cases("pframe").filter((entry) => entry.play)) {
    await page.evaluate((id) => window.__player.open(id), item.id);
    const run = await page.evaluate(() => window.__player.playProbe({ fromFrame: 0 }));
    const errors = [];
    let pixelMismatches = 0;
    for (const sample of run.samples) {
      if (sample.index !== item.expected.index[sample.frame]) pixelMismatches += 1;
      // Audio heard at presentation vs the frame on screen: distance from the frame's centre.
      errors.push(Math.abs(sample.audioFrames - (sample.frame + 0.5)));
    }
    const seconds = run.samples.length ? (run.lastFrame - run.firstFrame + 1) / (item.fps[0] / item.fps[1]) : 0;
    results.push({ case: item.id, fps: item.fps, cuts: item.pieces - 1, presented: run.samples.length,
      pixel_mismatches: pixelMismatches, drops: run.stats.drops, drops_at_cuts: run.stats.dropsAtCuts,
      dropped: run.stats.dropped.slice(0, 20), seconds, drops_per_10s: seconds ? (run.stats.drops * 10) / seconds : null,
      sync_error_frames: { p50: percentile(errors, 50), p99: percentile(errors, 99), max: Math.max(...errors) },
      clock: run.clock, holds: run.stats.holds, first_frame: run.firstFrame, last_frame: run.lastFrame });
  }
  writeJson("p_sync_pf_play.json", { browser: info.browserVersion, loadavg: os.loadavg(), cases: results });
  expect(results.length).toBeGreaterThanOrEqual(3);
  for (const r of results) {
    expect(r.presented).toBeGreaterThan(0);
    expect(r.pixel_mismatches).toBe(0);
    expect(r.sync_error_frames.p99).toBeLessThanOrEqual(P_SYNC_MAX_FRAMES_P99);
    expect(r.drops_at_cuts).toBe(0);
    expect(r.drops_per_10s).toBeLessThanOrEqual(PF_PLAY_MAX_DROPS_PER_10S);
  }
});

test("PF-SEEK: a paused seek puts the frame on screen within 50 ms p95", async ({ page }) => {
  test.setTimeout(300_000);
  const info = await openHarness(page);
  const all = [];
  const results = [];
  for (const item of cases("pframe")) {
    await page.evaluate((id) => window.__player.open(id), item.id);
    const run = await page.evaluate((total) => window.__player.seekBench({ count: 60, total, seed: 7 }), item.total_frames);
    all.push(...run.ms);
    results.push({ case: item.id, seeks: run.ms.length, p50: percentile(run.ms, 50), p95: percentile(run.ms, 95),
      max: Math.max(...run.ms), cold: run.cold });
  }
  const summary = { seeks: all.length, p50: percentile(all, 50), p95: percentile(all, 95), max: Math.max(...all) };
  writeJson("pf_seek.json", { browser: info.browserVersion, loadavg: os.loadavg(), summary, cases: results });
  expect(summary.seeks).toBeGreaterThanOrEqual(300);
  expect(summary.p95).toBeLessThanOrEqual(PF_SEEK_P95_MS);
});

test("PF-LIBASS: the Bold pack's changed frames render within 12 ms p95", async ({ page }) => {
  test.setTimeout(300_000);
  const info = await openHarness(page);
  const item = manifest.cases.find((entry) => entry.libass);
  await page.evaluate(({ id, v }) => window.__player.open(id, v), { id: item.id, v: item.libass });
  const run = await page.evaluate(() => window.__player.playProbe({ fromFrame: 0, pixels: false }));
  const changed = run.text.changedTotalMs;
  const summary = { changed_frames: changed.length, p50: percentile(changed, 50), p95: percentile(changed, 95),
    max: Math.max(...changed), libass_p95: percentile(run.text.changedLibassMs, 95),
    unchanged_frames: run.text.unchanged, slow_device: run.slow };
  writeJson("pf_libass.json", { browser: info.browserVersion, case: item.id, variant: item.libass, loadavg: os.loadavg(), summary });
  expect(summary.changed_frames).toBeGreaterThan(20);
  expect(summary.p95).toBeLessThanOrEqual(PF_LIBASS_P95_MS);
});

async function tabMemory(page) {
  const session = await page.context().browser().newBrowserCDPSession();
  try {
    const { processInfo } = await session.send("SystemInfo.getProcessInfo");
    const out = [];
    for (const proc of processInfo) {
      if (!["renderer", "GPU"].includes(proc.type)) continue;
      try {
        const rollup = readFileSync(`/proc/${proc.id}/smaps_rollup`, "utf8");
        const pss = Number(/^Pss:\s+(\d+) kB/m.exec(rollup)?.[1] ?? 0) * 1024;
        const rss = Number(/^Rss:\s+(\d+) kB/m.exec(rollup)?.[1] ?? 0) * 1024;
        out.push({ type: proc.type, pid: proc.id, pss, rss });
      } catch {
        out.push({ type: proc.type, pid: proc.id, pss: null, rss: null });
      }
    }
    return out;
  } finally {
    await session.detach();
  }
}

test("PF-MEM: the editor tab stays under 1.2 GB on a 300 s clip", async ({ page }) => {
  test.setTimeout(600_000);
  const info = await openHarness(page);
  const item = cases("long")[0];
  expect(item.total_frames * item.fps[1] / item.fps[0]).toBeGreaterThanOrEqual(300);
  let peak = { total: 0 };
  const sample = async (phase) => {
    const procs = await tabMemory(page);
    const total = procs.reduce((sum, proc) => sum + (proc.pss ?? 0), 0);
    if (total > peak.total) peak = { total, phase, procs };
    return total;
  };
  await sample("before");
  await page.evaluate((id) => window.__player.open(id), item.id);
  await sample("opened");
  const phases = [];
  const run = page.evaluate(({ total }) => window.__player.memoryWorkout({ total, seeks: 40, playSeconds: 20, seed: 11 }), { total: item.total_frames });
  let finished = false;
  run.finally(() => { finished = true; });
  while (!finished) {
    phases.push(await sample("workout"));
    await page.waitForTimeout(500);
  }
  const workout = await run;
  await sample("after");
  writeJson("pf_mem.json", { browser: info.browserVersion, case: item.id, seconds: item.total_frames * item.fps[1] / item.fps[0],
    peak_bytes: peak.total, peak_phase: peak.phase, processes: peak.procs, samples: phases.length, workout });
  expect(workout.audioSeconds).toBeGreaterThanOrEqual(300);
  expect(peak.total).toBeLessThanOrEqual(PF_MEM_MAX_BYTES);
});

test("truth frames are drawn exactly; revision 0 falls back to the auto render frame for frame", async ({ page }) => {
  test.setTimeout(300_000);
  const info = await openHarness(page);
  const item = manifest.cases.find((entry) => entry.truth);
  await page.evaluate((id) => window.__player.open(id), item.id);
  const truth = await page.evaluate((frames) => window.__player.truthCheck(frames), item.truth.frames);
  for (const result of truth) {
    expect(result.mode).toBe("truth");
    expect(result.maxDiff).toBe(0);
  }
  await page.evaluate(({ id }) => window.__player.open(id, null, { rev0Fallback: true }), { id: item.id });
  const fallback = await page.evaluate((frames) => window.__player.fallbackCheck(frames), item.truth.fallback_frames);
  let mismatches = 0;
  for (const result of fallback.frames) {
    if (result.index !== item.expected.index[result.frame]) mismatches += 1;
  }
  writeJson("truth_fallback.json", { browser: info.browserVersion, truth, fallback: { ...fallback, mismatches } });
  expect(fallback.mode).toBe("auto_render");
  expect(fallback.frames.length).toBeGreaterThanOrEqual(10);
  expect(mismatches).toBe(0);
  expect(fallback.liveAfterCells).toBe("live");
});
