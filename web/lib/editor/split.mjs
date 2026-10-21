// Layar terbagi (CONTRACTS §5.45): the browser mirror of src/ai_clipper/edit_v2/layouts.py
// `split_bands`, `split_crop` and `split_geometry`. Both are checked against
// tests/fixtures/edit_v2/split-vectors.json, so the boxes the gizmo draws are the crops the
// render takes, to the pixel. Pure functions, no DOM.
//
// Geometry: the output is two bands stacked with a 1 px black line between them. A band shows a
// crop of the source: the largest box of the band's shape at zoom 1000, divided by the zoom, every
// side and offset rounded to even, placed by `x_e5`/`y_e5` from edge (0) to edge (100000).
import { PAN_E5_MAX, SPLIT_BANDS, SPLIT_TOP_PM, SPLIT_ZOOM_RANGE, defaultSplit } from "./doc-model.mjs";
import { divRoundHalfUp } from "./timemap.mjs";

export { defaultSplit };

const CROP_KEYS = Object.freeze(["x_e5", "y_e5", "zoom_pm"]);

const pair = (value, name) => {
  const [w, h] = Array.isArray(value) ? value : [value?.w, value?.h];
  if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w <= 0 || h <= 0) throw new TypeError(`${name} must be [w, h]`);
  return [w, h];
};
const intIn = (value, lo, hi) => Number.isSafeInteger(value) && value >= lo && value <= hi;
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Throws unless `split` is a valid `layout.split` (layouts.check_split). */
export function checkSplit(split) {
  if (!isObject(split)) throw new TypeError("layout.split is an object");
  const keys = Object.keys(split);
  if (keys.length !== 1 + SPLIT_BANDS.length || !keys.every((key) => key === "top_pm" || SPLIT_BANDS.includes(key))) {
    throw new RangeError("layout.split holds top_pm, top and bottom");
  }
  if (!SPLIT_TOP_PM.includes(split.top_pm)) throw new RangeError("top_pm must be 300, 500 or 700");
  for (const band of SPLIT_BANDS) {
    const crop = split[band];
    if (!isObject(crop)) throw new TypeError("a band's crop is an object");
    const cropKeys = Object.keys(crop);
    if (cropKeys.length !== CROP_KEYS.length || !cropKeys.every((key) => CROP_KEYS.includes(key))) {
      throw new RangeError("a band's crop holds x_e5, y_e5 and zoom_pm");
    }
    if (!intIn(crop.x_e5, 0, PAN_E5_MAX) || !intIn(crop.y_e5, 0, PAN_E5_MAX) || !intIn(crop.zoom_pm, ...SPLIT_ZOOM_RANGE)) {
      throw new RangeError("x_e5 and y_e5 in 0..100000, zoom_pm in 1000..5000");
    }
  }
}

/** The two bands' sizes, top then bottom: `top_pm` per mille of the H − 1 rows beside the line on top. */
export function splitBands(output, topPm) {
  const [width, height] = pair(output, "output");
  if (!SPLIT_TOP_PM.includes(topPm)) throw new RangeError("top_pm must be 300, 500 or 700");
  const top = divRoundHalfUp((height - 1) * topPm, 1000);
  return [[width, top], [width, height - 1 - top]];
}

const even = (numerator, denominator) => 2 * divRoundHalfUp(numerator, 2 * denominator);

/** `[x, y, w, h]` of the source a band of size `band` shows for `crop` (layouts.split_crop). */
export function splitCrop(source, band, crop) {
  const [srcW, srcH] = pair(source, "source");
  const [bandW, bandH] = pair(band, "band");
  const zoom = crop.zoom_pm;
  let w;
  let h;
  if (srcW * bandH >= srcH * bandW) {
    w = even(srcH * bandW * 1000, bandH * zoom);
    h = even(srcH * 1000, zoom);
  } else {
    w = even(srcW * 1000, zoom);
    h = even(srcW * bandH * 1000, bandW * zoom);
  }
  w = Math.min(Math.max(w, 2), srcW - (srcW % 2));
  h = Math.min(Math.max(h, 2), srcH - (srcH % 2));
  const travelX = (srcW - w) - ((srcW - w) % 2);
  const travelY = (srcH - h) - ((srcH - h) % 2);
  const x = even(crop.x_e5 * travelX, PAN_E5_MAX);
  const y = even(crop.y_e5 * travelY, PAN_E5_MAX);
  return [Math.min(x, travelX), Math.min(y, travelY), w, h];
}

/** `{line, top: {y, size, crop}, bottom: {y, size, crop}}` (layouts.split_geometry). */
export function splitGeometry(split, { source, output }) {
  checkSplit(split);
  const [top, bottom] = splitBands(output, split.top_pm);
  const line = top[1];
  return {
    line,
    top: { y: 0, size: top, crop: splitCrop(source, top, split.top) },
    bottom: { y: line + 1, size: bottom, crop: splitCrop(source, bottom, split.bottom) },
  };
}

/** The document's split (null under the other layouts). */
export function splitOf(doc) {
  return doc?.layout?.default?.mode === "split" ? doc.layout.split ?? null : null;
}

/** The ratio a pill shows: "30_70" (in either order) or "50_50". */
export function splitRatio(split) {
  return split?.top_pm === 500 ? "50_50" : "30_70";
}

/** "Tukar": the crops change places and the bands keep their crop, so the small band moves with its picture. */
export function swappedSplit(split) {
  return { top_pm: 1000 - split.top_pm, top: split.bottom, bottom: split.top };
}
