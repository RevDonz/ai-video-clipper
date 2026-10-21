// The logo or the text watermark over the caption (CONTRACTS §5.51): the plan's
// `logo_over_caption` warning, its messages, and the one-click fix that moves the logo to the
// SnapLogo corner or the watermark to the place the warning names.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { fakeDoc, fakePlan, fakeWords } from "../components/editor/__dev__/fakes.mjs";
import { boxOf, logoOf } from "../components/editor/gizmos/logo-geometry.mjs";
import {
  LOGO_CORNERS,
  LOGO_CAPTION_TEXT,
  logoCaptionFix,
  logoCaptionNote,
} from "../components/editor/panels/logo-model.mjs";
import { MESSAGES, actionableChecks, checksView } from "../components/editor/shell-model.mjs";
import { applyCommand } from "../lib/editor/commands.mjs";
import { WATERMARK_POSITIONS, WATERMARK_POSITION_NAMES, createContext } from "../lib/editor/doc-model.mjs";
import { createEditSession } from "../lib/editor/history.mjs";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(WEB, relative), "utf8");
const HEX = "7d2e".padEnd(64, "b");
const LOGO = { code: "logo_over_caption", path: "/tracks/2/items/0/transform", ref: "top_right", f: 12 };
const MARK = { code: "logo_over_caption", path: "/watermark/pos", ref: "middle_right", f: 12 };
// tests/test_edit_v2_overlay_zone.py CORNER_BOXES: a 400 × 200 logo at 16 % on 720 × 1280.
const CORNER_BOXES = {
  top_left: { x: 29, y: 93, w: 115, h: 58 },
  top_right: { x: 512, y: 93, w: 115, h: 58 },
  bottom_left: { x: 29, y: 942, w: 115, h: 58 },
  bottom_right: { x: 512, y: 942, w: 115, h: 58 },
};

function withLogo() {
  const seed = fakeDoc();
  seed.output = { ...seed.output, w: 720, h: 1280 };
  const ctx = createContext({ words: fakeWords(), seed });
  const meta = { sha256: HEX, kind: "logo", mime: "image/png", w: 400, h: 200, durationMs: null, lufsC: null, peaksUrl: null };
  return { doc: applyCommand(seed, "SetLogo", { asset: `sha256:${HEX}`, meta }, ctx).doc, ctx };
}

test("the warning's messages are the engine's, named per part in Perlu dicek", () => {
  assert.equal(MESSAGES.logo_over_caption, "Logo atau teks watermark menutupi caption");
  const seed = fakeDoc();
  const plan = { ...fakePlan(seed), fps: [25, 1], errors: [], warnings: [LOGO, { ...MARK, ref: "top_right" }] };
  const checks = checksView({ warnings: [], plan, doc: structuredClone(seed), seed });
  assert.deepEqual(checks.map(({ code, severity, ref, message }) => ({ code, severity, ref, message })), [
    { code: "logo_over_caption", severity: "warning", ref: "top_right", message: "Logo menutupi caption" },
    { code: "logo_over_caption", severity: "warning", ref: "top_right", message: "Teks watermark menutupi caption" },
  ], "the same ref on both parts stays two checks");
  assert.equal(actionableChecks(checks).length, 2, "a tick before export");
  assert.deepEqual(checks.map((check) => logoCaptionFix(check)?.command.type), ["SnapLogo", "SetWatermarkPosition"]);
});

test("the logo's fix is the SnapLogo corner the warning names", () => {
  for (const corner of LOGO_CORNERS) {
    assert.deepEqual(logoCaptionFix({ ...LOGO, ref: corner.id }), {
      id: corner.id,
      part: "logo",
      label: `Pindah ke ${corner.label}`,
      command: { type: "SnapLogo", args: { corner: corner.id }, mergeKey: null },
    });
  }
  assert.equal(logoCaptionFix({ ...LOGO, ref: "middle_center" }), null);
  assert.equal(logoCaptionFix({ ...LOGO, ref: null }), null);
  assert.equal(logoCaptionFix({ ...LOGO, code: "unsafe_zone" }), null);
  assert.equal(logoCaptionFix(null), null);
});

