// Player frame mapping (plan §6.2 "Plate source"): output frame → piece (binary search on
// outF0) → source-grid frame → plate cell k = ⌊sf / cellFrames⌋, index j = sf mod cellFrames →
// the sample at (j + 0.5)·den/num inside the cell; and the decode-ahead schedule, which follows
// the output order across jumps and reaches every cut at least 500 ms before it is shown.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  cellFramesFor,
  cellOf,
  cutFrames,
  decodeSchedule,
  frameAt,
  frameStart,
  outToSrc,
  pieceIndexAt,
  preRollFrames,
  sampleIndex,
  sampleTimestamp,
  smp,
  totalFrames,
  upcoming,
} from "../lib/editor/player/frame-map.mjs";

const vectors = JSON.parse(readFileSync(
  new URL("../../tests/fixtures/edit_v2/timemap-vectors.json", import.meta.url), "utf8",
));

test("output frame → piece and source frame equals every time-map vector", () => {
  let checked = 0;
  for (const vector of vectors.cases) {
    assert.equal(totalFrames(vector.pieces), vector.total_frames, vector.name);
    for (const [n, i, sf] of vector.out_to_src) {
      assert.equal(pieceIndexAt(vector.pieces, n), i, `${vector.name} frame ${n}`);
      assert.deepEqual(outToSrc(vector.pieces, n), { i, sf }, `${vector.name} frame ${n}`);
      checked += 1;
    }
    assert.equal(outToSrc(vector.pieces, vector.total_frames), null);
    assert.equal(outToSrc(vector.pieces, -1), null);
  }
  assert.ok(checked >= 200, `only ${checked} vectors`);
});

test("every frame of every vector case maps like a frame-by-frame expansion", () => {
  for (const vector of vectors.cases) {
    const expanded = [];
    for (const piece of vector.pieces) {
      for (let sf = piece.inSf; sf < piece.outSf; sf += 1) expanded.push([piece.i, sf]);
    }
    for (let n = 0; n < expanded.length; n += 1) {
      const got = outToSrc(vector.pieces, n);
      assert.equal(got.i, expanded[n][0]);
      assert.equal(got.sf, expanded[n][1]);
    }
  }
});

test("cell size, samples and ms↔frame helpers match the Python time map", () => {
  for (const { in: [num, den], expect } of vectors.cell_frames) assert.equal(cellFramesFor([num, den]), expect);
  for (const { in: [num, den, n, rate], expect } of vectors.smp) assert.equal(smp(n, [num, den], rate), expect);
  assert.deepEqual(cellOf(38210, 60), { k: 636, j: 50 });
  assert.deepEqual(cellOf(0, 48), { k: 0, j: 0 });
  assert.deepEqual(cellOf(47, 48), { k: 0, j: 47 });
  assert.deepEqual(cellOf(48, 48), { k: 1, j: 0 });
});

test("the sample time inside a cell is the middle of frame j and reads back to j", () => {
  for (const fps of [[24, 1], [25, 1], [30, 1], [24000, 1001], [30000, 1001]]) {
    const cell = cellFramesFor(fps);
    for (let j = 0; j < cell; j += 1) {
      const t = sampleTimestamp(j, fps);
      assert.ok(Math.abs(t - ((j + 0.5) * fps[1]) / fps[0]) < 1e-12);
      // Decoders report the frame's own start time j·den/num (float), which must read back to j.
      assert.equal(sampleIndex((j * fps[1]) / fps[0], fps), j, `${fps} j=${j}`);
      assert.equal(sampleIndex(t, fps), j, `${fps} mid j=${j}`);
    }
  }
});

test("the clock position maps to the frame whose interval contains it", () => {
  for (const fps of [[24, 1], [25, 1], [30, 1], [24000, 1001], [30000, 1001]]) {
    for (let n = 0; n < 5000; n += 7) {
      const start = frameStart(n, fps);
      assert.equal(frameAt(start, fps), n, `${fps} start of ${n}`);
      assert.equal(frameAt(start + (0.999 * fps[1]) / fps[0], fps), n, `${fps} end of ${n}`);
      assert.equal(frameAt(start + (1.001 * fps[1]) / fps[0], fps), n + 1);
    }
  }
  assert.equal(frameAt(-0.01, [30, 1]), 0);
});

