// The caption gizmo's model (web/components/editor/gizmos/caption-geometry.mjs, CONTRACTS §5.47):
// where the caption block sits on the 9:16 stage, the drag (snap to Atas/Tengah/Bawah, the
// 20–92 % range, the slider's 0.5 % grid), the keys, and the undo steps they make.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { fakeDoc, fakeWords } from "../components/editor/__dev__/fakes.mjs";
import {
  BIG_NUDGE_E5,
  CAPTION_TEXT,
  DRAG_START_SCREEN_PX,
  NUDGE_E5,
  SNAP_SCREEN_PX,
  captionBottom,
  captionBox,
  captionInZone,
  captionReadout,
  captionValueText,
  createCaptionDrag,
  dragCaptionY,
  dragCommand,
  nudgeCommand,
  nudgedCaptionY,
  presetGuides,
} from "../components/editor/gizmos/caption-geometry.mjs";
import { GIZMOS, gizmoById } from "../components/editor/gizmos/index.mjs";
import {
  CAPTION_POSITIONS,
  CAPTION_Y_STEP,
  captionCommand,
  captionPositionText,
} from "../components/editor/panels/caption-model.mjs";
import { CAPTION_OVERRIDE_RULES, CAPTION_Y_RANGE, PACK_IDS, createContext } from "../lib/editor/doc-model.mjs";
import { createEditSession } from "../lib/editor/history.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WEB = path.join(REPO, "web");
const P720 = { w: 720, h: 1280 };
const P1080 = { w: 1080, h: 1920 };
const pack = (id) => JSON.parse(readFileSync(path.join(REPO, "resources", "caption-packs", id, "v1.json"), "utf8"));
const captionsOf = (packId, overrides = {}) => {
  const doc = fakeDoc();
  return { ...doc.captions, pack: { id: packId, v: 1 }, overrides: { ...doc.captions.overrides, ...overrides } };
};

test("the range and the grid are the document's and the slider's", () => {
  assert.deepEqual([...CAPTION_Y_RANGE], [20000, 92000]);
  assert.ok(Object.isFrozen(CAPTION_Y_RANGE));
  const rule = CAPTION_OVERRIDE_RULES.y_e5;
  assert.ok(rule(20000) && rule(92000) && rule(83000));
  assert.ok(!rule(19999) && !rule(92001));
  assert.equal(CAPTION_Y_STEP, 500);
  // Every preset lies on the grid and inside the range, so a drag can land on it exactly.
  for (const option of CAPTION_POSITIONS) {
    assert.equal(option.value % CAPTION_Y_STEP, 0, option.id);
    assert.ok(rule(option.value), option.id);
  }
  assert.equal(NUDGE_E5, CAPTION_Y_STEP);
  assert.equal(BIG_NUDGE_E5, 10 * CAPTION_Y_STEP);
  assert.equal(SNAP_SCREEN_PX, 8);
  assert.equal(DRAG_START_SCREEN_PX, 3);
});

test("the text metrics are the pack files' (size, outline, side margin, one-line packs)", () => {
  assert.deepEqual(Object.keys(CAPTION_TEXT.packs).sort(), [...PACK_IDS].sort());
  for (const id of PACK_IDS) {
    const file = pack(id);
    const metrics = CAPTION_TEXT.packs[id];
    assert.deepEqual([file.size.num, file.size.den], [...CAPTION_TEXT.size], id);
    assert.equal(file.margin_side_pm, CAPTION_TEXT.marginSidePm, id);
    assert.equal(metrics.scalePm, file.size.scale_pm, id);
    assert.deepEqual([...metrics.outline], [file.outline.num, file.outline.den], id);
    // The packs with a max width split wide cues into one line; the others wrap to two.
    assert.equal(metrics.lines, file.max_width_pm === null ? 2 : 1, id);
    const family = file.font.family.startsWith("DejaVu") ? "dejavu" : file.font.family.startsWith("Montserrat") ? "montserrat" : null;
    assert.equal(metrics.lineEmPm, { dejavu: 1164, montserrat: 1219 }[family], id);
  }
});

