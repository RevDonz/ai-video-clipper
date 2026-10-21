// The "Atur bingkai" gizmo's model (web/components/editor/gizmos/frame-geometry.mjs) and the
// dialog's (web/components/editor/framing-model.mjs): where the 9:16 box sits over the
// source picture, what a drag or a key makes of it, the result's crop, the still's document, and
// the view of the playhead's keyframe (CONTRACTS §5.44).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { fakeDoc, fakePlan } from "../components/editor/__dev__/fakes.mjs";
import {
  BIG_NUDGE_E5,
  NUDGE_E5,
  SNAP_SCREEN_PX,
  boxRect,
  frameGeometry,
  grabOffset,
  nudgedPan,
  panAtPointer,
  resultBackground,
} from "../components/editor/gizmos/frame-geometry.mjs";
import { GIZMOS } from "../components/editor/gizmos/index.mjs";
import {
  FRAMING_MOVES,
  clearKeyframesCommand,
  framingSummary,
  framingView,
  keyframeCommand,
  keyframeMoveCommand,
  removeKeyframeCommand,
  sourceFrameDoc,
  stillKey,
} from "../components/editor/framing-model.mjs";
import { checkDoc, createContext } from "../lib/editor/doc-model.mjs";
import { cropAt } from "../lib/editor/framing.mjs";
import { pieces, totalFrames } from "../lib/editor/timemap.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const VECTORS = JSON.parse(readFileSync(path.join(REPO, "tests", "fixtures", "edit_v2", "framing-vectors.json"), "utf8"));
const G = frameGeometry([1280, 720], [720, 1280]);

function framed(keyframes, mode = "fill_center") {
  const doc = fakeDoc();
  doc.layout = { default: { mode, no_face: "center" }, ...(keyframes ? { keyframes } : {}) };
  return doc;
}

const planOf = (doc) => {
  const list = pieces(doc);
  return { ...fakePlan(doc), pieces: list, totalFrames: totalFrames(list) };
};

test("the geometry is the crop layouts' scale and travel", () => {
  assert.deepEqual([G.scaledW, G.scaledH, G.limit, G.travel], [2276, 1280, 1556, 1556]);
  assert.equal(G.boxWidth, 720 / 2276);
  assert.deepEqual([G.boxTop, G.boxHeight], [0, 1]);
  const odd = frameGeometry([1918, 1080], [720, 1280]);
  assert.deepEqual([odd.limit, odd.travel], [1552, 1553]);
});

test("the box over the picture is the crop of every shared vector, to the pixel of the scaled source", () => {
  for (const vector of VECTORS.vectors) {
    const geometry = frameGeometry(vector.source, vector.output);
    vector.positions.forEach((x) => {
      const rect = boxRect(x, geometry);
      assert.equal(Math.round(rect.left * geometry.scaledW), x, vector.name);
      assert.equal(Math.round(rect.width * geometry.scaledW), vector.output[0]);
      assert.ok(rect.left >= 0 && rect.left + rect.width <= 1 + 1e-12, vector.name);
    });
  }
});

test("the result is the still cropped at x: the band scaled to the 9:16 height, shifted by x of the travel", () => {
  assert.deepEqual(resultBackground(0, G), { size: `${(2276 / 720) * 100}% auto`, position: "0% 50%" });
  assert.deepEqual(resultBackground(1556, G).position, `${(1556 / 1556) * 100}% 50%`);
  assert.deepEqual(resultBackground(778, G).position, "50% 50%");
  const portrait = frameGeometry([720, 1280], [720, 1280]);
  assert.equal(resultBackground(0, portrait).position, "50% 50%");
});

test("a drag keeps the grab point under the pointer, snaps to the centre and stays in the travel", () => {
  const x = cropAt([{ sf: 0, pan_e5: 20000, move: "cut" }], 0, [1280, 720], [720, 1280]);
  const inside = x / G.scaledW + G.boxWidth / 3;
  const grab = grabOffset(inside, x, G);
  assert.ok(Math.abs(grab - G.boxWidth / 3) < 1e-12);
  // the box lands on the crop x it was grabbed at (the pan of that x, quantised to even pixels)
  const held = panAtPointer({ pointer: inside, grab, geometry: G }).pan;
  assert.equal(cropAt([{ sf: 0, pan_e5: held, move: "cut" }], 0, [1280, 720], [720, 1280]), x);
  // outside the box: the box jumps so its middle is under the pointer
  assert.equal(grabOffset(0.95, x, G), G.boxWidth / 2);
  assert.equal(panAtPointer({ pointer: 0.99, grab: G.boxWidth / 2, geometry: G }).pan, 100000);
  assert.equal(panAtPointer({ pointer: -0.5, grab: 0, geometry: G }).pan, 0);
  // the magnet: within the reach of the centre the pan is exactly 50 %, Alt (no reach) frees it
  const centre = 778 / G.scaledW;
  const near = panAtPointer({ pointer: centre + 0.004, grab: 0, geometry: G, reach: 0.005 });
  assert.deepEqual(near, { pan: 50000, snapped: true });
  const free = panAtPointer({ pointer: centre + 0.004, grab: 0, geometry: G, reach: 0 });
  assert.equal(free.snapped, false);
  assert.ok(free.pan > 50000);
  assert.equal(SNAP_SCREEN_PX, 8);
});

