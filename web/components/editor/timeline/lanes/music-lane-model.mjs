// Geometry of the music lane (plan §4.3 `audio.musicGainPoints`, Appendix C.3): the duck and fade
// envelope drawn vertex for vertex from the plan's breakpoints, and the track's waveform (the
// asset's peaks, §5.7 format) laid out through the start offset and the loop, scaled by that same
// envelope. The audible gain always comes from the server mix; this only draws it. Pure; no DOM.

const RATE = 48_000;
const UNITY_E6 = 1_000_000;

/** The lane's vertical scale ends here: quieter than this (and silence) sits on the bottom edge. */
export const ENVELOPE_FLOOR_DB = -40;

/** x on the timeline of an output sample (frame = sample·num / (48000·den)). */
export function sampleToX(sample, fps, pxPerFrame) {
  const [num, den] = fps;
  return (sample * num * pxPerFrame) / (RATE * den);
}

/** The top of the lane: the item's own gain, or the loudest breakpoint when that is higher. */
export function envelopeRef(points, gainCdb) {
  const own = Math.round(10 ** (gainCdb / 2000) * UNITY_E6);
  return points.reduce((max, [, gain]) => Math.max(max, gain), own);
}

/** y of a gain (gain_e6): 0 at `refE6`, `height` at ENVELOPE_FLOOR_DB below it or silence. */
export function gainToY(gainE6, refE6, height) {
  if (!(gainE6 > 0) || !(refE6 > 0)) return height;
  const db = Math.min(0, Math.max(ENVELOPE_FLOOR_DB, 20 * Math.log10(gainE6 / refE6)));
  return db >= 0 ? 0 : (db / ENVELOPE_FLOOR_DB) * height;
}

/** One [x, y] per plan breakpoint, in the plan's order. */
export function envelopePoints(points, { fps, pxPerFrame, refE6, height }) {
  return points.map(([sample, gain]) => [sampleToX(sample, fps, pxPerFrame), gainToY(gain, refE6, height)]);
}

/** The gain (gain_e6) at an output sample: linear between breakpoints, held past the ends. */
export function gainAt(points, sample) {
  if (!points.length) return 0;
  if (sample <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i += 1) {
    const [s1, g1] = points[i];
    if (sample <= s1) {
      const [s0, g0] = points[i - 1];
      return s1 === s0 ? g1 : g0 + ((g1 - g0) * (sample - s0)) / (s1 - s0);
    }
  }
  return points[points.length - 1][1];
}

/** The music file position (ms) heard at an output sample, or null once a non-looping track ended. */
export function musicSourceMs(outSample, payload, durationMs) {
  const totalSmp = durationMs * 48;
  if (!(totalSmp > 0)) return null;
  const position = payload.src_in_smp + outSample;
  if (position < totalSmp) return position / 48;
  if (!payload.loop) return null;
  return (position % totalSmp) / 48; // -stream_loop restarts the file from its start
}

/** Peaks (§5.7): signed (min, max) byte pairs, one pair per 10 ms. */
export function decodePeaks(buffer) {
  const bytes = new Int8Array(buffer);
  const bins = Math.floor(bytes.length / 2);
  const min = new Int8Array(bins);
  const max = new Int8Array(bins);
  for (let i = 0; i < bins; i += 1) {
    min[i] = bytes[2 * i];
    max[i] = bytes[2 * i + 1];
  }
  return { bins, min, max, perSec: 100 };
}

function peakAt(peaks, ms) {
  const bin = Math.floor(ms / 10);
  if (bin < 0 || bin >= peaks.bins) return 0;
  return Math.max(-peaks.min[bin], peaks.max[bin]) / 128;
}

/**
 * Waveform columns across the clip: `{x, w, amp}` with amp in 0..1 (the file's peak level times
 * the envelope's gain relative to `refE6`). At most `maxColumns` columns, each ≥ `columnPx` wide.
 */
export function waveformColumns({ peaks, payload, durationMs, points, fps, pxPerFrame, totalFrames, refE6,
  columnPx = 2, maxColumns = 6000 }) {
  const width = totalFrames * pxPerFrame;
  if (!peaks || !(width > 0) || !(refE6 > 0)) return [];
  const count = Math.max(1, Math.min(maxColumns, Math.ceil(width / columnPx)));
  const step = width / count;
  const [num, den] = fps;
  const samplesPerPx = (RATE * den) / (num * pxPerFrame);
  const columns = [];
  for (let c = 0; c < count; c += 1) {
    const x = c * step;
    const s0 = x * samplesPerPx;
    const s1 = (x + step) * samplesPerPx;
    let level = 0;
    // One probe per 10 ms bin inside the column (at least two), so loud bins are never skipped.
    const probes = Math.max(2, Math.ceil((s1 - s0) / 480));
    for (let p = 0; p < probes; p += 1) {
      const ms = musicSourceMs(s0 + ((s1 - s0) * p) / probes, payload, durationMs);
      if (ms !== null) level = Math.max(level, peakAt(peaks, ms));
    }
    const gain = gainAt(points, (s0 + s1) / 2) / refE6;
    columns.push({ x, w: step, amp: Math.min(1, level * gain) });
  }
  return columns;
}

/** An SVG path of the columns as bars centred on the lane (one sub-path per audible column). */
export function waveformPath(columns, height) {
  const middle = height / 2;
  let path = "";
  for (const { x, w, amp } of columns) {
    if (!(amp > 0)) continue;
    const half = Math.max(0.5, amp * middle);
    const width = Math.max(0.5, w * 0.8);
    path += `M${x.toFixed(2)} ${(middle - half).toFixed(2)}h${width.toFixed(2)}v${(2 * half).toFixed(2)}h${(-width).toFixed(2)}z`;
  }
  return path;
}
