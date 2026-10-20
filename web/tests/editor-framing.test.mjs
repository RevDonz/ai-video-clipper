// Manual framing, "Atur bingkai" (CONTRACTS §5.41): web/lib/editor/framing.mjs against the vectors
// edit_v2/layouts.py writes (tests/fixtures/edit_v2/framing-vectors.json), so the box the gizmo
// draws is the crop the render takes; and the helpers the dialog and the timeline read.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadContext } from "../../scripts/edit_v2/crosscheck_commands.mjs";
import { applyCommand } from "../lib/editor/commands.mjs";
import { body } from "../lib/editor/doc-model.mjs";
import {
  checkKeyframes,
  cropAt,
  framingAvailability,
  keyframeBefore,
  keyframeMarks,
  keyframePositions,
  panForCrop,
  panLimit,
  scaledSize,
  sourceFrameAt,
} from "../lib/editor/framing.mjs";
import { pieces, totalFrames } from "../lib/editor/timemap.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const VECTORS = JSON.parse(readFileSync(path.join(REPO, "tests", "fixtures", "edit_v2", "framing-vectors.json"), "utf8"));
const C30 = loadContext("c30");

const kf = (sf, pan, move = "cut") => ({ sf, pan_e5: pan, move });

test("every shared vector: the travel and the crop x of every frame equal the Python values", () => {
  assert.equal(VECTORS.schema, "potongin.framing-vectors/1");
  assert.equal(VECTORS.vectors.length, 29);
  let frames = 0;
  for (const vector of VECTORS.vectors) {
    assert.equal(panLimit(vector.source, vector.output), vector.limit, vector.name);
    const values = keyframePositions(vector.keyframes, { source: vector.source, output: vector.output,
      firstSf: vector.first_sf, count: vector.count });
    assert.deepEqual(values, vector.positions, vector.name);
    frames += values.length;
  }
  assert.ok(frames > 1000);
});

test("scaledSize is FFmpeg's force_original_aspect_ratio=increase", () => {
  assert.deepEqual(scaledSize([1280, 720], [720, 1280]), [2276, 1280]);
  assert.deepEqual(scaledSize([1920, 1080], [1080, 1920]), [3413, 1920]);
  assert.deepEqual(scaledSize([640, 480], [720, 1280]), [1707, 1280]);
  assert.deepEqual(scaledSize([720, 1280], [720, 1280]), [720, 1280]);
  assert.deepEqual(scaledSize({ w: 720, h: 1600 }, { w: 720, h: 1280 }), [720, 1600]);
  assert.equal(panLimit([1918, 1080], [720, 1280]), 1552);
  assert.throws(() => scaledSize([0, 720], [720, 1280]), TypeError);
});

test("a single crop x, the keyframe before a frame and the pan of a crop x", () => {
  const keyframes = [kf(10, 0), kf(20, 100000, "cut"), kf(30, 0, "slide")];
  assert.equal(cropAt(keyframes, 25, [1280, 720], [720, 1280]), 778);
  assert.deepEqual([5, 10, 19, 20, 29, 30, 99].map((sf) => keyframeBefore(keyframes, sf)), [-1, 0, 0, 1, 1, 2, 2]);
  assert.equal(panForCrop(778, 1556), 50000);
  assert.equal(panForCrop(0, 1556), 0);
  assert.equal(panForCrop(1556, 1556), 100000);
  assert.equal(panForCrop(-40, 1556), 0);
  assert.equal(panForCrop(9999, 1556), 100000);
  assert.equal(panForCrop(5, 0), 50000);
  // pan → x → pan is stable at the gizmo's precision: within one pixel of the travel
  for (const pan of [0, 1, 777, 33333, 50000, 99999, 100000]) {
    const x = cropAt([kf(0, pan)], 0, [1280, 720], [720, 1280]);
    assert.ok(Math.abs(cropAt([kf(0, panForCrop(x, 1556))], 0, [1280, 720], [720, 1280]) - x) <= 1, String(pan));
  }
});

test("keyframes are checked like the validator", () => {
  assert.throws(() => checkKeyframes([]), RangeError);
  assert.throws(() => checkKeyframes([kf(5, 0), kf(5, 1)]), RangeError);
  assert.throws(() => checkKeyframes([kf(5, 100001)]), RangeError);
  assert.throws(() => checkKeyframes([kf(5, 0, "fade")]), RangeError);
  assert.throws(() => checkKeyframes([null]), TypeError);
  assert.throws(() => checkKeyframes(Array.from({ length: 101 }, (_x, i) => kf(i, 0))), RangeError);
  checkKeyframes(Array.from({ length: 100 }, (_x, i) => kf(i, 0)));
});

test("framing is for the crop layouts of a source wider than 9:16", () => {
  const doc = C30.seed;
  assert.deepEqual(framingAvailability(doc), { ok: false, reason: "layout" });
  const centred = applyCommand(doc, "SetLayout", { mode: "fill_center" }, C30.ctx).doc;
  assert.deepEqual(framingAvailability(centred), { ok: true, reason: null });
  const portrait = { ...centred, base: { ...centred.base, source: { ...centred.base.source, w: 720, h: 1280 } } };
  assert.deepEqual(framingAvailability(portrait), { ok: false, reason: "portrait" });
  assert.deepEqual(framingAvailability(null), { ok: false, reason: "layout" });
});

test("keyframe marks sit at the output frame that shows their source frame; a cut one has none", () => {
  const start = body(C30.seed).in_sf;
  let doc = applyCommand(C30.seed, "SetLayout", { mode: "fill_center" }, C30.ctx).doc;
  for (const [sf, pan] of [[start + 400, 10000], [start + 100, 90000], [start + 250, 50000]]) {
    doc = applyCommand(doc, "SetKeyframe", { sf, pan_e5: pan }, C30.ctx).doc;
  }
  const words = C30.ctx.wordList.filter((_w, i) => C30.ctx.midSf(i) >= start + 240 && C30.ctx.midSf(i) < start + 260);
  doc = applyCommand(doc, "RemoveWords", { wordIds: words.map((w) => w.id) }, C30.ctx).doc;
  const list = pieces(doc);
  const plan = { pieces: list, totalFrames: totalFrames(list) };
  const marks = keyframeMarks(doc, plan);
  assert.deepEqual(marks.map((mark) => mark.sf), [start + 100, start + 400]);
  for (const mark of marks) assert.equal(sourceFrameAt(plan, mark.f), mark.sf);
  assert.deepEqual(keyframeMarks(doc, null), []);
  assert.equal(sourceFrameAt(plan, -1), null);
  assert.equal(sourceFrameAt(plan, plan.totalFrames), null);
  assert.equal(sourceFrameAt(null, 0), null);
});
