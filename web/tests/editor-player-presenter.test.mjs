// The presenter barrier (plan §6.2 "Clock and presentation"): frame n is presented only when
// every layer for n is ready (plate frame, text bitmap, logo); otherwise the previous frame stays
// up and nothing partial is ever drawn. During playback every output frame that is never
// presented is a drop; drops next to a cut are counted apart (PF-PLAY: 0 at cuts). Also the
// device check (JASSUB p95 over the first 60 frames above 20 ms → "Perangkat lambat").
import assert from "node:assert/strict";
import test from "node:test";

import { createDeviceCheck, percentile } from "../lib/editor/player/device-check.mjs";
import { createPresenter, layersReady } from "../lib/editor/player/presenter.mjs";

test("layers are ready only when plate, text and logo are all ready for the frame", () => {
  assert.equal(layersReady({ plate: true, text: true, logo: true }), true);
  assert.equal(layersReady({ plate: true, text: true, logo: false }), false);
  assert.equal(layersReady({ plate: false, text: true, logo: true }), false);
  assert.equal(layersReady({ plate: true, text: false, logo: true }), false);
  assert.equal(layersReady({}), false);
});

test("a frame whose layers are not all ready is held, never drawn in part", () => {
  const presenter = createPresenter({ cuts: [] });
  assert.equal(presenter.decide(10, { plate: true, text: false, logo: true }), "hold");
  assert.equal(presenter.decide(10, { plate: true, text: true, logo: true }), "present");
  presenter.presented(10);
  assert.equal(presenter.decide(10, { plate: true, text: true, logo: true }), "same");
  assert.equal(presenter.decide(11, { plate: false, text: true, logo: true }), "hold");
  const stats = presenter.stats();
  assert.equal(stats.lastPresented, 10);
  assert.equal(stats.presented, 1);
  assert.equal(stats.holds, 2);
});

test("skipped frames during playback are drops; drops beside a cut are counted apart", () => {
  const presenter = createPresenter({ cuts: [60, 95] });
  presenter.startRun(55);
  for (const n of [55, 56, 57]) presenter.presented(n);
  presenter.presented(60); // 58 and 59 never shown: 59 is the last frame before the cut at 60
  presenter.presented(61);
  presenter.presented(63); // 62 dropped, not next to a cut
  const stats = presenter.stats();
  assert.equal(stats.drops, 3);
  assert.equal(stats.dropsAtCuts, 1);
  assert.deepEqual(stats.dropped, [58, 59, 62]);
  assert.equal(stats.presentedInRun, 6);
});

test("seeks and a new run never count as drops", () => {
  const presenter = createPresenter({ cuts: [60] });
  presenter.startRun(0);
  presenter.presented(0);
  presenter.presented(1);
  presenter.startRun(200); // a seek during playback
  presenter.presented(200);
  presenter.presented(201);
  assert.equal(presenter.stats().drops, 0);
  // Paused presentation (no run) never counts drops either.
  presenter.stopRun();
  presenter.presented(500);
  assert.equal(presenter.stats().drops, 0);
});

test("the first frame of a run is a drop when the run starts later than asked", () => {
  const presenter = createPresenter({ cuts: [2] });
  presenter.startRun(0);
  presenter.presented(3);
  const stats = presenter.stats();
  assert.deepEqual(stats.dropped, [0, 1, 2]);
  assert.equal(stats.dropsAtCuts, 2); // 1 (before the cut at 2) and 2 (the cut frame)
});

test("the dropped list is bounded but the counts are exact", () => {
  const presenter = createPresenter({ cuts: [] });
  presenter.startRun(0);
  presenter.presented(0);
  presenter.presented(5000);
  const stats = presenter.stats();
  assert.equal(stats.drops, 4999);
  assert.ok(stats.dropped.length <= 256);
});

test("percentile is the nearest-rank percentile", () => {
  assert.equal(percentile([], 95), null);
  assert.equal(percentile([5], 95), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
  assert.equal(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95), 95);
});

test("the device check decides once, after 60 frames, on the p95 against 20 ms", () => {
  const fast = createDeviceCheck();
  for (let i = 0; i < 59; i += 1) assert.equal(fast.add(3), null);
  assert.deepEqual(fast.add(3), { slow: false, p95: 3, frames: 60 });
  assert.equal(fast.add(500), null); // decided: later frames do not change the verdict
  assert.equal(fast.slow, false);

  const slow = createDeviceCheck({ frames: 20, thresholdMs: 20 });
  let verdict = null;
  for (let i = 0; i < 20; i += 1) verdict = slow.add(i < 18 ? 5 : 40) ?? verdict;
  assert.deepEqual(verdict, { slow: true, p95: 40, frames: 20 });
  assert.equal(slow.slow, true);

  const edge = createDeviceCheck({ frames: 20, thresholdMs: 20 });
  for (let i = 0; i < 20; i += 1) verdict = edge.add(20) ?? verdict;
  assert.equal(edge.slow, false); // "exceeds 20 ms": exactly 20 is not slow
});
