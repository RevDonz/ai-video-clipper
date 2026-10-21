// The caption gizmo's geometry (CONTRACTS §5.47): the caption block on the 9:16 stage and what a
// drag or a key makes of `captions.overrides.y_e5`, the block's bottom. Pure, in output pixels;
// CaptionGizmo.jsx and its node tests use it.
//
// The bottom is the ASS one (captions_ass._margin_v). The box above it is an estimate from the
// pack's font size, line height and outline: libass draws the text, the box is where to grab it.
import { divRoundHalfUp } from "../../../lib/editor/timemap.mjs";
import {
  CAPTION_POSITIONS, CAPTION_Y_RANGE, CAPTION_Y_STEP, captionCommand, captionPositionText,
} from "../panels/caption-model.mjs";
import { uiZone } from "./logo-geometry.mjs";

export const NUDGE_E5 = CAPTION_Y_STEP; // an arrow key: 0.5 %
export const BIG_NUDGE_E5 = 10 * CAPTION_Y_STEP; // Shift + arrow, PageUp, PageDown: 5 %
export const SNAP_SCREEN_PX = 8; // the presets' magnet on screen, whatever the stage's scale
export const DRAG_START_SCREEN_PX = 3; // a press that moves less than this is a click
const E5 = 100000;

const metrics = (scalePm, outline, lineEmPm, lines) => Object.freeze({ scalePm, outline: Object.freeze(outline), lineEmPm, lines });
// From resources/caption-packs/<id>/v1.json (web/tests/editor-caption-gizmo.test.mjs reads them):
// size scale, outline, the font's line height (DejaVu Sans 1.164 em, Montserrat 1.219 em) and the
// lines of a cue (packs with a max width split wide cues into one line, the others wrap to two).
export const CAPTION_TEXT = Object.freeze({
  size: Object.freeze([12, 288]),
  marginSidePm: 60,
  packs: Object.freeze({
    classic: metrics(1000, [1, 150], 1164, 2),
    karaoke: metrics(1000, [1, 150], 1164, 2),
    bold: metrics(1350, [1, 90], 1219, 2),
    box: metrics(1200, [1, 100], 1219, 1),
    sorot: metrics(1200, [1, 150], 1219, 1),
    sinar: metrics(1100, [1, 320], 1219, 1),
  }),
});

const clamp = (value, low, high) => Math.min(Math.max(value, low), high);
const clampY = (value) => clamp(value, CAPTION_Y_RANGE[0], CAPTION_Y_RANGE[1]);

/** The block's bottom in output pixels: H − MarginV, MarginV = rhu((100000 − y)·H, 100000). */
export function captionBottom(yE5, output) {
  return output.h - divRoundHalfUp((E5 - yE5) * output.h, E5);
}

/** The caption block `{ x, y, w, h, bottom }` in output pixels (`captions` is doc.captions). */
export function captionBox(captions, output) {
  const pack = CAPTION_TEXT.packs[captions?.pack?.id] ?? CAPTION_TEXT.packs.classic;
  const [num, den] = CAPTION_TEXT.size;
  const font = Math.max(1, divRoundHalfUp(output.h * num * pack.scalePm * captions.overrides.size_pm, den * 1_000_000));
  const pitch = divRoundHalfUp(font * pack.lineEmPm, 1000);
  const outline = divRoundHalfUp(output.h * pack.outline[0], pack.outline[1]);
  const x = divRoundHalfUp(output.w * CAPTION_TEXT.marginSidePm, 1000);
  const bottom = captionBottom(captions.overrides.y_e5, output);
  const y = Math.max(0, bottom - pack.lines * pitch - outline);
  return { x, y, w: output.w - 2 * x, h: bottom - y, bottom };
}

/** True when the bottom is in the TikTok zone's bottom band: the server's `unsafe_zone` for captions. */
export function captionInZone(yE5, output) {
  return yE5 * output.h > (output.h - uiZone(output).bottom) * E5;
}

/** Atas, Tengah and Bawah with the line their bottom sits on. */
export function presetGuides(output) {
  return CAPTION_POSITIONS.map(({ id, label, value }) => ({ id, label, value, line: captionBottom(value, output) }));
}

