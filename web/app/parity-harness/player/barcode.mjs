// Barcode read-back for the player parity harness (plan §10.1 P-FRAME in the browser). A port of
// tests/support/edit_v2_media.py (Pattern.for_size, render_luma, decode_index, decode_ruler,
// decode_crop_x): every synthetic source frame carries its frame index as 27 full-width bands
// (white sync, black sync, 24 bits MSB first, even parity) and a Gray-coded column ruler, so the
// source frame and the crop x can be read from any rendered output frame. Planes are 8-bit luma
// (or any one channel of a neutral RGB frame), row-major.

export const INDEX_BITS = 24;
export const INDEX_BANDS = INDEX_BITS + 3;
const WHITE = 235;
const BLACK = 16;
const GREY = 128;
const SYNC_MIN_CONTRAST = 80;

export function pattern(width, height) {
  if (width % 2 || height % 2 || width < 16 || height < 16) {
    throw new RangeError("barcode sources need even dimensions of at least 16 px");
  }
  const bandH = Math.max(4, Math.floor(height / 64) & ~1);
  const rulerBits = Math.max(1, (width - 1).toString(2).length);
  return { width, height, bandH, rulerBits };
}

export function grayCode(value) {
  return value ^ (value >> 1);
}

export function grayDecode(code) {
  let value = code;
  for (let shift = code >> 1; shift; shift >>= 1) value ^= shift;
  return value;
}

function indexBits(index) {
  const bits = [];
  for (let bit = INDEX_BITS - 1; bit >= 0; bit -= 1) bits.push(((index >> bit) & 1) === 1);
  const parity = bits.filter(Boolean).length % 2 === 1;
  return [true, false, ...bits, parity];
}

/** The luma plane of barcode frame `index` (uncompressed), as edit_v2_media.render_luma. */
export function renderLuma(p, index) {
  const plane = new Uint8Array(p.width * p.height).fill(GREY);
  let y = 0;
  for (const on of indexBits(index)) {
    plane.fill(on ? WHITE : BLACK, y * p.width, (y + p.bandH) * p.width);
    y += p.bandH;
  }
  for (let band = 0; band < p.rulerBits; band += 1) {
    const bit = p.rulerBits - 1 - band;
    for (let row = 0; row < p.bandH; row += 1, y += 1) {
      for (let x = 0; x < p.width; x += 1) plane[y * p.width + x] = (grayCode(x) >> bit) & 1 ? WHITE : BLACK;
    }
  }
  return plane;
}

function row(p, band, scale, top, height) {
  const y = top + (band + 0.5) * p.bandH * scale;
  return Math.min(Math.max(Math.floor(y), 0), height - 1);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

function columns(width) {
  return Array.from({ length: 9 }, (_, k) => Math.floor((width * (k + 0.5)) / 9));
}

function syncLevels(plane, width, height, p, scale, top) {
  const xs = columns(width);
  const levels = [0, 1].map((band) => {
    const offset = row(p, band, scale, top, height) * width;
    return median(xs.map((x) => plane[offset + x]));
  });
  const [white, black] = levels;
  return white - black < SYNC_MIN_CONTRAST ? null : levels;
}

/** The frame index of a plane whose source rows were scaled by `scale` and shifted to `top`. */
export function decodeIndex(plane, width, height, p, { scale = 1, top = 0 } = {}) {
  const levels = syncLevels(plane, width, height, p, scale, top);
  if (!levels) return null;
  const threshold = (levels[0] + levels[1]) / 2;
  const xs = columns(width);
  const bits = [];
  for (let band = 2; band < INDEX_BANDS; band += 1) {
    const offset = row(p, band, scale, top, height) * width;
    bits.push(median(xs.map((x) => plane[offset + x])) > threshold);
  }
  let value = 0;
  let ones = 0;
  for (let i = 0; i < INDEX_BITS; i += 1) {
    value = value * 2 + (bits[i] ? 1 : 0);
    if (bits[i]) ones += 1;
  }
  return bits[INDEX_BITS] === (ones % 2 === 1) ? value : null;
}

/** The source column shown in each output column. */
export function decodeRuler(plane, width, height, p, { scale = 1, top = 0 } = {}) {
  const levels = syncLevels(plane, width, height, p, scale, top);
  const threshold = levels ? (levels[0] + levels[1]) / 2 : 128;
  const rows = Array.from({ length: p.rulerBits }, (_, band) => row(p, INDEX_BANDS + band, scale, top, height) * width);
  const out = new Array(width);
  for (let x = 0; x < width; x += 1) {
    let code = 0;
    for (const offset of rows) code = (code << 1) | (plane[offset + x] > threshold ? 1 : 0);
    out[x] = grayDecode(code);
  }
  return out;
}

/** The crop x (in the scaled source) of a crop layout: the x most output columns agree on. */
export function decodeCropX(plane, width, height, p, { scale, top = 0 }) {
  const cols = decodeRuler(plane, width, height, p, { scale, top });
  const limit = Math.ceil(p.width * scale) - width;
  if (limit < 0) return null;
  const votes = new Int32Array(limit + 2);
  cols.forEach((column, j) => {
    const low = Math.max(Math.ceil(column * scale - j - 0.5), 0);
    const high = Math.min(Math.ceil((column + 1) * scale - j - 0.5) - 1, limit);
    if (low <= high) {
      votes[low] += 1;
      votes[high + 1] -= 1;
    }
  });
  let best = null;
  let bestVotes = 0;
  let running = 0;
  for (let x = 0; x <= limit; x += 1) {
    running += votes[x];
    if (running > bestVotes) {
      best = x;
      bestVotes = running;
    }
  }
  return bestVotes * 2 >= width ? best : null;
}

/** One channel (green) of an RGBA buffer as a luma-like plane. */
export function planeFromRgba(rgba, width, height) {
  const plane = new Uint8Array(width * height);
  for (let i = 0, o = 1; i < plane.length; i += 1, o += 4) plane[i] = rgba[o];
  return plane;
}
