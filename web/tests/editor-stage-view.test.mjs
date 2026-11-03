// "Lihat sumber" (rombak 06 §5.2): the stage shows the result or the source, and the machine that
// moves between them. Latest wins over the dialogs' rule: every layout whose frame can be moved by
// hand (face-track and centre crop, as "Atur bingkai" allowed) and the split, never while the doc
// holds shot ranges (F4b), never on a source already upright.
import assert from "node:assert/strict";
import test from "node:test";

import { fakeDoc } from "../components/editor/__dev__/fakes.mjs";
import { STAGE_OUTPUT, STAGE_SOURCE, sourceAllowed, stageViewAfter } from "../lib/editor/stage-view.mjs";

const docIn = (mode, change = () => {}) => {
  const doc = structuredClone(fakeDoc());
  doc.layout.default.mode = mode;
  change(doc);
  return doc;
};

test("Lihat sumber is there for face-track, centre crop and the split, not for latar blur", () => {
  assert.equal(sourceAllowed(docIn("camera")), true);
  assert.equal(sourceAllowed(docIn("fill_center")), true);
  assert.equal(sourceAllowed(docIn("split")), true);
  assert.equal(sourceAllowed(docIn("fit_blur")), false);
  assert.equal(sourceAllowed(null), false);
});

test("shot ranges hide it, as long as the keyframes rule stands (06 §5.2, 04 §A6)", () => {
  assert.equal(sourceAllowed(docIn("camera", (doc) => { doc.layout.ranges = [{ start_f: 0, end_f: 10, mode: "camera" }]; })), false);
  assert.equal(sourceAllowed(docIn("camera", (doc) => { doc.layout.ranges = []; })), true);
});

test("a source already upright has no frame to move", () => {
  const doc = docIn("fill_center", (next) => { next.base.source.w = 720; next.base.source.h = 1280; });
  assert.equal(sourceAllowed(doc), false);
});

test("output → source only with Lihat sumber on a layout that allows it", () => {
  assert.equal(stageViewAfter(STAGE_OUTPUT, { type: "show", doc: docIn("camera") }), STAGE_SOURCE);
  assert.equal(stageViewAfter(STAGE_OUTPUT, { type: "show", doc: docIn("fit_blur") }), STAGE_OUTPUT);
});

test("source → output: Kembali ke hasil, Escape, Putar", () => {
  for (const type of ["back", "escape", "play"]) assert.equal(stageViewAfter(STAGE_SOURCE, { type }), STAGE_OUTPUT, type);
});

test("source → output when another tab opens, and only then", () => {
  assert.equal(stageViewAfter(STAGE_SOURCE, { type: "tab", tab: "layout" }), STAGE_SOURCE);
  for (const tab of ["text", "audio", "logo", "coldopen"]) {
    assert.equal(stageViewAfter(STAGE_SOURCE, { type: "tab", tab }), STAGE_OUTPUT, tab);
  }
});

test("source → output when the document stops allowing it (a new layout, an undo)", () => {
  assert.equal(stageViewAfter(STAGE_SOURCE, { type: "doc", doc: docIn("split") }), STAGE_SOURCE);
  assert.equal(stageViewAfter(STAGE_SOURCE, { type: "doc", doc: docIn("fit_blur") }), STAGE_OUTPUT);
});

test("output stays output for everything else; an unknown event changes nothing", () => {
  for (const event of [{ type: "back" }, { type: "escape" }, { type: "play" }, { type: "tab", tab: "layout" }, { type: "doc", doc: docIn("camera") }, { type: "?" }]) {
    assert.equal(stageViewAfter(STAGE_OUTPUT, event), STAGE_OUTPUT, event.type);
  }
  assert.equal(stageViewAfter(STAGE_SOURCE, { type: "?" }), STAGE_SOURCE);
});
