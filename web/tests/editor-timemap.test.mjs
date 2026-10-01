// web/lib/editor/timemap.mjs mirrors src/ai_clipper/edit_v2/timemap.py (plan §3.4, Appendix A.2);
// both are checked against the same vectors (tests/fixtures/edit_v2/timemap-vectors.json,
// ≥ 500 checks; CONTRACTS §5.12).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  MIN_PIECE_FRAMES,
  SAMPLE_RATE,
  cellFrames,
  divRoundHalfUp,
  floorDiv,
  logoBox,
  nowMs,
  outToSrc,
  pieces,
  safeCs,
  sfCeil,
  sfFloor,
  smp,
  speechSpans,
  srcToOut,
  totalFrames,
  wordFrames,
} from "../lib/editor/timemap.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const VECTORS = JSON.parse(readFileSync(path.join(root, "tests", "fixtures", "edit_v2", "timemap-vectors.json"), "utf8"));

function doc(segments, removals = []) {
  return {
    main: {
      segments: segments.map(([id, role, inSf, outSf]) => ({ id, role, in_sf: inSf, out_sf: outSf })),
      removals: removals.map(([seg, inSf, outSf], index) => ({ id: `rm_${index}`, seg, in_sf: inSf, out_sf: outSf })),
    },
  };
}

test("every time-map vector is reproduced (≥ 500 checks, 0 mismatches)", () => {
  assert.equal(VECTORS.schema, "potongin.timemap-vectors/1");
  let total = 0;
  const mismatches = [];
  const check = (name, got, expect) => {
    total += 1;
    try {
      assert.deepEqual(got, expect);
    } catch {
      mismatches.push({ name, got, expect });
    }
  };
  for (const vector of VECTORS.cases) {
    const fps = vector.fps;
    const list = pieces(vector.doc);
    check(`${vector.name}:pieces`, list, vector.pieces);
    check(`${vector.name}:total`, totalFrames(list), vector.total_frames);
    for (const [n, index, sf] of vector.out_to_src) {
      const [piece, got] = outToSrc(n, list);
      check(`${vector.name}:out_to_src:${n}`, [piece.i, got], [index, sf]);
    }
    for (const entry of vector.word_frames) {
      const scope = entry.scope === null ? list : list.filter((piece) => piece.seg === entry.scope);
      check(`${vector.name}:word_frames`, wordFrames(entry.s_ms, entry.e_ms, scope, fps), entry.expect);
    }
    check(`${vector.name}:speech_spans`, speechSpans(vector.speech_words, list, fps), vector.speech_spans);
  }
  const scalar = {
    smp: (v) => smp(v[2], [v[0], v[1]], v[3]),
    sf_floor: (v) => sfFloor(v[2], [v[0], v[1]]),
    sf_ceil: (v) => sfCeil(v[2], [v[0], v[1]]),
    now_ms: (v) => nowMs(v[2], [v[0], v[1]]),
    safe_cs: (v) => safeCs(v[2], [v[0], v[1]]),
    cell_frames: (v) => cellFrames([v[0], v[1]]),
    div_round_half_up: (v) => divRoundHalfUp(v[0], v[1]),
    logo_box: (v) => logoBox(v),
  };
  for (const [name, fn] of Object.entries(scalar)) {
    for (const entry of VECTORS[name]) check(`${name}:${JSON.stringify(entry.in)}`, fn(entry.in), entry.expect);
  }
  assert.deepEqual(mismatches.slice(0, 5), []);
  assert.equal(total, VECTORS.counts.total);
  assert.ok(total >= 500, `only ${total} vector checks`);
});

test("constants and fps forms", () => {
  assert.equal(SAMPLE_RATE, 48000);
  assert.equal(MIN_PIECE_FRAMES, 2);
  assert.equal(smp(30, [30000, 1001]), smp(30, { num: 30000, den: 1001 }));
  assert.equal(smp(1, [30000, 1001]), 1601);
  assert.equal(smp(2, [30000, 1001]), 3203);
  assert.equal(cellFrames([24000, 1001]), 48);
  assert.equal(cellFrames([30000, 1001]), 60);
  assert.equal(cellFrames([25, 1]), 50);
});

