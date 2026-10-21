// The output sizes of a clip and what each one means for the frame (CONTRACTS §5.53): the
// edit_v2 package's OUTPUT_SIZES, ui_zone, frame_margins and text_height in the browser. Pure;
// web/tests/output-frame.test.mjs keeps the numbers equal to the Python ones.
import { divRoundHalfUp } from "./editor/timemap.mjs";

/** "Rasio" × "Resolusi" on the dashboard: the job option `outputSize` and its pixels. */
export const OUTPUT_SIZES = Object.freeze({
  "720x1280": Object.freeze({ w: 720, h: 1280 }),
  "1080x1920": Object.freeze({ w: 1080, h: 1920 }),
  "720x720": Object.freeze({ w: 720, h: 720 }),
  "1080x1080": Object.freeze({ w: 1080, h: 1080 }),
});
/** A job without `outputSize` renders at 720×1280 (web/scripts/run-job.mjs). */
export const DEFAULT_OUTPUT_SIZE = "720x1280";

// The TikTok UI zone at 720×1280 (plan §5.9 G5), scaled to other 9:16 sizes; none at 1:1.
export const UI_ZONE_720 = Object.freeze({ top: 93, bottom: 280, right: 93 });
// The left margin of a logo preset and of the text watermark (per mille of the width), kept on
// every side at 1:1.
export const EDGE_MARGIN_PM = 40;

/** True for a 9:16 output `{ w, h }`, false for 1:1. */
export function isPortrait(output) {
  return output.h > output.w;
}

/** The TikTok UI zone in output pixels, `{ top, bottom, right }`: all 0 at 1:1. */
export function uiZone(output) {
  if (!isPortrait(output)) return { top: 0, bottom: 0, right: 0 };
  return {
    top: divRoundHalfUp(UI_ZONE_720.top * output.h, 1280),
    bottom: divRoundHalfUp(UI_ZONE_720.bottom * output.h, 1280),
    right: divRoundHalfUp(UI_ZONE_720.right * output.w, 720),
  };
}

/** What a logo preset keeps from the edges, `{ top, bottom, right }`: the zone, or 4 % at 1:1. */
export function frameMargins(output) {
  if (isPortrait(output)) return uiZone(output);
  const margin = divRoundHalfUp(output.w * EDGE_MARGIN_PM, 1000);
  return { top: margin, bottom: margin, right: margin };
}

/** The height text is sized from: the output's at 9:16, the 9:16 frame of its width at 1:1. */
export function textHeight(output) {
  return Math.max(output.h, divRoundHalfUp(16 * output.w, 9));
}

/** "9:16" or "1:1". */
export function ratioName(output) {
  return isPortrait(output) ? "9:16" : "1:1";
}
