// Layar terbagi (CONTRACTS §5.45): the words the panel, the Tata letak card and "Atur layar
// terbagi" show, their commands, and the dialog's view of the bands. Pure functions, no DOM;
// SplitDialog.jsx, panels/LayoutPanel.jsx, quick/LayoutCard.jsx and the node tests use them.
//
// The dialog draws one box per band over the source picture (the latar blur still of
// framing-model.mjs `sourceFrameDoc`) and the 9:16 result beside it, both from
// web/lib/editor/split.mjs, the render's own crops. A drag or a zoom is drawn from a draft and
// stored once, on release.
import { SPLIT_BANDS } from "../../lib/editor/doc-model.mjs";
import { splitGeometry, splitOf, splitRatio } from "../../lib/editor/split.mjs";

const option = (fields) => Object.freeze(fields);

/** "30/70" keeps its order (Tukar flips it); "50/50" halves the height. */
export const SPLIT_RATIOS = Object.freeze([
  option({ id: "30_70", label: "30/70", title: "Satu potongan kecil dan satu besar" }),
  option({ id: "50_50", label: "50/50", title: "Dua potongan sama besar" }),
]);

export const BAND_OPTIONS = Object.freeze([
  option({ id: "top", label: "Atas" }),
  option({ id: "bottom", label: "Bawah" }),
]);

/** 1000 per mille is 100 %: the largest box of the band's shape. */
export const zoomPercent = (zoomPm) => Math.round(zoomPm / 10);

/** `{ratio, top, bottom, text}` of the document's split (shares in percent, top first), or null. */
export function splitSummary(doc) {
  const split = splitOf(doc);
  if (!split) return null;
  const top = split.top_pm / 10;
  const bottom = 100 - top;
  return { ratio: splitRatio(split), top, bottom, text: `Atas ${top}%, bawah ${bottom}%.` };
}

/** SetSplitRatio for a pill: 30/70 keeps the current order of the small band. */
export function splitRatioCommand(ratio, split) {
  if (!SPLIT_RATIOS.some((entry) => entry.id === ratio)) throw new TypeError(`unknown split ratio: ${ratio}`);
  const topPm = ratio === "50_50" ? 500 : split?.top_pm === 700 ? 700 : 300;
  return { type: "SetSplitRatio", args: { top_pm: topPm }, mergeKey: null };
}

/** "Tukar": the crops change places, so the small band moves with its picture. */
export function swapSplitCommand() {
  return { type: "SwapSplit", args: {}, mergeKey: null };
}

/** SetSplitCrop of one band; the steps of a drag or a zoom of that band are one undo step. */
export function splitCropCommand(band, crop) {
  if (!SPLIT_BANDS.includes(band)) throw new TypeError(`unknown split band: ${band}`);
  return { type: "SetSplitCrop", args: { band, x_e5: crop.x_e5, y_e5: crop.y_e5, zoom_pm: crop.zoom_pm }, mergeKey: `split:${band}` };
}

/**
 * The dialog's bands: `{split, geometry, source, output}` with `draft` (`{band, crop}`, a drag or a
 * zoom in progress) drawn in place of that band; null outside the split.
 */
export function splitView({ doc, draft = null }) {
  const current = splitOf(doc);
  if (!current) return null;
  const split = draft ? { ...current, [draft.band]: draft.crop } : current;
  const source = [doc.base.source.w, doc.base.source.h];
  const output = [doc.output.w, doc.output.h];
  return { split, geometry: splitGeometry(split, { source, output }), source, output };
}
