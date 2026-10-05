// Mode Cepat's scrubber (docs/plans/2026-10-02-editor-mode-cepat.md §7): which marks it draws and
// how frames, pixels and keys map onto each other. Pure. The laughs and pauses are the timeline's
// own markers (timeline/lanes/markers.mjs, the time map's word rule, so the frames equal the
// marker lane's), the cold-open range comes from the time map's pieces and the join mark from
// the Transisi model; the scale is the plan's `totalFrames`, as the marker lane uses it.
import { JOIN_STYLE_NAMES } from "../../../lib/editor/doc-model.mjs";
import { pieces as docPieces } from "../../../lib/editor/timemap.mjs";
import { transitionView } from "../panels/coldopen-transition.mjs";
import { formatClock, frameToMs } from "../shell-model.mjs";
import { buildMarkers, markerText } from "../timeline/lanes/markers.mjs";

/** Drawn marks closer than this merge into one dot. */
export const MERGE_PX = 6;
/** A press this close to a mark seeks to the mark. */
export const SNAP_PX = 6;

const KIND_NAMES = Object.freeze({ laughter: "Tawa", silence: "Jeda", join: "Transisi" });
const SCRUBBER_KINDS = new Set(["laughter", "silence"]);
const EMPTY = Object.freeze({ marks: [], coldOpen: null, join: null, unavailable: [], stops: [] });

function coldOpenEnd(doc) {
  try {
    return docPieces(doc).filter((piece) => piece.role === "cold_open").reduce((sum, piece) => sum + piece.frames, 0);
  } catch {
    return 0; // a document the time map refuses draws no cold open
  }
}

/**
 * `{ marks, coldOpen, join, unavailable, stops }` of the current document:
 * - `marks`: the laughs and pauses of `buildMarkers` (camera cuts left out), in its order, each
 *   `{ key, kind, f, text, time }` with `f` the marker's first frame and the marker lane's text;
 * - `coldOpen`: `{ f0: 0, f1: J }`, or null without a cold open;
 * - `join`: the mark at J, `{ key, kind: "join", f, style, sfx, text, time }`, only when the
 *   transition shows (a style other than Potong langsung, or the whoosh);
 * - `unavailable`: the analysis the job lacks, from `buildMarkers`;
 * - `stops`: the frames PageUp and PageDown visit (every mark and the cold-open edges), sorted.
 */
export function scrubberMarks({ doc, words }) {
  if (!doc?.main?.segments || !doc?.output?.fps) return { ...EMPTY, marks: [], unavailable: [], stops: [] };
  const fps = doc.output.fps;
  const { markers, unavailable } = buildMarkers(words, doc);
  const marks = markers.filter((marker) => SCRUBBER_KINDS.has(marker.kind)).map((marker) => {
    const text = markerText(marker, { fps, words });
    return { key: marker.key, kind: marker.kind, f: marker.f0, text: text.short, time: text.time };
  });
  const end = coldOpenEnd(doc);
  const coldOpen = end > 0 ? { f0: 0, f1: end } : null;
  let join = null;
  const view = coldOpen ? transitionView(doc) : null;
  if (view?.style && (view.style !== "cut" || view.sfxOn)) {
    const name = JOIN_STYLE_NAMES[view.style] ?? view.style;
    join = { key: "join", kind: "join", f: view.joinFrame, style: view.style, sfx: view.sfxOn,
      text: `Transisi: ${name}${view.sfxOn ? " + whoosh" : ""}`, time: formatClock(frameToMs(view.joinFrame, fps)) };
  }
  const stops = new Set(marks.map((mark) => mark.f));
  if (coldOpen) {
    stops.add(coldOpen.f0);
    stops.add(coldOpen.f1);
  }
  if (join) stops.add(join.f);
  return { marks, coldOpen, join, unavailable, stops: [...stops].sort((a, b) => a - b) };
}

/** The legend under the track: Tawa, Jeda, Cold open, and Transisi when a join mark shows. */
export function legendItems(model) {
  return model?.join ? ["Tawa", "Jeda", "Cold open", "Transisi"] : ["Tawa", "Jeda", "Cold open"];
}