test("the block's bottom is the ASS bottom (MarginV = H − y, rounded half up)", () => {
  // captions_ass._margin_v: rhu((100000 − y_e5)·H, 100000).
  const expected = [[20000, 256], [38000, 486], [60000, 768], [78125, 1000], [83000, 1062], [92000, 1178]];
  for (const [y, bottom] of expected) assert.equal(captionBottom(y, P720), bottom, String(y));
  assert.equal(captionBottom(83000, P1080), 1594);
  assert.equal(captionBottom(20000, P1080), 384);
});

test("the box spans the text width and the pack's line height above the bottom", () => {
  // Karaoke at the seed: font 53 px, two lines of 62 px plus the outline (9 px), sides 43 px.
  assert.deepEqual(captionBox(captionsOf("karaoke"), P720), { x: 43, y: 929, w: 634, h: 133, bottom: 1062 });
  // Box: Montserrat at 120 %, one line (64 px font, 78 px pitch, 13 px outline).
  assert.deepEqual(captionBox(captionsOf("box"), P720), { x: 43, y: 971, w: 634, h: 91, bottom: 1062 });
  // Bold at Besar, Tengah: the box grows with the size and follows y_e5.
  const bold = captionBox(captionsOf("bold", { size_pm: 1200, y_e5: 60000 }), P720);
  assert.equal(bold.bottom, 768);
  assert.ok(bold.h > captionBox(captionsOf("bold", { y_e5: 60000 }), P720).h);
  // 1080×1920 scales everything.
  const big = captionBox(captionsOf("karaoke"), P1080);
  assert.deepEqual([big.x, big.w, big.bottom], [65, 950, 1594]);
  // Never above the frame: the top is clamped at 0.
  const huge = captionBox(captionsOf("bold", { size_pm: 1400, y_e5: 20000 }), P720);
  assert.ok(huge.y >= 0 && huge.y + huge.h === huge.bottom);
  // An unknown pack (a newer one) is drawn like Klasik rather than failing.
  assert.deepEqual(captionBox(captionsOf("nope"), P720), captionBox(captionsOf("classic"), P720));
});

test("the TikTok zone check is the server's unsafe_zone rule for the caption", () => {
  // plan.unsafe_zone_issues: y_e5·H > (H − bottom zone)·100000.
  for (const output of [P720, P1080]) {
    assert.equal(captionInZone(78125, output), false);
    assert.equal(captionInZone(78126, output), true);
    assert.equal(captionInZone(83000, output), true, "Bawah, the seed spot, sits in the zone");
    assert.equal(captionInZone(60000, output), false);
  }
});

test("the preset guides are the presets' bottoms", () => {
  assert.deepEqual(presetGuides(P720), [
    { id: "atas", label: "Atas", value: 38000, line: 486 },
    { id: "tengah", label: "Tengah", value: 60000, line: 768 },
    { id: "bawah", label: "Bawah", value: 83000, line: 1062 },
  ]);
});

test("a drag snaps to a preset within 8 screen px, else lands on the slider's grid", () => {
  // 2 output px per screen px: the magnet reaches 16 output px = 1250 e5 at 1280 high.
  const scale = 2;
  const at = (targetE5, magnet = true) => {
    const dy = ((targetE5 - 83000) * P720.h) / 100000 / scale;
    return dragCaptionY({ startY: 83000, dy, scale, output: P720, magnet });
  };
  assert.deepEqual(at(61000), { value: 60000, preset: "tengah" });
  assert.deepEqual(at(58800), { value: 60000, preset: "tengah" });
  assert.deepEqual(at(61400), { value: 61500, preset: null });
  assert.deepEqual(at(38900), { value: 38000, preset: "atas" });
  // Alt (no magnet): the grid only.
  assert.deepEqual(at(60900, false), { value: 61000, preset: null });
  assert.deepEqual(at(60000, false), { value: 60000, preset: "tengah" }, "landing on a preset still names it");
  // No movement keeps the value.
  assert.deepEqual(dragCaptionY({ startY: 83000, dy: 0, scale, output: P720 }), { value: 83000, preset: "bawah" });
  // The range stops it: never above 20 % or below 92 %.
  assert.deepEqual(at(5000), { value: 20000, preset: null });
  assert.deepEqual(at(130000), { value: 92000, preset: null });
  // The magnet's reach is in screen pixels: a smaller stage (more output px per screen px) reaches further.
  const far = dragCaptionY({ startY: 83000, dy: ((61500 - 83000) * 1280) / 100000 / 4, scale: 4, output: P720 });
  assert.deepEqual(far, { value: 60000, preset: "tengah" });
});

