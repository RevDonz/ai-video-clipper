// Layar terbagi (CONTRACTS §5.45): the words and commands of the panel, the card and "Atur layar
// terbagi" (components/editor/split-model.mjs), and the gizmo's geometry
// (components/editor/gizmos/split-geometry.mjs): the boxes over the source picture, a drag, a
// corner, the keys, and the result drawn from the still.
import assert from "node:assert/strict";
import test from "node:test";

import {
  BIG_NUDGE_E5,
  NUDGE_E5,
  ZOOM_STEP_PM,
  bandBackground,
  bandBox,
  cropForCorner,
  cropForPlace,
  nudgedCrop,
  resultRows,
} from "../components/editor/gizmos/split-geometry.mjs";
import {
  BAND_OPTIONS,
  SPLIT_RATIOS,
  splitCropCommand,
  splitRatioCommand,
  splitSummary,
  splitView,
  swapSplitCommand,
  zoomPercent,
} from "../components/editor/split-model.mjs";
import { defaultSplit, splitCrop, splitGeometry } from "../lib/editor/split.mjs";

const crop = (x = 50000, y = 50000, zoom = 1000) => ({ x_e5: x, y_e5: y, zoom_pm: zoom });
const SOURCE = [1920, 1080];
const OUTPUT = [1080, 1920];
const docWith = (split, mode = "split") => ({
  base: { source: { w: SOURCE[0], h: SOURCE[1] } }, output: { w: OUTPUT[0], h: OUTPUT[1] },
  layout: { default: { mode, no_face: "center" }, ...(split ? { split } : {}) },
});

test("the choices and their words", () => {
  assert.deepEqual(SPLIT_RATIOS.map((option) => [option.id, option.label]), [["30_70", "30/70"], ["50_50", "50/50"]]);
  assert.deepEqual(BAND_OPTIONS.map((option) => [option.id, option.label]), [["top", "Atas"], ["bottom", "Bawah"]]);
  for (const option of [...SPLIT_RATIOS, ...BAND_OPTIONS]) {
    assert.ok(Object.isFrozen(option));
    assert.doesNotMatch(`${option.label} ${option.title ?? ""}`, /[\u2013\u2014]/);
  }
  assert.equal(zoomPercent(1000), 100);
  assert.equal(zoomPercent(3550), 355);
});

test("splitSummary says the shares, top first, and nothing outside the split", () => {
  assert.equal(splitSummary(docWith(null, "fit_blur")), null);
  assert.deepEqual(splitSummary(docWith(defaultSplit())), { ratio: "30_70", top: 30, bottom: 70, text: "Atas 30%, bawah 70%." });
  assert.equal(splitSummary(docWith({ ...defaultSplit(), top_pm: 700 })).text, "Atas 70%, bawah 30%.");
  assert.equal(splitSummary(docWith({ ...defaultSplit(), top_pm: 500 })).ratio, "50_50");
});

test("the commands: 30/70 keeps a swapped order, Tukar, and a crop merged per band", () => {
  const split = defaultSplit();
  assert.deepEqual(splitRatioCommand("50_50", split), { type: "SetSplitRatio", args: { top_pm: 500 }, mergeKey: null });
  assert.deepEqual(splitRatioCommand("30_70", { ...split, top_pm: 500 }).args, { top_pm: 300 });
  assert.deepEqual(splitRatioCommand("30_70", { ...split, top_pm: 700 }).args, { top_pm: 700 });
  assert.throws(() => splitRatioCommand("40_60", split), TypeError);
  assert.deepEqual(swapSplitCommand(), { type: "SwapSplit", args: {}, mergeKey: null });
  assert.deepEqual(splitCropCommand("bottom", crop(1, 2, 3000)),
    { type: "SetSplitCrop", args: { band: "bottom", x_e5: 1, y_e5: 2, zoom_pm: 3000 }, mergeKey: "split:bottom" });
  assert.throws(() => splitCropCommand("middle", crop()), TypeError);
});

test("splitView: the document's bands, with a draft drawn in place of one band", () => {
  const doc = docWith(defaultSplit());
  const view = splitView({ doc });
  assert.deepEqual(view.geometry, splitGeometry(defaultSplit(), { source: SOURCE, output: OUTPUT }));
  assert.deepEqual(view.source, SOURCE);
  assert.deepEqual(view.output, OUTPUT);
  const drafted = splitView({ doc, draft: { band: "top", crop: crop(0, 0, 2000) } });
  assert.deepEqual(drafted.split.top, crop(0, 0, 2000));
  assert.equal(drafted.split.bottom, doc.layout.split.bottom);
  assert.equal(splitView({ doc: docWith(null, "camera") }), null);
});

test("a band's box is its crop as fractions of the source picture", () => {
  const geometry = splitGeometry(defaultSplit(), { source: SOURCE, output: OUTPUT });
  assert.deepEqual(bandBox(geometry, "top", SOURCE), { left: 0, top: 28 / 1080, width: 1, height: 1024 / 1080 });
  assert.deepEqual(bandBox(geometry, "bottom", SOURCE), { left: 526 / 1920, top: 0, width: 868 / 1920, height: 1 });
});

