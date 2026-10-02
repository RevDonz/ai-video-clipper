// The cold-open transition in the browser (spec 2026-10-02 §5): the plan DTO's joins as a
// full-frame blend toward a colour, applied to the plate frame on the canvas and under the text.
// The server blends the same colour into the composite's RGB before the text (lutrgb), so plates
// stay per source frame and the blend comes from the plan alone. The whoosh is in the server mix;
// `sfx` is informational here.
//
// The blend is the export's own integer arithmetic per pixel (§2.3), not a globalAlpha fill:
// Skia's 8-bit alpha rounds ±1 differently, which fails P-JOIN-B's SSIM on dark frames.

export const JOIN_STYLES = Object.freeze(["cut", "flash_white", "dip_black"]);

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isByte = (value) => Number.isInteger(value) && value >= 0 && value <= 255;

/**
 * True when `joins` is absent or a list of DTO joins: a known style, `atF` in [0, totalFrames],
 * `rgb` null exactly for a cut, `alphaPm` [frame, alpha] pairs with frames strictly increasing in
 * [0, totalFrames) and alphas 1–1000 (empty exactly when `rgb` is null), `sfx` null or an object.
 * No frame may be claimed by two joins: one fill per frame.
 */
export function joinsValid(joins, totalFrames) {
  if (joins === undefined) return true;
  if (!Array.isArray(joins)) return false;
  const claimed = new Set();
  for (const join of joins) {
    if (!isObject(join) || !JOIN_STYLES.includes(join.style)) return false;
    if (!Number.isSafeInteger(join.atF) || join.atF < 0 || join.atF > totalFrames) return false;
    const cut = join.style === "cut";
    if (cut ? join.rgb !== null : !(Array.isArray(join.rgb) && join.rgb.length === 3 && join.rgb.every(isByte))) {
      return false;
    }
    if (!Array.isArray(join.alphaPm) || (cut ? join.alphaPm.length !== 0 : join.alphaPm.length === 0)) return false;
    let last = -1;
    for (const pair of join.alphaPm) {
      if (!Array.isArray(pair) || pair.length !== 2) return false;
      const [frame, alpha] = pair;
      if (!Number.isSafeInteger(frame) || frame <= last || frame >= totalFrames || claimed.has(frame)) return false;
      if (!Number.isInteger(alpha) || alpha < 1 || alpha > 1000) return false;
      last = frame;
    }
    for (const [frame] of join.alphaPm) claimed.add(frame);
    if (join.sfx !== undefined && join.sfx !== null && !isObject(join.sfx)) return false;
  }
  return true;
}

/** Map<frame, {rgb: [r, g, b], alphaPm}> of a plan DTO's joins (missing joins = none). */
export function joinOverlays(joins = []) {
  const overlays = new Map();
  for (const join of joins ?? []) {
    if (!join.rgb) continue;
    const rgb = Object.freeze([...join.rgb]);
    for (const [frame, alphaPm] of join.alphaPm) overlays.set(frame, Object.freeze({ rgb, alphaPm }));
  }
  return overlays;
}

/** The fill of output frame n, or null. */
export function overlayAt(overlays, n) {
  return overlays.get(n) ?? null;
}

const tables = new Map(); // colour·1001 + alphaPm → Uint8Array(256)

/** The export's lutrgb for one channel: out = ⌊(p·(1000 − a) + C·a + 500) / 1000⌋ per level p. */
export function blendTable(colour, alphaPm) {
  const key = colour * 1001 + alphaPm;
  let table = tables.get(key);
  if (!table) {
    table = new Uint8Array(256);
    for (let p = 0; p < 256; p += 1) table[p] = Math.floor((p * (1000 - alphaPm) + colour * alphaPm + 500) / 1000);
    if (tables.size >= 64) tables.clear();
    tables.set(key, table);
  }
  return table;
}

/** Blends RGBA pixels toward the overlay's colour in place; alpha is left as it is. */
export function blendPixels(rgba, overlay) {
  const [r, g, b] = overlay.rgb.map((colour) => blendTable(colour, overlay.alphaPm));
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = r[rgba[i]];
    rgba[i + 1] = g[rgba[i + 1]];
    rgba[i + 2] = b[rgba[i + 2]];
  }
  return rgba;
}

/** Blends the whole canvas (the plate frame just drawn) toward the overlay (nothing without one). */
export function drawOverlay(ctx, overlay, width, height) {
  if (!overlay) return;
  const image = ctx.getImageData(0, 0, width, height);
  blendPixels(image.data, overlay);
  ctx.putImageData(image, 0, 0);
}