test("keys: arrows 0.5 %, Shift and PageUp/PageDown 5 %, Home and End the range's ends; off-grid values step onto the grid", () => {
  assert.equal(nudgedCaptionY(83000, "ArrowUp", false), 82500);
  assert.equal(nudgedCaptionY(83000, "ArrowDown", false), 83500);
  assert.equal(nudgedCaptionY(83000, "ArrowUp", true), 78000);
  assert.equal(nudgedCaptionY(83000, "ArrowDown", true), 88000);
  assert.equal(nudgedCaptionY(83000, "PageUp", false), 78000);
  assert.equal(nudgedCaptionY(83000, "PageDown", false), 88000);
  assert.equal(nudgedCaptionY(83000, "Home", false), 20000);
  assert.equal(nudgedCaptionY(83000, "End", false), 92000);
  assert.equal(nudgedCaptionY(20000, "ArrowUp", false), 20000, "the top end holds");
  assert.equal(nudgedCaptionY(91000, "ArrowDown", true), 92000, "the bottom end holds");
  assert.equal(nudgedCaptionY(61234, "ArrowUp", false), 61000);
  assert.equal(nudgedCaptionY(61234, "ArrowDown", false), 61500);
  for (const key of ["ArrowLeft", "ArrowRight", "Enter", " ", "a"]) assert.equal(nudgedCaptionY(83000, key, false), null, key);
});

test("the commands: a drag is one plain pick, a key merges like the slider", () => {
  assert.equal(dragCommand(83000, 83000), null);
  assert.deepEqual(dragCommand(83000, 60000), { type: "SetCaptionOverride", args: { key: "y_e5", value: 60000 }, mergeKey: null });
  assert.deepEqual(dragCommand(83000, 60000), captionCommand("y_e5", 60000));
  assert.deepEqual(nudgeCommand(82500), { type: "SetCaptionOverride", args: { key: "y_e5", value: 82500 }, mergeKey: "cap:y_e5" });
  assert.deepEqual(nudgeCommand(82500), captionCommand("y_e5", 82500, { drag: true }));
});

test("a drag is drawn locally and stored once on release, however long it takes", () => {
  const drag = createCaptionDrag({ startY: 83000, clientY: 500, scale: 2, output: P720 });
  assert.equal(drag.move(501), null, "under the drag threshold it is a click");
  assert.equal(drag.move(502), null);
  assert.equal(drag.moved, false);
  assert.equal(drag.commit(), null, "a click stores nothing");
  const moving = createCaptionDrag({ startY: 83000, clientY: 500, scale: 2, output: P720 });
  const seen = [];
  for (let y = 497; y >= 400; y -= 7) seen.push(moving.move(y));
  assert.equal(moving.moved, true);
  assert.ok(seen.every((entry) => entry && Number.isSafeInteger(entry.value)));
  // 100 screen px up at 2 output px each = 200 px = 15625 e5 → 67375, on the grid 67500.
  assert.deepEqual(moving.move(400), { value: 67500, preset: null });
  assert.deepEqual(moving.move(380, { magnet: true }), { value: 64500, preset: null });
  assert.deepEqual(moving.move(360), { value: 60000, preset: "tengah" });
  assert.deepEqual(moving.commit(), dragCommand(83000, 60000));
  // Back where it started: nothing to store.
  const back = createCaptionDrag({ startY: 83000, clientY: 500, scale: 2, output: P720 });
  back.move(450);
  back.move(500);
  assert.equal(back.commit(), null);
});

