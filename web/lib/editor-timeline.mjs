// Timeline scrubbing for the clip editor.
//
// The native <video controls> scrubber handed the media pipeline a fresh seek
// for every pointer event, and each seek repainted a blurred full-surface
// backdrop. Measured on this machine, that blurred backdrop alone costs about a
// fifth of the page's render throughput (151-157 rendered frames per drag
// against 196 with the blur removed). The timeline below keeps dragging in the
// compositor: the playhead is positioned from these pure fractions, and the
// decoder is only asked to seek on release or ten times a second at most.

export const TIMELINE_SCRUB_INTERVAL_MS = 100;
const MIN_BLOCK_PERCENT = 0.4;

const round = (value) => Math.round(value * 10_000) / 10_000;
const clampUnit = (value) => (value < 0 ? 0 : value > 1 ? 1 : value);

function usableBounds(timeline) {
  if (!timeline || typeof timeline !== "object") return null;
  const { start, end } = timeline;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end, span: end - start };
}

export function scrubFraction(clientX, rect) {
  if (!rect || typeof rect !== "object") return 0;
  const { left, width } = rect;
  if (!Number.isFinite(left) || !Number.isFinite(width) || width <= 0) return 0;
  if (!Number.isFinite(clientX)) return 0;
  return round(clampUnit((clientX - left) / width));
}

export function timelineTimeAt(fraction, timeline) {
  const bounds = usableBounds(timeline);
  if (!bounds) return Number.isFinite(timeline?.start) ? timeline.start : 0;
  if (!Number.isFinite(fraction)) return bounds.start;
  return round(bounds.start + clampUnit(fraction) * bounds.span);
}

export function timelineOffsetFraction(time, timeline) {
  const bounds = usableBounds(timeline);
  if (!bounds || !Number.isFinite(time)) return 0;
  return round(clampUnit((time - bounds.start) / bounds.span));
}

export function shouldCommitScrub({ phase, lastSeekAt = 0, now = 0 }) {
  if (phase === "start" || phase === "end") return true;
  if (phase !== "move") return false;
  if (!Number.isFinite(lastSeekAt) || !Number.isFinite(now)) return false;
  return now - lastSeekAt >= TIMELINE_SCRUB_INTERVAL_MS;
}

export function layoutCueBlocks(cues, timeline) {
  const bounds = usableBounds(timeline);
  if (!bounds || !Array.isArray(cues)) return [];
  const blocks = [];
  for (const cue of cues) {
    if (!cue || typeof cue !== "object") continue;
    const { cue_id: cueId, start, end, text } = cue;
    if (typeof cueId !== "string" || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const visibleStart = Math.max(start, bounds.start);
    const visibleEnd = Math.min(end, bounds.end);
    if (visibleEnd <= visibleStart) continue;
    const leftPercent = round(((visibleStart - bounds.start) / bounds.span) * 100);
    const rawWidth = round(((visibleEnd - visibleStart) / bounds.span) * 100);
    blocks.push({
      cueId,
      text: typeof text === "string" ? text : "",
      leftPercent,
      widthPercent: Math.max(rawWidth, MIN_BLOCK_PERCENT),
    });
  }
  return blocks;
}