const presetAt = (value) => CAPTION_POSITIONS.find((option) => option.value === value)?.id ?? null;

/**
 * Where a drag puts the bottom: `startY` moved by `dy` screen pixels (`scale` output pixels each).
 * Within SNAP_SCREEN_PX of a preset it is that preset (unless `magnet` is false), else it lands on
 * the slider's grid; always inside the range. → `{ value, preset }` (preset: the id it rests on).
 */
export function dragCaptionY({ startY, dy, scale, output, magnet = true }) {
  const raw = startY + (dy * scale * E5) / output.h;
  const reach = (SNAP_SCREEN_PX * scale * E5) / output.h;
  let snapped = null;
  if (magnet) {
    for (const option of CAPTION_POSITIONS) {
      const distance = Math.abs(option.value - raw);
      if (distance <= reach && (!snapped || distance < snapped.distance)) snapped = { value: option.value, distance };
    }
  }
  const value = clampY(snapped ? snapped.value : Math.round(raw / CAPTION_Y_STEP) * CAPTION_Y_STEP);
  return { value, preset: presetAt(value) };
}

/**
 * A pointer drag from `startY` pressed at `clientY`: `move(clientY, { magnet })` gives the drawn
 * spot (null below the drag threshold), `commit()` the one command to store (null when nothing
 * moved). Nothing is stored while it moves, so a drag is one undo step however long it takes.
 */
export function createCaptionDrag({ startY, clientY, scale, output }) {
  let moved = false;
  let current = { value: startY, preset: presetAt(startY) };
  return {
    get moved() {
      return moved;
    },
    get current() {
      return current;
    },
    move(nextClientY, { magnet = true } = {}) {
      const dy = nextClientY - clientY;
      if (!moved && Math.abs(dy) < DRAG_START_SCREEN_PX) return null;
      moved = true;
      current = dragCaptionY({ startY, dy, scale, output, magnet });
      return current;
    },
    commit() {
      return moved ? dragCommand(startY, current.value) : null;
    },
  };
}

/**
 * The bottom after a key on the gizmo, or null for a key it leaves alone. Up moves the caption up
 * (a smaller `y_e5`); an off-grid value steps onto the grid; Home and End go to the range's ends.
 */
export function nudgedCaptionY(yE5, key, shift) {
  const step = (delta) => {
    const target = yE5 + delta;
    const onGrid = delta < 0 ? Math.ceil(target / CAPTION_Y_STEP) : Math.floor(target / CAPTION_Y_STEP);
    return clampY(onGrid * CAPTION_Y_STEP);
  };
  switch (key) {
    case "ArrowUp": return step(-(shift ? BIG_NUDGE_E5 : NUDGE_E5));
    case "ArrowDown": return step(shift ? BIG_NUDGE_E5 : NUDGE_E5);
    case "PageUp": return step(-BIG_NUDGE_E5);
    case "PageDown": return step(BIG_NUDGE_E5);
    case "Home": return CAPTION_Y_RANGE[0];
    case "End": return CAPTION_Y_RANGE[1];
    default: return null;
  }
}

/** A drag's command: a plain pick (its own undo step), or null when it ends where it began. */
export function dragCommand(startY, endY) {
  return endY === startY ? null : captionCommand("y_e5", endY);
}

/** A key's command: merged with the keys and slider moves around it (`cap:y_e5`), like the slider. */
export function nudgeCommand(value) {
  return captionCommand("y_e5", value, { drag: true });
}

/** The gizmo's `aria-valuetext`: "83% dari atas, Bawah". */
export function captionValueText(yE5) {
  const preset = CAPTION_POSITIONS.find((option) => option.value === yE5);
  return preset ? `${captionPositionText(yE5)}, ${preset.label}` : captionPositionText(yE5);
}

/** The read-out beside the box while it moves: "83% dari atas · Bawah · area tombol TikTok". */
export function captionReadout(yE5, output) {
  const preset = CAPTION_POSITIONS.find((option) => option.value === yE5);
  return [captionPositionText(yE5), preset?.label, captionInZone(yE5, output) ? "area tombol TikTok" : null]
    .filter(Boolean).join(" · ");
}
