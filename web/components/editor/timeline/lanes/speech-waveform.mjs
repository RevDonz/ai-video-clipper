// The speech waveform of the audio lane (plan §11.3 T3.7, §3.6 "Peaks", Appendix C.3).
//
// Peaks are the clip's `peaks.<sha16>.bin` (CONTRACTS §5.7): signed (min, max) byte pairs, 100
// per second from `words.peaks.start_ms`, served by GET …/media/peaks/<file>. The waveform is
// laid out per piece of the current document: each piece draws its own source span at its
// output frames, so a cut closes the gap in the waveform exactly where it closes in the video.
// Shapes are SVG paths in frame units (x) and ±1 (y), normalised to the loudest bin of the
// window; bins are merged into columns of about `columnPx` pixels at the current zoom.
export const PEAKS_PER_SEC = 100;
export const PEAKS_FILE = /^peaks\.[0-9a-f]{16}\.bin$/;
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLIP_ID = /^clip_[0-9a-f]{24}$/;
const MIN_AMPLITUDE = 8; // never blow a near-silent window up to full height
const CACHE_SIZE = 8;

/** The peaks URL of the store state's clip, built only from checked ids and a checked name. */
export function peaksUrl(state) {
  const peaks = state?.words?.peaks;
  if (!peaks || peaks.per_sec !== PEAKS_PER_SEC || typeof peaks.file !== "string" || !PEAKS_FILE.test(peaks.file)) return null;
  if (typeof state.jobId !== "string" || !JOB_ID.test(state.jobId)) return null;
  if (typeof state.clipId !== "string" || !CLIP_ID.test(state.clipId)) return null;
  return `/api/jobs/${state.jobId}/clips/${state.clipId}/media/peaks/${peaks.file}`;
}

export function decodePeaks(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength % 2 !== 0) throw new Error("peaks: expected (min, max) byte pairs");
  return new Int8Array(buffer);
}

const cache = new Map();

/** The peaks of `url` (fetched once per page; a failure is not cached). */
export function loadPeaks(url, { fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  if (cache.has(url)) return cache.get(url);
  const pending = (async () => {
    const response = await fetchImpl(url, { credentials: "same-origin", cache: "force-cache" });
    if (!response.ok) throw new Error(`peaks: HTTP ${response.status}`);
    return decodePeaks(await response.arrayBuffer());
  })();
  cache.set(url, pending);
  pending.catch(() => { if (cache.get(url) === pending) cache.delete(url); });
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
  return pending;
}

function amplitude(peaks) {
  let top = MIN_AMPLITUDE;
  for (const value of peaks) top = Math.max(top, Math.abs(value));
  return top;
}

const fixed = (value) => Number(value.toFixed(3));

/**
 * `{total, amp, shapes}`: one shape per piece `{key, i, seg, role, f0, f1, d}`, where `d` runs
 * along the column maxima from the piece's first frame to its last and back along the minima.
 */
export function waveformShapes({ peaks, peaksInfo, pieces, fps, pxPerFrame, columnPx = 2 }) {
  const [num, den] = fps;
  const bins = Math.floor(peaks.length / 2);
  const binMs = 1000 / (peaksInfo?.per_sec ?? PEAKS_PER_SEC);
  const startMs = peaksInfo?.start_ms ?? 0;
  const framesPerMs = num / (1000 * den);
  const pxPerBin = binMs * framesPerMs * Math.max(pxPerFrame, 1e-6);
  const step = Math.max(1, Math.ceil(columnPx / pxPerBin));
  const amp = amplitude(peaks);
  const total = pieces.length ? pieces.at(-1).outF0 + pieces.at(-1).frames : 0;

  const shapes = pieces.map((piece) => {
    const pieceStart = (piece.inSf * 1000 * den) / num;
    const pieceEnd = (piece.outSf * 1000 * den) / num;
    const first = Math.max(0, Math.floor((pieceStart - startMs) / binMs));
    const last = Math.min(bins, Math.ceil((pieceEnd - startMs) / binMs));
    const x = (ms) => piece.outF0 + (ms - pieceStart) * framesPerMs;
    const columns = [];
    for (let bin = first; bin < last; bin += step) {
      const end = Math.min(bin + step, last);
      let low = 127;
      let high = -128;
      for (let j = bin; j < end; j += 1) {
        low = Math.min(low, peaks[2 * j]);
        high = Math.max(high, peaks[2 * j + 1]);
      }
      const a = Math.max(pieceStart, startMs + bin * binMs);
      const b = Math.min(pieceEnd, startMs + end * binMs);
      columns.push({ x: x((a + b) / 2), top: -Math.max(0, high) / amp, bottom: -Math.min(0, low) / amp });
    }
    if (!columns.length) columns.push({ x: piece.outF0, top: 0, bottom: 0 });
    const f0 = piece.outF0;
    const f1 = piece.outF0 + piece.frames;
    const tops = [[f0, columns[0].top], ...columns.map((c) => [c.x, c.top]), [f1, columns.at(-1).top]];
    const bottoms = [[f1, columns.at(-1).bottom], ...columns.map((c) => [c.x, c.bottom]).reverse(), [f0, columns[0].bottom]];
    const d = [...tops, ...bottoms].map(([px, py], k) => `${k ? "L" : "M"}${fixed(px)} ${fixed(py)}`).join("") + "Z";
    return { key: `${piece.seg}:${piece.i}`, i: piece.i, seg: piece.seg, role: piece.role, f0, f1, d };
  });
  return { total, amp, shapes };
}