const JUMPY = [
  { i: 0, seg: "seg_co", role: "cold_open", inSf: 330, outSf: 390, outF0: 0, frames: 60 },
  { i: 1, seg: "seg_b1", role: "body", inSf: 30, outSf: 65, outF0: 60, frames: 35 },
  { i: 2, seg: "seg_b1", role: "body", inSf: 66, outSf: 99, outF0: 95, frames: 33 },
  { i: 3, seg: "seg_b1", role: "body", inSf: 102, outSf: 132, outF0: 128, frames: 30 },
];

test("cut frames are the first output frame of every piece after the first", () => {
  assert.deepEqual(cutFrames(JUMPY), [60, 95, 128]);
  assert.deepEqual(cutFrames(JUMPY.slice(0, 1)), []);
});

test("upcoming frames follow the output order across jumps", () => {
  const frames = upcoming(JUMPY, 58, 4, 60);
  assert.deepEqual(frames.map(({ n, sf, k, j }) => [n, sf, k, j]), [
    [58, 388, 6, 28], [59, 389, 6, 29], [60, 30, 0, 30], [61, 31, 0, 31],
  ]);
  assert.deepEqual(upcoming(JUMPY, 156, 10, 60).map(({ n }) => n), [156, 157]);
});

test("the decode schedule lists cells in first-need order with the frames needed", () => {
  // n 50..59 are cold-open frames sf 380..389 (cell 6); n 60..79 jump back to sf 30..49 (cell 0).
  const range = (a, b) => Array.from({ length: b - a }, (_, index) => a + index);
  assert.deepEqual(decodeSchedule(JUMPY, 50, { cellFrames: 60, aheadFrames: 30 }), [
    { k: 6, js: range(20, 30), firstN: 50 },
    { k: 0, js: range(30, 50), firstN: 60 },
  ]);
});

test("a cut is scheduled at least 500 ms before it is shown, whatever the jump", () => {
  for (const fps of [[24000, 1001], [25, 1], [30000, 1001], [30, 1]]) {
    const cellFrames = cellFramesFor(fps);
    const preRoll = preRollFrames(fps, 500);
    assert.equal(preRoll, Math.ceil((500 * fps[0]) / (1000 * fps[1])));
    const aheadFrames = preRoll + 1;
    for (const cut of cutFrames(JUMPY)) {
      const target = outToSrc(JUMPY, cut);
      const at = cut - preRoll;
      const schedule = decodeSchedule(JUMPY, at, { cellFrames, aheadFrames });
      const cell = cellOf(target.sf, cellFrames);
      const entry = schedule.find((item) => item.k === cell.k);
      assert.ok(entry && entry.js.includes(cell.j), `${fps} cut ${cut} not scheduled at ${at}`);
    }
  }
});

test("frames already cached are left out of the schedule", () => {
  const cached = new Set(["6:20", "6:21", "0:30"]);
  const schedule = decodeSchedule(JUMPY, 50, { cellFrames: 60, aheadFrames: 12, has: (k, j) => cached.has(`${k}:${j}`) });
  assert.deepEqual(schedule, [
    { k: 6, js: [22, 23, 24, 25, 26, 27, 28, 29], firstN: 52 },
    { k: 0, js: [31], firstN: 61 },
  ]);
});

test("a cell needed twice in the window keeps one entry with the union of its frames", () => {
  const pieces = [
    { i: 0, seg: "seg_co", role: "cold_open", inSf: 70, outSf: 75, outF0: 0, frames: 5 },
    { i: 1, seg: "seg_b1", role: "body", inSf: 60, outSf: 72, outF0: 5, frames: 12 },
  ];
  const schedule = decodeSchedule(pieces, 0, { cellFrames: 60, aheadFrames: 17 });
  assert.deepEqual(schedule, [{ k: 1, js: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14], firstN: 0 }]);
});