test("keys move the box by 1 % of the travel, Shift and PageUp/PageDown by 10 %, Home and End to the edges", () => {
  assert.equal(NUDGE_E5, 1000);
  assert.equal(BIG_NUDGE_E5, 10000);
  assert.equal(nudgedPan(50000, "ArrowRight", false), 51000);
  assert.equal(nudgedPan(50000, "ArrowLeft", true), 40000);
  assert.equal(nudgedPan(50000, "PageUp", false), 60000);
  assert.equal(nudgedPan(50000, "PageDown", false), 40000);
  assert.equal(nudgedPan(500, "ArrowLeft", false), 0);
  assert.equal(nudgedPan(99500, "ArrowRight", true), 100000);
  assert.equal(nudgedPan(12345, "Home", false), 0);
  assert.equal(nudgedPan(12345, "End", false), 100000);
  assert.equal(nudgedPan(12345, "ArrowUp", false), null);
  assert.equal(nudgedPan(12345, "a", false), null);
});

test("the still is the source picture: latar blur, no text, logo, music, transition sound or keyframes", () => {
  const doc = framed([{ sf: 37300, pan_e5: 10000, move: "cut" }]);
  doc.main.joins = [];
  const still = sourceFrameDoc(doc);
  assert.deepEqual(still.layout, { default: { mode: "fit_blur", no_face: "center" } });
  assert.equal(still.captions.enabled, false);
  assert.deepEqual([still.tracks, still.assets], [[], {}]);
  assert.equal(still.main.segments, doc.main.segments);
  const ctx = createContext({ words: { words: [], bounds: [] }, seed: doc });
  assert.deepEqual(checkDoc(still, ctx).filter((issue) => issue.code !== "duration_out_of_bounds"), []);
  // a cold-open join keeps its place as a plain cut, without the whoosh
  doc.main.joins = [{ after: "seg_co", style: "flash_white", audio_fade_ms: 30, sfx: { id: "whoosh", v: 1 } }];
  assert.deepEqual(sourceFrameDoc(doc).main.joins, [{ after: "seg_co", style: "cut", audio_fade_ms: 30 }]);
  // the key follows what the still shows (the cuts), not the framing, the text or the logo
  const other = framed([{ sf: 37400, pan_e5: 90000, move: "slide" }]);
  other.main.joins = [];
  other.captions.overrides.y_e5 = 70000;
  doc.main.joins = [];
  assert.equal(stillKey(other), stillKey(doc));
  other.main.removals = [{ id: "rm_1", seg: "seg_b1", in_sf: 37300, out_sf: 37320, words: [], reason: "user", origin: "user" }];
  assert.notEqual(stillKey(other), stillKey(doc));
});

test("the summary under Tata letak says where the framing comes from", () => {
  assert.deepEqual(framingSummary(fakeDoc()), { available: false, reason: "layout", count: 0,
    text: "Pilih Ikuti wajah atau Potong tengah untuk mengatur bingkai sendiri." });
  assert.equal(framingSummary(framed(null, "camera")).text, "Otomatis: bingkai mengikuti wajah.");
  assert.equal(framingSummary(framed(null)).text, "Otomatis: bingkai di tengah.");
  const manual = framingSummary(framed([{ sf: 37300, pan_e5: 0, move: "cut" }, { sf: 37400, pan_e5: 0, move: "cut" }], "camera"));
  assert.deepEqual([manual.available, manual.count, manual.text], [true, 2, "Diatur manual: 2 keyframe, juga di bagian tanpa wajah."]);
  assert.equal(framingSummary(framed([{ sf: 37300, pan_e5: 0, move: "cut" }])).text, "Diatur manual: 1 keyframe.");
  const portrait = framed(null);
  portrait.base.source = { ...portrait.base.source, w: 720, h: 1280 };
  assert.deepEqual([framingSummary(portrait).available, framingSummary(portrait).reason], [false, "portrait"]);
  assert.equal(framingSummary(portrait).text, "Video sumber sudah tegak, tidak ada yang bisa digeser.");
});