test("undo: one step per drag, even with pauses; keys merge; a drag never merges into a slider or key step", () => {
  let clock = 1_000_000;
  const seed = fakeDoc();
  const session = createEditSession({ doc: seed, ctx: createContext({ words: fakeWords(), seed }), now: () => clock });
  const send = (command) => session.dispatch(command.type, command.args, { mergeKey: command.mergeKey });
  const y = () => session.doc.captions.overrides.y_e5;

  // A slow drag: moves over three seconds (longer than the 500 ms merge window), one command.
  const drag = createCaptionDrag({ startY: y(), clientY: 600, scale: 2, output: P720 });
  for (let step = 1; step <= 8; step += 1) {
    clock += 400;
    drag.move(600 - step * 18);
  }
  send(drag.commit());
  assert.equal(session.history.size, 1);
  assert.equal(y(), 60000);
  // A key right after: its own step; the next keys within 500 ms merge into it.
  clock += 50;
  send(nudgeCommand(nudgedCaptionY(y(), "ArrowUp", false)));
  clock += 50;
  send(nudgeCommand(nudgedCaptionY(y(), "ArrowUp", false)));
  assert.equal(session.history.size, 2);
  assert.equal(y(), 59000);
  // A slider drag (cap:y_e5) right after keeps merging with the keys…
  clock += 50;
  send(captionCommand("y_e5", 58500, { drag: true }));
  assert.equal(session.history.size, 2);
  // …but a gizmo drag right after is a step of its own.
  clock += 50;
  const second = createCaptionDrag({ startY: y(), clientY: 300, scale: 2, output: P720 });
  second.move(260);
  send(second.commit());
  assert.equal(session.history.size, 3);
  // Undo walks back drag, keys and slider, first drag.
  session.undo();
  assert.equal(y(), 58500);
  session.undo();
  assert.equal(y(), 60000);
  session.undo();
  assert.equal(y(), 83000);
  assert.equal(session.canUndo, false);
});

test("the position texts: the slider's label, the gizmo's value text and its read-out", () => {
  assert.equal(captionPositionText(83000), "83% dari atas");
  assert.equal(captionPositionText(61500), "62% dari atas");
  assert.equal(captionValueText(83000), "83% dari atas, Bawah");
  assert.equal(captionValueText(61500), "62% dari atas");
  assert.equal(captionReadout(83000, P720), "83% dari atas · Bawah · area tombol TikTok");
  assert.equal(captionReadout(60000, P720), "60% dari atas · Tengah");
  assert.equal(captionReadout(80000, P720), "80% dari atas · area tombol TikTok");
  assert.equal(captionReadout(70000, P720), "70% dari atas");
});

test("the caption gizmo sits in the stage registry under the logo, and both views share one slider rule", () => {
  assert.deepEqual(GIZMOS.map((gizmo) => [gizmo.id, gizmo.wave, gizmo.component, gizmo.file]),
    [["caption", "W3", "CaptionGizmo", "gizmos/CaptionGizmo.jsx"], ["logo", "W3", "LogoGizmo", "gizmos/LogoGizmo.jsx"]]);
  assert.equal(gizmoById("caption").component, "CaptionGizmo");
  const gizmo = readFileSync(path.join(WEB, "components", "editor", "gizmos", "CaptionGizmo.jsx"), "utf8");
  assert.match(gizmo, /export default function CaptionGizmo\(/);
  const panel = readFileSync(path.join(WEB, "components", "editor", "panels", "TextPanel.jsx"), "utf8");
  // The Teks panel's slider takes its range, grid and label from the same rules as the gizmo.
  assert.match(panel, /min=\{CAPTION_Y_RANGE\[0\]\} max=\{CAPTION_Y_RANGE\[1\]\} step=\{CAPTION_Y_STEP\}/);
  assert.match(panel, /captionPositionText\(overrides\.y_e5\)/);
});