test("a drag places the box's corner; the travel's ends are 0 and 100000", () => {
  const band = [1080, 576];
  const zoomed = crop(50000, 50000, 2000); // 960×512 of the source
  assert.deepEqual(cropForPlace({ crop: zoomed, left: 0, top: 0, source: SOURCE, band }), crop(0, 0, 2000));
  assert.deepEqual(cropForPlace({ crop: zoomed, left: 5000, top: -40, source: SOURCE, band }), crop(100000, 0, 2000));
  assert.deepEqual(cropForPlace({ crop: zoomed, left: 480, top: 284, source: SOURCE, band }), crop(50000, 50000, 2000));
  // the box lands where the render crops it
  const placed = cropForPlace({ crop: zoomed, left: 301, top: 99, source: SOURCE, band });
  const [x, y] = splitCrop(SOURCE, band, placed);
  assert.ok(Math.abs(x - 301) <= 2 && Math.abs(y - 99) <= 2, `${x},${y}`);
  // nothing to travel keeps the place
  assert.equal(cropForPlace({ crop: crop(12345, 777, 1000), left: 900, top: 30, source: SOURCE, band: [1080, 1343] }).y_e5, 777);
  assert.equal(cropForPlace({ crop: crop(12345, 777, 1000), left: 900, top: 50, source: SOURCE, band: [1080, 576] }).x_e5, 12345);
});

test("a corner resizes the box around the opposite corner, within 1× to 5×", () => {
  const band = [1080, 576];
  // the bottom-right corner pulled to half the width from the top-left anchor: zoom 2
  const half = cropForCorner({ corner: "se", anchor: { x: 0, y: 0 }, pointer: { x: 960, y: 10 }, crop: crop(), source: SOURCE, band });
  assert.deepEqual(half, crop(0, 0, 2000));
  // the top-left corner, anchored at the bottom-right: the box ends there
  const nw = cropForCorner({ corner: "nw", anchor: { x: 1920, y: 1080 }, pointer: { x: 960, y: 1080 }, crop: crop(), source: SOURCE, band });
  assert.deepEqual(nw, crop(100000, 100000, 2000));
  // the taller of the two pulls wins, and the zoom stays in range
  const tall = cropForCorner({ corner: "se", anchor: { x: 0, y: 0 }, pointer: { x: 10, y: 512 }, crop: crop(), source: SOURCE, band });
  assert.equal(tall.zoom_pm, 2000);
  assert.equal(cropForCorner({ corner: "se", anchor: { x: 0, y: 0 }, pointer: { x: 1, y: 1 }, crop: crop(), source: SOURCE, band }).zoom_pm, 5000);
  assert.equal(cropForCorner({ corner: "ne", anchor: { x: 0, y: 1080 }, pointer: { x: 9000, y: -900 }, crop: crop(), source: SOURCE, band }).zoom_pm, 1000);
  // the zoom lands on the slider's 1 % steps: 1920 / 1.234 wide is 1234 → 1230
  const odd = cropForCorner({ corner: "se", anchor: { x: 0, y: 0 }, pointer: { x: 1920 / 1.234, y: 0 }, crop: crop(), source: SOURCE, band });
  assert.equal(odd.zoom_pm, 1230);
});

test("keys move the box by 1 % or 10 % of its travel and zoom by 10 %", () => {
  const start = crop(50000, 50000, 2000);
  assert.deepEqual(nudgedCrop(start, "ArrowLeft", false), crop(50000 - NUDGE_E5, 50000, 2000));
  assert.deepEqual(nudgedCrop(start, "ArrowDown", true), crop(50000, 50000 + BIG_NUDGE_E5, 2000));
  assert.deepEqual(nudgedCrop(start, "+", false), crop(50000, 50000, 2000 + ZOOM_STEP_PM));
  assert.deepEqual(nudgedCrop(start, "=", false), crop(50000, 50000, 2000 + ZOOM_STEP_PM));
  assert.deepEqual(nudgedCrop(start, "-", false), crop(50000, 50000, 2000 - ZOOM_STEP_PM));
  assert.deepEqual(nudgedCrop(crop(0, 100000, 1000), "ArrowLeft", true), crop(0, 100000, 1000));
  assert.deepEqual(nudgedCrop(crop(0, 100000, 5000), "+", false), crop(0, 100000, 5000));
  assert.equal(nudgedCrop(start, "Enter", false), null);
});

test("the result draws each band from the latar blur still at its crop", () => {
  const geometry = splitGeometry(defaultSplit(), { source: SOURCE, output: OUTPUT });
  // the still's middle band is the whole source; the bottom band shows its centred crop
  const bottom = bandBackground(geometry, "bottom", SOURCE, OUTPUT);
  assert.equal(bottom.size, `${(1080 * 1920 / (868 * 1080)) * 100}% auto`);
  const [px, py] = bottom.position.split(" ").map((value) => Number.parseFloat(value));
  assert.ok(Math.abs(px - 50) < 1e-9, bottom.position);
  assert.ok(Math.abs(py - 50) < 0.1, bottom.position);
  // a whole-width crop has no horizontal travel in the result: 0 %
  const top = bandBackground(geometry, "top", SOURCE, OUTPUT);
  assert.equal(top.size, "100% auto");
  assert.equal(top.position.split(" ")[0], "0%");
  assert.deepEqual(resultRows(geometry, OUTPUT), { top: (576 / 1920) * 100, bottom: (1343 / 1920) * 100 });
});
