// T2.6: timeline geometry and word-snapped trimming (plan Appendix C.3, §3.6 bounds, Appendix B
// TrimStart/TrimEnd) in web/components/editor/timeline/timeline-model.mjs.
import assert from "node:assert/strict";
import test from "node:test";

import {
  cutMarkers,
  edgeFrames,
  fitZoom,
  hookDurationBounds,
  hookDurationFromPx,
  pendingBands,
  pieceBlocks,
  rulerTicks,
  snapTrim,
  stepTrim,
  wordForTrimAt,
  zoomAround,
} from "../components/editor/timeline/timeline-model.mjs";

const F30 = [30, 1];

// 20 words of 400 ms with 200 ms gaps from 10 s: bounds at 300, 315 + 18·(i−1), …, 654.
function words30() {
  const words = Array.from({ length: 20 }, (_, i) => ({
    id: `w${String(i).padStart(6, "0")}`, s: 10_000 + 600 * i, e: 10_400 + 600 * i, t: `kata${i}`, p_pm: 900, u: null, z: false,
  }));
  const bounds = [{ after: null, before: words[0].id, sf: 300, tight: false, rms_cdb: null }];
  for (let i = 1; i < words.length; i += 1) {
    bounds.push({ after: words[i - 1].id, before: words[i].id, sf: 297 + 18 * i, tight: false, rms_cdb: -5000 });
  }
  bounds.push({ after: words.at(-1).id, before: null, sf: 654, tight: false, rms_cdb: null });
  return { schema: "potongin.words/1", fps: F30, window_ms: [0, 100_000], words, bounds };
}

function doc30({ inSf = 315, outSf = 600, windowMs = [0, 100_000] } = {}) {
  return {
    output: { w: 720, h: 1280, fps: F30 },
    base: { window_ms: windowMs },
    main: { segments: [{ id: "seg_b1", role: "body", in_sf: inSf, out_sf: outSf }], removals: [], joins: [], cut_fade_ms: 8 },
  };
}

const W = (i) => `w${String(i).padStart(6, "0")}`;

test("a start trim snaps to the nearest bounds frame and names the first kept word", () => {
  assert.deepEqual(snapTrim({ edge: "start", sf: 305, words: words30(), doc: doc30() }), { sf: 300, gapWord: W(0) });
  assert.deepEqual(snapTrim({ edge: "start", sf: 400, words: words30(), doc: doc30() }), { sf: 405, gapWord: W(6) });
  assert.deepEqual(snapTrim({ edge: "start", sf: 10, words: words30(), doc: doc30() }), { sf: 300, gapWord: W(0) });
});

test("an end trim snaps to the nearest bounds frame and names the last kept word", () => {
  assert.deepEqual(snapTrim({ edge: "end", sf: 640, words: words30(), doc: doc30() }), { sf: 639, gapWord: W(18) });
  assert.deepEqual(snapTrim({ edge: "end", sf: 700, words: words30(), doc: doc30() }), { sf: 654, gapWord: W(19) });
});

test("snapping keeps the body at least 3 s long and inside the analysis window", () => {
  assert.deepEqual(snapTrim({ edge: "start", sf: 560, words: words30(), doc: doc30() }), { sf: 495, gapWord: W(11) });
  assert.deepEqual(snapTrim({ edge: "end", sf: 330, words: words30(), doc: doc30() }), { sf: 405, gapWord: W(5) });
  const narrow = doc30({ windowMs: [10_000, 20_000] });
  assert.deepEqual(snapTrim({ edge: "end", sf: 700, words: words30(), doc: narrow }), { sf: 585, gapWord: W(15) });
  assert.equal(snapTrim({ edge: "start", sf: 400, words: { ...words30(), bounds: [] }, doc: doc30() }), null);
  assert.equal(snapTrim({ edge: "middle", sf: 400, words: words30(), doc: doc30() }), null);
});

test("keyboard steps move an edge to the adjacent word gap", () => {
  assert.deepEqual(stepTrim({ edge: "start", direction: -1, words: words30(), doc: doc30() }), { sf: 300, gapWord: W(0) });
  assert.deepEqual(stepTrim({ edge: "start", direction: 1, words: words30(), doc: doc30() }), { sf: 333, gapWord: W(2) });
  assert.deepEqual(stepTrim({ edge: "end", direction: 1, words: words30(), doc: doc30() }), { sf: 603, gapWord: W(16) });
  assert.deepEqual(stepTrim({ edge: "end", direction: -1, words: words30(), doc: doc30() }), { sf: 585, gapWord: W(15) });
  assert.equal(stepTrim({ edge: "start", direction: -1, words: words30(), doc: doc30({ inSf: 300 }) }), null);
  assert.equal(stepTrim({ edge: "end", direction: 1, words: words30(), doc: doc30({ outSf: 654 }) }), null);
});

test("I and O at the playhead pick the word under it (or the next/previous one)", () => {
  const plan = { fps: F30, pieces: [{ i: 0, seg: "seg_b1", role: "body", inSf: 315, outSf: 600, outF0: 0, frames: 285 }] };
  assert.equal(wordForTrimAt({ edge: "start", frame: 0, plan, words: words30() }), W(1));
  assert.equal(wordForTrimAt({ edge: "end", frame: 0, plan, words: words30() }), W(0));
  assert.equal(wordForTrimAt({ edge: "start", frame: 30, plan, words: words30() }), W(2));
  assert.equal(wordForTrimAt({ edge: "end", frame: 30, plan, words: words30() }), W(2));
  assert.equal(wordForTrimAt({ edge: "start", frame: 9_999, plan, words: words30() }), null);
  assert.equal(wordForTrimAt({ edge: "end", frame: 0, plan: { fps: F30, pieces: [] }, words: words30() }), null);
});

