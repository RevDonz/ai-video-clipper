// "Zoom" and the source's content rect (CONTRACTS §5.52): web/lib/editor/framing.mjs against the
// vectors edit_v2/layouts.py writes (tests/fixtures/edit_v2/zoom-vectors.json), so the box the
// gizmo draws is the crop the render takes at any zoom, inside the picture without black bars;
// and the editor's helpers that read the zoom and the content rect.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadContext } from "../../scripts/edit_v2/crosscheck_commands.mjs";
import { applyCommand } from "../lib/editor/commands.mjs";
import { ZOOM_RANGE, ZOOM_STEP_PM, layoutAfterSwitch, zoomOf } from "../lib/editor/doc-model.mjs";
import {
  centreX,
  cropAt,
  cropY,
  foregroundSize,
  framingAvailability,
  framingSizes,
  keyframePositions,
  panLimit,
  pictureSize,
  scaledSize,
  zoomedOutput,
} from "../lib/editor/framing.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const VECTORS = JSON.parse(readFileSync(path.join(REPO, "tests", "fixtures", "edit_v2", "zoom-vectors.json"), "utf8"));
const C30 = loadContext("c30");

test("every shared vector: picture, zoomed output, travel, centre, row, foreground and crop x equal the Python values", () => {
  assert.equal(VECTORS.schema, "potongin.zoom-vectors/1");
  assert.equal(VECTORS.vectors.length, 29);
  let frames = 0;
  for (const vector of VECTORS.vectors) {
    const { name, output, zoom_pm: zoom } = vector;
    const picture = pictureSize(vector.source, vector.content);
    assert.deepEqual(picture, vector.picture, name);
    assert.deepEqual(zoomedOutput(output, zoom), vector.zoomed, name);
    assert.deepEqual(scaledSize(picture, zoomedOutput(output, zoom)), vector.scaled, name);
    assert.equal(panLimit(picture, output, zoom), vector.limit, name);
    assert.equal(centreX(picture, output, zoom), vector.centre_x, name);
    assert.equal(cropY(picture, output, zoom), vector.crop_y, name);
    assert.deepEqual(foregroundSize(picture, output, zoom), vector.foreground, name);
    const values = keyframePositions(vector.keyframes, { source: picture, output, firstSf: vector.first_sf,
      count: vector.count, zoomPm: zoom });
    assert.deepEqual(values, vector.positions, name);
    frames += values.length;
  }
  assert.ok(frames > 500);
});

test("zoom 1000 is today's geometry; out of range is refused", () => {
  assert.deepEqual(zoomedOutput([720, 1280], 1000), [720, 1280]);
  assert.deepEqual(zoomedOutput([720, 1280]), [720, 1280]);
  assert.deepEqual(zoomedOutput([720, 1280], 1333), [960, 1706]);
  assert.equal(panLimit([1280, 720], [720, 1280], 1000), panLimit([1280, 720], [720, 1280]));
  assert.equal(cropY([1280, 720], [720, 1280]), 0);
  for (const zoom of [999, 1501, 1200.5, "1200", null]) assert.throws(() => zoomedOutput([720, 1280], zoom), RangeError, String(zoom));
  assert.deepEqual(ZOOM_RANGE, [1000, 1500]);
  assert.equal(ZOOM_STEP_PM, 50);
});

test("framingSizes reads the content picture and the zoom; a portrait source can be framed once zoomed", () => {
  const doc = structuredClone(C30.seed);
  assert.deepEqual(framingSizes(doc), { source: [1280, 720], output: [720, 1280], zoom: 1000 });
  doc.base.source.content_rect = { x: 160, y: 0, w: 960, h: 720 };
  doc.layout.zoom_pm = 1250;
  assert.deepEqual(framingSizes(doc), { source: [960, 720], output: [720, 1280], zoom: 1250 });
  assert.equal(zoomOf(doc), 1250);
  assert.equal(zoomOf(C30.seed), 1000);
  // a 9:16 picture has nothing to pan at 100 %, and some travel once zoomed
  const portrait = structuredClone(C30.seed);
  portrait.layout.default.mode = "fill_center";
  portrait.base.source.content_rect = { x: 438, y: 0, w: 404, h: 720 };
  assert.equal(framingAvailability(portrait).reason, "portrait");
  portrait.layout.zoom_pm = 1500;
  assert.equal(framingAvailability(portrait).ok, true);
  assert.equal(cropAt([{ sf: 0, pan_e5: 100000, move: "cut" }], 0, ...Object.values(framingSizes(portrait))),
    panLimit([404, 720], [720, 1280], 1500));
});

test("the zoom survives a layout switch except into the split", () => {
  const layout = { ...C30.seed.layout, zoom_pm: 1200 };
  assert.equal(layoutAfterSwitch(layout, "camera").zoom_pm, 1200);
  assert.equal(layoutAfterSwitch(layout, "fit_blur").zoom_pm, 1200);
  assert.ok(!Object.hasOwn(layoutAfterSwitch(layout, "split"), "zoom_pm"));
  const zoomed = applyCommand(C30.seed, "SetZoom", { zoom_pm: 1100 }, C30.ctx).doc;
  assert.equal(zoomed.layout.zoom_pm, 1100);
});