test("the watermark's fix is the place the warning names", () => {
  for (const pos of WATERMARK_POSITIONS) {
    assert.deepEqual(logoCaptionFix({ ...MARK, ref: pos }), {
      id: pos,
      part: "watermark",
      label: `Pindah ke ${WATERMARK_POSITION_NAMES[pos]}`,
      command: { type: "SetWatermarkPosition", args: { pos }, mergeKey: null },
    });
  }
  assert.equal(logoCaptionFix({ ...MARK, ref: "kiri" }), null);
});

test("logoCaptionNote: each part's line with its fix, or the line without one", () => {
  const plan = (warnings) => ({ ...fakePlan(fakeDoc()), warnings });
  assert.equal(logoCaptionNote(plan([]), "logo"), null);
  assert.equal(logoCaptionNote(null, "watermark"), null);
  assert.equal(logoCaptionNote(plan([MARK]), "logo"), null);
  assert.deepEqual(logoCaptionNote(plan([LOGO, MARK]), "logo"), { text: LOGO_CAPTION_TEXT.logo, fix: logoCaptionFix(LOGO) });
  assert.deepEqual(logoCaptionNote(plan([LOGO, MARK]), "watermark"),
    { text: LOGO_CAPTION_TEXT.watermark, fix: logoCaptionFix(MARK) });
  assert.deepEqual(logoCaptionNote(plan([{ ...LOGO, ref: undefined }]), "logo"), { text: LOGO_CAPTION_TEXT.logoNoFix, fix: null });
  assert.deepEqual(logoCaptionNote(plan([{ ...MARK, ref: undefined }]), "watermark"),
    { text: LOGO_CAPTION_TEXT.watermarkNoFix, fix: null });
});

test("SnapLogo puts the logo where the engine's check measured each corner", () => {
  const { doc, ctx } = withLogo();
  for (const [corner, box] of Object.entries(CORNER_BOXES)) {
    const moved = applyCommand(doc, "SnapLogo", { corner }, ctx).doc;
    const found = logoOf(moved);
    assert.deepEqual(boxOf(found.transform, found.meta, ctx.output), box, corner);
  }
});

test("each fix is one undo step", () => {
  const { doc, ctx } = withLogo();
  const low = applyCommand(doc, "SnapLogo", { corner: "bottom_right" }, ctx).doc;
  const marked = applyCommand(low, "SetWatermarkText", { text: "@akun" }, ctx).doc;
  const placed = applyCommand(marked, "SetWatermarkPosition", { pos: "bottom_right" }, ctx).doc;
  const session = createEditSession({ doc: placed, ctx, now: () => 0 });
  for (const warning of [LOGO, MARK]) {
    const { command } = logoCaptionFix(warning);
    session.dispatch(command.type, command.args, { mergeKey: command.mergeKey });
  }
  assert.deepEqual(boxOf(logoOf(session.doc).transform, logoOf(session.doc).meta, ctx.output), CORNER_BOXES.top_right);
  assert.equal(session.doc.watermark.pos, "middle_right");
  assert.equal(session.history.size, 2);
  session.undo();
  assert.equal(session.doc.watermark.pos, "bottom_right");
});

test("Perlu dicek, the Logo panel, the watermark section and the Logo & Musik card offer the fix", () => {
  const panel = read("components/editor/ChecksPanel.jsx");
  assert.match(panel, /logoCaptionFix\(check\)/);
  for (const [file, part] of [
    ["components/editor/panels/LogoPanel.jsx", "logo"],
    ["components/editor/panels/WatermarkSection.jsx", "watermark"],
    ["components/editor/quick/ExtrasCard.jsx", "logo"],
  ]) {
    const source = read(file);
    assert.match(source, new RegExp(`logoCaptionNote\\([^)]*"${part}"\\)`), file);
    assert.match(source, /data-logo-caption/, file);
  }
});