/** The x of frame `f` on a track `width` px wide for `total` frames. */
export function pxAtFrame(f, { width, total }) {
  return total > 0 ? (f * width) / total : 0;
}

/** The frame under `px`, clamped to the clip (rounded, so a drawn mark maps back to its frame). */
export function frameAtPx(px, { width, total }) {
  if (!(width > 0) || !(total > 0)) return 0;
  return Math.max(0, Math.min(total - 1, Math.round((px * total) / width)));
}

/** The mark within `maxPx` of frame `f` at `pxPerFrame`, the nearest (the earlier on a tie), or null. */
export function nearestMark(marks, f, pxPerFrame, maxPx = SNAP_PX) {
  let best = null;
  let bestPx = Infinity;
  for (const mark of marks) {
    const distance = Math.abs(mark.f - f) * pxPerFrame;
    if (distance <= maxPx && (distance < bestPx || (distance === bestPx && mark.f < best.f))) {
      best = mark;
      bestPx = distance;
    }
  }
  return best;
}

/** The next stop after `f` (`direction` 1) or before it (-1), or null. */
export function nextMark(stops, f, direction) {
  if (direction > 0) return stops.find((stop) => stop > f) ?? null;
  for (let i = stops.length - 1; i >= 0; i -= 1) if (stops[i] < f) return stops[i];
  return null;
}

function groupLabel(marks) {
  if (marks.length === 1) return `${marks[0].text} · ${marks[0].time}`;
  const counts = new Map();
  for (const mark of marks) counts.set(mark.kind, (counts.get(mark.kind) ?? 0) + 1);
  const names = [...counts].map(([kind, count]) => `${KIND_NAMES[kind] ?? kind}${count > 1 ? ` (${count})` : ""}`);
  return `${names.join(", ")} · ${marks[0].time}`;
}

/**
 * The dots to draw: marks closer than MERGE_PX to a group's first mark join that group, drawn at
 * its earliest frame. `{ key, f, x, kind, marks, label }`; a group with a laugh draws as a laugh.
 * The model keeps every mark; only the drawing merges.
 */
export function drawGroups(marks, pxPerFrame) {
  const sorted = [...marks].sort((a, b) => a.f - b.f);
  const groups = [];
  for (const mark of sorted) {
    const current = groups.at(-1);
    if (current && (mark.f - current.f) * pxPerFrame < MERGE_PX) current.marks.push(mark);
    else groups.push({ key: mark.key, f: mark.f, x: mark.f * pxPerFrame, marks: [mark] });
  }
  return groups.map((group) => ({
    ...group,
    kind: group.marks.some((mark) => mark.kind === "laughter") ? "laughter" : group.marks[0].kind,
    label: groupLabel(group.marks),
  }));
}

/** aria-valuetext: "00:02,2 dari 01:00,6". */
export function valueText(frame, total, fps) {
  return `${formatClock(frameToMs(frame, fps))} dari ${formatClock(frameToMs(total, fps))}`;
}

/**
 * The scrubber's own keys: `{kind: "seek", frame}` for ←/→ (a frame; Shift: a second), Home,
 * End, PageUp and PageDown (the previous or next stop, else where it is); `{kind: "toggle"}` for
 * Space and K (play or pause). Null for every other key, so the editor's shortcuts keep them.
 */
export function scrubberKey(event, { frame, total, fps, stops }) {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  const last = Math.max(0, total - 1);
  const clamp = (value) => Math.max(0, Math.min(last, value));
  const second = Math.max(1, Math.round(fps[0] / fps[1]));
  switch (event.key) {
    case "ArrowRight": return { kind: "seek", frame: clamp(frame + (event.shiftKey ? second : 1)) };
    case "ArrowLeft": return { kind: "seek", frame: clamp(frame - (event.shiftKey ? second : 1)) };
    case "Home": return { kind: "seek", frame: 0 };
    case "End": return { kind: "seek", frame: last };
    case "PageDown": return { kind: "seek", frame: clamp(nextMark(stops, frame, 1) ?? frame) };
    case "PageUp": return { kind: "seek", frame: clamp(nextMark(stops, frame, -1) ?? frame) };
    case " ":
    case "k":
    case "K":
      return { kind: "toggle" };
    default:
      return null;
  }
}
