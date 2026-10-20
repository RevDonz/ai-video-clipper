// The text watermark in the Logo panel (CONTRACTS §5.43): the panel's view of the document and the
// commands its text field, place grid and sliders send (web/components/editor/panels/watermark-model.mjs).
import assert from "node:assert/strict";
import test from "node:test";

import { loadContext } from "../../scripts/edit_v2/crosscheck_commands.mjs";
import { applyCommand } from "../lib/editor/commands.mjs";
import { DEFAULT_WATERMARK, WATERMARK_POSITIONS } from "../lib/editor/doc-model.mjs";
import {
  WATERMARK_MAX,
  WATERMARK_PLACES,
  cleanWatermarkText,
  percentLabel,
  watermarkDraftOnBlur,
  watermarkOpacityCommand,
  watermarkPlaceCommand,
  watermarkPoints,
  watermarkRemoveCommand,
  watermarkSizeCommand,
  watermarkTextCommand,
  watermarkView,
} from "../components/editor/panels/watermark-model.mjs";

const C30 = loadContext("c30");

function apply(doc, command) {
  return applyCommand(doc, command.type, command.args, C30.ctx).doc;
}

function ready(doc, extra = {}) {
  return { status: "ready", doc, seed: C30.seed, plan: null, ...extra };
}

test("the text is cleaned like the hook's and counted in code points", () => {
  assert.equal(WATERMARK_MAX, 40);
  assert.equal(cleanWatermarkText("  @akun\tku \n"), "@akun ku");
  assert.equal(cleanWatermarkText("Café"), "Café");
  assert.equal(cleanWatermarkText(null), "");
  assert.equal(watermarkPoints("😂😂"), 2);
});

test("typing adds the watermark once, then changes only its text in one undo step", () => {
  const first = watermarkTextCommand(C30.seed, " @akun");
  assert.deepEqual(first, { type: "SetWatermarkText", args: { text: "@akun" }, mergeKey: "wm:text" });
  const doc = apply(C30.seed, first);
  assert.deepEqual(doc.watermark, { ...DEFAULT_WATERMARK, text: "@akun" });
  assert.deepEqual(watermarkTextCommand(doc, "@akunku"), { type: "SetWatermarkText", args: { text: "@akunku" }, mergeKey: "wm:text" });
  // Nothing to send: the same text, an empty field (the remove button removes) or too long.
  assert.equal(watermarkTextCommand(doc, "@akun "), null);
  assert.equal(watermarkTextCommand(doc, "   "), null);
  assert.equal(watermarkTextCommand(C30.seed, ""), null);
  assert.equal(watermarkTextCommand(doc, "x".repeat(41)), null);
  assert.ok(watermarkTextCommand(doc, "😂".repeat(40)));
});

test("an emptied field shows the text again when it loses focus", () => {
  const doc = apply(C30.seed, watermarkTextCommand(C30.seed, "@akun"));
  assert.equal(watermarkDraftOnBlur(doc, "  "), "@akun");
  assert.equal(watermarkDraftOnBlur(doc, "@aku"), "@aku");
  assert.equal(watermarkDraftOnBlur(C30.seed, ""), "");
});

test("the place grid, the size and the opacity send their own commands", () => {
  assert.deepEqual(WATERMARK_PLACES.map((place) => place.id), [...WATERMARK_POSITIONS]);
  assert.deepEqual(WATERMARK_PLACES.map((place) => place.name), ["Kiri atas", "Tengah atas", "Kanan atas", "Kiri tengah",
    "Tengah", "Kanan tengah", "Kiri bawah", "Tengah bawah", "Kanan bawah"]);
  assert.equal(watermarkPlaceCommand(C30.seed, "bottom_left"), null, "no watermark yet");
  const doc = apply(C30.seed, watermarkTextCommand(C30.seed, "@akun"));
  assert.equal(watermarkPlaceCommand(doc, "top_center"), null, "already there");
  assert.deepEqual(watermarkPlaceCommand(doc, "bottom_left"), { type: "SetWatermarkPosition", args: { pos: "bottom_left" }, mergeKey: null });
  assert.throws(() => watermarkPlaceCommand(doc, "center"), TypeError);
  assert.deepEqual(watermarkSizeCommand(doc, 1250), { type: "SetWatermarkSize", args: { size_pm: 1250 }, mergeKey: "wm:size" });
  assert.equal(watermarkSizeCommand(doc, 1000), null);
  assert.deepEqual(watermarkOpacityCommand(doc, 600), { type: "SetWatermarkOpacity", args: { opacity_pm: 600 }, mergeKey: "wm:opacity" });
  assert.equal(watermarkOpacityCommand(C30.seed, 600), null);
  assert.deepEqual(watermarkRemoveCommand(doc), { type: "RemoveWatermark", args: {}, mergeKey: null });
  assert.equal(watermarkRemoveCommand(C30.seed), null);
  for (const command of [watermarkPlaceCommand(doc, "middle_right"), watermarkSizeCommand(doc, 2000),
    watermarkOpacityCommand(doc, 200), watermarkRemoveCommand(doc)]) apply(doc, command);
});

test("the view: loading, read-only, without and with a watermark, and its missing glyphs", () => {
  assert.deepEqual(watermarkView({ status: "loading" }), { ready: false, readOnly: false, watermark: null, place: null,
    sizeText: null, opacityText: null, missingGlyphs: [] });
  const empty = watermarkView(ready(C30.seed));
  assert.equal(empty.ready, true);
  assert.equal(empty.watermark, null);
  const doc = apply(C30.seed, watermarkTextCommand(C30.seed, "Harga ₿"));
  const plan = { warnings: [
    { code: "glyph_unsupported:U+20BF", path: "/watermark/text", ref: null, f: 0 },
    { code: "glyph_unsupported:U+20BF", path: "/watermark/text", ref: null, f: 0 },
    { code: "glyph_unsupported:U+1F525", path: "/tracks/0/items/0/payload/text", ref: "it_hook", f: 0 },
    { code: "unsafe_zone", path: "/captions/overrides/y_e5", ref: null, f: 3 },
  ] };
  const view = watermarkView(ready(doc, { plan }));
  assert.deepEqual(view.watermark, doc.watermark);
  assert.deepEqual(view.place, { id: "top_center", name: "Tengah atas" });
  assert.equal(view.sizeText, "100%");
  assert.equal(view.opacityText, "85%");
  assert.deepEqual(view.missingGlyphs, ["₿ (U+20BF)"]);
  const readOnly = watermarkView({ ...ready(doc), status: "readOnly" });
  assert.equal(readOnly.ready, true);
  assert.equal(readOnly.readOnly, true);
});

test("percent labels keep a tenth with a comma", () => {
  assert.equal(percentLabel(1000), "100%");
  assert.equal(percentLabel(850), "85%");
  assert.equal(percentLabel(1255), "125,5%");
  assert.equal(percentLabel(2000), "200%");
});