const PLAN = {
  fps: [30000, 1001], totalFrames: 1100,
  pieces: [
    { i: 0, seg: "seg_co", role: "cold_open", inSf: 38210, outSf: 38345, outF0: 0, frames: 135 },
    { i: 1, seg: "seg_b1", role: "body", inSf: 37215, outSf: 37483, outF0: 135, frames: 268 },
    { i: 2, seg: "seg_b1", role: "body", inSf: 37556, outSf: 38253, outF0: 403, frames: 697 },
  ],
};

test("pieces become blocks; a cold-open join and a jump cut become markers", () => {
  assert.deepEqual(pieceBlocks(PLAN).map((block) => [block.role, block.f0, block.f1]),
    [["cold_open", 0, 135], ["body", 135, 403], ["body", 403, 1100]]);
  assert.deepEqual(cutMarkers(PLAN), [{ f: 135, kind: "join" }, { f: 403, kind: "cut" }]);
  assert.deepEqual(edgeFrames(PLAN), { startF: 135, endF: 1100 });
  assert.deepEqual(cutMarkers({ pieces: [] }), []);
  assert.equal(edgeFrames({ pieces: [] }), null);
});

test("plate cells that are still building map to hatched output ranges", () => {
  const plan = {
    pieces: [{ i: 0, seg: "seg_b1", role: "body", inSf: 100, outSf: 250, outF0: 0, frames: 150 },
      { i: 1, seg: "seg_b1", role: "body", inSf: 400, outSf: 430, outF0: 150, frames: 30 }],
    plate: { cellFrames: 60, cells: [{ k: 1, state: "ready" }, { k: 2, state: "queued" }, { k: 3, state: "building" },
      { k: 4, state: "ready" }, { k: 6, state: "queued" }, { k: 7, state: "queued" }] },
  };
  assert.deepEqual(pendingBands(plan), [{ f0: 20, f1: 140 }, { f0: 150, f1: 170 }, { f0: 170, f1: 180 }].reduce((merged, band) => {
    const last = merged.at(-1);
    if (last && band.f0 <= last.f1) last.f1 = Math.max(last.f1, band.f1);
    else merged.push({ ...band });
    return merged;
  }, []));
  assert.deepEqual(pendingBands({ pieces: plan.pieces, plate: { cellFrames: 60, cells: [] } }), []);
  assert.deepEqual(pendingBands({ pieces: [], plate: null }), []);
});

test("ruler ticks keep at least 64 px apart and label source-accurate seconds", () => {
  const ticks = rulerTicks({ totalFrames: 1811, fps: [30000, 1001], pxPerFrame: 2 });
  assert.equal(ticks.length, 31);
  assert.deepEqual(ticks.slice(0, 3).map((tick) => tick.label), ["00:00", "00:02", "00:04"]);
  assert.ok(Math.abs(ticks[1].f - 60000 / 1001) < 1e-9);
  for (let i = 1; i < ticks.length; i += 1) assert.ok((ticks[i].f - ticks[i - 1].f) * 2 >= 64);
  const wide = rulerTicks({ totalFrames: 300 * 30, fps: F30, pxPerFrame: 0.05 });
  assert.ok(wide.length >= 2);
  assert.equal(wide[1].label, "01:00");
  assert.deepEqual(rulerTicks({ totalFrames: 0, fps: F30, pxPerFrame: 1 }), []);
});

test("zoom fits the clip and keeps the frame under the pointer", () => {
  assert.ok(Math.abs(fitZoom(1811, 1000) - 1000 / 1811) < 1e-12);
  assert.equal(fitZoom(10, 100_000), 16, "clamped high");
  assert.equal(fitZoom(1_000_000, 100), 0.02, "clamped low");
  assert.equal(fitZoom(0, 500), 1);
  const next = zoomAround({ pxPerFrame: 1, factor: 2, anchorPx: 100, scrollLeft: 300 });
  assert.deepEqual(next, { pxPerFrame: 2, scrollLeft: 700 });
  assert.equal(zoomAround({ pxPerFrame: 16, factor: 2, anchorPx: 0, scrollLeft: 0 }).pxPerFrame, 16);
  assert.equal(zoomAround({ pxPerFrame: 1, factor: 0.5, anchorPx: 10, scrollLeft: 0 }).scrollLeft, 0, "never negative");
});

test("the hook duration handle stays inside the §3.3 range", () => {
  assert.deepEqual(hookDurationBounds([30000, 1001]), { min: 15, max: 899 });
  assert.deepEqual(hookDurationBounds([25, 1]), { min: 15, max: 750 });
  assert.equal(hookDurationFromPx({ px: 240, pxPerFrame: 2, fps: [30000, 1001] }), 120);
  assert.equal(hookDurationFromPx({ px: 3, pxPerFrame: 2, fps: [30000, 1001] }), 15);
  assert.equal(hookDurationFromPx({ px: 99_999, pxPerFrame: 2, fps: [30000, 1001] }), 899);
});