test("pieces subtract removals, drop slivers under two frames and lay out from frame 0", () => {
  const list = pieces(doc([["seg_co", "cold_open", 500, 560], ["seg_b1", "body", 100, 400]],
    [["seg_b1", 150, 200], ["seg_b1", 201, 250], ["seg_co", 500, 510], ["seg_x", 0, 50]]));
  assert.deepEqual(list.map((p) => [p.i, p.seg, p.role, p.inSf, p.outSf, p.outF0, p.frames]), [
    [0, "seg_co", "cold_open", 510, 560, 0, 50],
    [1, "seg_b1", "body", 100, 150, 50, 50],
    [2, "seg_b1", "body", 250, 400, 100, 150],
  ]);
  assert.equal(totalFrames(list), 250);
});

test("pieces reject malformed geometry like the Python time map", () => {
  assert.throws(() => pieces(doc([["seg_b1", "body", 10, 10]])), RangeError);
  assert.throws(() => pieces(doc([["seg_b1", "body", -1, 10]])), RangeError);
  assert.throws(() => pieces(doc([["seg_b1", "body", 0, 10]], [["seg_b1", 5, 5]])), RangeError);
  assert.throws(() => pieces(doc([["seg_b1", "body", 0, 10.5]])), TypeError);
  assert.throws(() => pieces(doc([["seg_b1", "body", "0", 10]])), TypeError);
});

test("outToSrc and srcToOut are inverse on kept frames", () => {
  const list = pieces(doc([["seg_co", "cold_open", 500, 560], ["seg_b1", "body", 100, 400]], [["seg_b1", 150, 250]]));
  for (let n = 0; n < totalFrames(list); n += 1) {
    const [piece, sf] = outToSrc(n, list);
    assert.equal(srcToOut(sf, list.filter((p) => p.seg === piece.seg)), n);
  }
  assert.equal(srcToOut(170, list), null);
  assert.equal(srcToOut(99, list), null);
  assert.throws(() => outToSrc(-1, list), RangeError);
  assert.throws(() => outToSrc(totalFrames(list), list), RangeError);
});

test("integer helpers are exact where float division is not", () => {
  const big = 2 ** 52 + 1;
  assert.equal(floorDiv(big, 1), big);
  assert.equal(floorDiv(-7, 2), -4);
  assert.equal(floorDiv(7, 2), 3);
  assert.equal(floorDiv(9007199254740991, 3), 3002399751580330);
  assert.equal(floorDiv(9007199254740990, 9007199254740991), 0);
  assert.equal(divRoundHalfUp(5, 2), 3);
  assert.equal(divRoundHalfUp(-5, 2), -2);
  assert.throws(() => divRoundHalfUp(1, 0), RangeError);
  // 10 h at 29.97: the last frame's first sample stays exact (plan §3.4, below 2^53).
  const n = 10 * 3600 * 30;
  assert.equal(smp(n, [30000, 1001]), Math.floor((n * 48000 * 1001) / 30000));
  assert.equal(sfFloor(36_000_000, [30000, 1001]), 1078921);
  assert.equal(sfCeil(1, [30000, 1001]), 1);
});

test("nowMs follows FFmpeg's double expression and safeCs is two ms early", () => {
  assert.equal(nowMs(0, [30, 1]), 0);
  assert.equal(safeCs(0, [30, 1]), -1);
  // A hazard frame at 30 fps: the IEEE-double time is one below the exact time.
  const hazard = VECTORS.now_ms.find((entry) => entry.hazard);
  assert.ok(hazard);
  const [num, den, frame] = hazard.in;
  assert.equal(nowMs(frame, [num, den]), hazard.expect);
  assert.ok(hazard.expect < Math.floor((frame * den * 1000) / num) + 1);
});
