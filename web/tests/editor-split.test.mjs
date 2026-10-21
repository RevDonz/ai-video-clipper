// Layar terbagi (CONTRACTS §5.45): web/lib/editor/split.mjs against the vectors edit_v2/layouts.py
// writes (tests/fixtures/edit_v2/split-vectors.json), so the boxes the gizmo draws are the crops
// the render takes; and the document helpers the commands and the panel read.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SPLIT_BANDS, SPLIT_TOP_PM, SPLIT_ZOOM_RANGE } from "../lib/editor/doc-model.mjs";
import {
  checkSplit,
  defaultSplit,
  splitBands,
  splitCrop,
  splitGeometry,
  splitOf,
  splitRatio,
  swappedSplit,
} from "../lib/editor/split.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const VECTORS = JSON.parse(readFileSync(path.join(REPO, "tests", "fixtures", "edit_v2", "split-vectors.json"), "utf8"));

const crop = (x = 50000, y = 50000, zoom = 1000) => ({ x_e5: x, y_e5: y, zoom_pm: zoom });

test("every shared vector: the line, each band's rows and its crop equal the Python values", () => {
  assert.equal(VECTORS.schema, "potongin.split-vectors/1");
  assert.equal(VECTORS.vectors.length, 32);
  for (const vector of VECTORS.vectors) {
    const geometry = splitGeometry(vector.split, { source: vector.source, output: vector.output });
    assert.equal(geometry.line, vector.line, vector.name);
    for (const band of SPLIT_BANDS) {
      assert.deepEqual(geometry[band], vector[band], `${vector.name} ${band}`);
    }
  }
});

test("the constants and the default split match the Python package", () => {
  assert.deepEqual(SPLIT_TOP_PM, [300, 500, 700]);
  assert.deepEqual(SPLIT_BANDS, ["top", "bottom"]);
  assert.deepEqual(SPLIT_ZOOM_RANGE, [1000, 5000]);
  assert.deepEqual(defaultSplit(), { top_pm: 300, top: crop(), bottom: crop() });
  assert.notEqual(defaultSplit(), defaultSplit());
});

test("the bands share the rows beside the 1 px line", () => {
  assert.deepEqual(splitBands([1080, 1920], 300), [[1080, 576], [1080, 1343]]);
  assert.deepEqual(splitBands({ w: 720, h: 1280 }, 700), [[720, 895], [720, 384]]);
  assert.deepEqual(splitBands([720, 1280], 500), [[720, 640], [720, 639]]);
  assert.throws(() => splitBands([720, 1280], 400), RangeError);
  assert.deepEqual(splitCrop([1920, 1080], [1080, 576], crop(0, 0, 2000)), [0, 0, 960, 512]);
});

test("checkSplit mirrors the validator", () => {
  checkSplit(defaultSplit());
  for (const bad of [
    null, [300], { ...defaultSplit(), top_pm: 400 }, { ...defaultSplit(), extra: 1 },
    { top_pm: 300, top: crop() }, { ...defaultSplit(), top: crop(0, 0, 999) },
    { ...defaultSplit(), bottom: crop(-1) }, { ...defaultSplit(), bottom: { ...crop(), w_e5: 1 } },
    { ...defaultSplit(), top: { x_e5: 0, y_e5: 0 } }, { ...defaultSplit(), top: crop(0.5) },
  ]) {
    assert.throws(() => checkSplit(bad), /split|band|crop|object|top_pm|zoom|x_e5/i, JSON.stringify(bad));
  }
});

test("splitOf, the ratio a pill shows and the swapped split", () => {
  const doc = { layout: { default: { mode: "split", no_face: "center" }, split: { top_pm: 700, top: crop(1, 2, 3000), bottom: crop() } } };
  assert.equal(splitOf(doc), doc.layout.split);
  assert.equal(splitOf({ layout: { default: { mode: "fill_center" } } }), null);
  assert.equal(splitRatio(doc.layout.split), "30_70");
  assert.equal(splitRatio({ ...doc.layout.split, top_pm: 300 }), "30_70");
  assert.equal(splitRatio({ ...doc.layout.split, top_pm: 500 }), "50_50");
  const swapped = swappedSplit(doc.layout.split);
  assert.deepEqual(swapped, { top_pm: 300, top: crop(), bottom: crop(1, 2, 3000) });
  assert.deepEqual(swappedSplit(swapped), doc.layout.split);
  assert.equal(swappedSplit({ ...doc.layout.split, top_pm: 500 }).top_pm, 500);
});

// The boxes keep one DOM order whichever is active: moving a focused node in the DOM blurs it,
// so reordering on focus would drop the focus (and the keys) right after Tab or a click. The
// active box is drawn and picked on top by its z-index (split.module.css) instead.
test("the split gizmo keeps the boxes in band order; the active one is on top by z-index", () => {
  const gizmo = readFileSync(new URL("../components/editor/gizmos/SplitGizmo.jsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../components/editor/gizmos/split.module.css", import.meta.url), "utf8");
  assert.match(gizmo, /\{SPLIT_BANDS\.map\(\(band\) => \{/);
  assert.doesNotMatch(gizmo, /\.sort\(/);
  assert.match(css, /\.box\[data-active="true"\]\s*\{[^}]*z-index:\s*2;/);
});