test("the view at the playhead: the shown crop, its keyframe, the neighbours and what is known", () => {
  const start = fakeDoc().main.segments[0].in_sf;
  const keyframes = [{ sf: start + 30, pan_e5: 0, move: "cut" }, { sf: start + 90, pan_e5: 100000, move: "slide" }];
  const doc = framed(keyframes);
  const plan = planOf(doc);
  const at = framingView({ doc, plan, frame: 30 });
  assert.deepEqual([at.sf, at.index, at.count, at.auto, at.move, at.moveEditable], [start + 30, 0, 2, false, "cut", false]);
  assert.equal(at.crop, 0);
  assert.equal(at.pan, 0);
  const between = framingView({ doc, plan, frame: 60 });
  assert.deepEqual([between.index, between.previous, between.next, between.resultKnown], [-1, 30, 90, true]);
  assert.equal(between.crop, cropAt(keyframes, start + 60, [1280, 720], [720, 1280]));
  assert.equal(between.pan, Math.round((between.crop * 100000) / 1556)); // what "Tambah keyframe" stores
  const second = framingView({ doc, plan, frame: 90 });
  assert.deepEqual([second.index, second.move, second.moveEditable, second.next], [1, "slide", true, null]);
  assert.deepEqual(second.marks.map((mark) => mark.f), [30, 90]);
  // a drag in progress shows its own pan
  assert.equal(framingView({ doc, plan, frame: 60, draft: 50000 }).crop, 778);
  // no keyframe: Potong tengah's crop is known (the centre), face-track's is not shown
  const centred = framingView({ doc: framed(null), plan, frame: 10 });
  assert.deepEqual([centred.auto, centred.pan, centred.crop, centred.resultKnown], [true, 50000, 778, true]);
  const face = framingView({ doc: framed(null, "camera"), plan, frame: 10 });
  assert.deepEqual([face.auto, face.resultKnown], [true, false]);
  assert.equal(framingView({ doc: framed(null, "camera"), plan, frame: 10, draft: 30000 }).resultKnown, true);
  assert.equal(framingView({ doc, plan: null, frame: 0 }).sf, null);
});

test("the dialog's commands", () => {
  assert.deepEqual(keyframeCommand(37300, 25000), { type: "SetKeyframe", args: { sf: 37300, pan_e5: 25000 }, mergeKey: "frame:37300" });
  assert.deepEqual(removeKeyframeCommand(37300), { type: "RemoveKeyframe", args: { sf: 37300 }, mergeKey: null });
  assert.deepEqual(keyframeMoveCommand(37300, "slide"), { type: "SetKeyframeMove", args: { sf: 37300, move: "slide" }, mergeKey: null });
  assert.throws(() => keyframeMoveCommand(37300, "fade"), TypeError);
  assert.deepEqual(clearKeyframesCommand(), { type: "ClearKeyframes", args: {}, mergeKey: null });
  assert.deepEqual(FRAMING_MOVES.map((option) => [option.id, option.label]), [["cut", "Potong"], ["slide", "Geser"]]);
});

test("the framing gizmo lives in the dialog, not over the 9:16 stage", () => {
  assert.deepEqual(GIZMOS.map((gizmo) => gizmo.id), ["caption", "logo"]);
});

test("with the zoom the box is smaller, centred at the crop's row, and travels further (CONTRACTS §5.47)", () => {
  const plain = frameGeometry([1280, 720], [720, 1280]);
  assert.equal(plain.boxTop, 0);
  assert.equal(plain.boxHeight, 1);
  const zoomed = frameGeometry([1280, 720], [720, 1280], 1500);
  assert.deepEqual([zoomed.scaledW, zoomed.scaledH, zoomed.limit, zoomed.zoom], [3413, 1920, 2692, 1500]);
  assert.equal(zoomed.boxWidth, 720 / 3413);
  assert.equal(zoomed.boxTop, 320 / 1920);
  assert.equal(zoomed.boxHeight, 1280 / 1920);
  const rect = boxRect(1346, zoomed);
  assert.ok(Math.abs(rect.left + rect.width / 2 - 0.5) < 0.001, "the centre pan is the middle of the picture");
  assert.ok(Math.abs(rect.top + rect.height / 2 - 0.5) < 0.001);
  // a 9:16 picture has travel once zoomed
  assert.equal(frameGeometry([720, 1280], [720, 1280]).limit, 0);
  assert.equal(frameGeometry([720, 1280], [720, 1280], 1500).limit, 360);
});
