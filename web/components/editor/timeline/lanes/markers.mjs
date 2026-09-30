// Timeline markers (plan §11.3 T3.7, §3.6, Appendix C.3): laughter (caption tags and transcript
// tokens), silences of at least 0.6 s and camera cuts of the words artifact, in output frames.
// A marker is placed by the time map's word rule (plan §3.4: shown when its midpoint is kept,
// frames rounded from the piece start), once per segment that shows it, so a moment inside the
// cold open appears twice. Computed from the current document, so markers follow an edit at
// once. Pure; the frames equal tests/fixtures/edit_v2/marker-vectors.json (Python).
import { formatClock, formatSeconds, frameToMs } from "../../shell-model.mjs";
import { pieces as docPieces, wordFrames } from "../../../../lib/editor/timemap.mjs";

export const SILENCE_MIN_MS = 600;
export const KIND_ORDER = Object.freeze(["laughter", "silence", "camera_cut"]);

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function list(value) {
  return Array.isArray(value) ? value : [];
}

/** Every marker source of the words artifact: `{kind, src, s, e}` in source milliseconds. */
export function markerSources(words) {
  const sources = [];
  for (const event of list(words?.events)) {
    if (event?.kind === "laughter") sources.push({ kind: "laughter", src: event.src, s: event.s, e: event.e });
  }
  for (const pair of list(words?.silences)) {
    if (Array.isArray(pair) && pair[1] - pair[0] >= SILENCE_MIN_MS) {
      sources.push({ kind: "silence", src: "audio_timeline", s: pair[0], e: pair[1] });
    }
  }
  for (const ms of list(words?.scene_cuts_ms)) sources.push({ kind: "camera_cut", src: "audio_timeline", s: ms, e: ms });
  return sources;
}

/** The marker kinds this job cannot have, from the artifact's `missing` list (CONTRACTS §5.7). */
export function unavailableKinds(words) {
  const missing = new Set(list(words?.missing));
  const out = [];
  if (missing.has("audio_timeline")) out.push("camera_cut");
  if (missing.has("sound_events")) out.push("laughter_tags");
  if (missing.has("audio_timeline")) out.push("silence");
  return out;
}

/**
 * `{markers, unavailable}` of the words artifact in `doc`: markers `{key, kind, src, seg, s, e,
 * f0, f1}` sorted by output frame (then kind, source time, source, segment).
 */
export function buildMarkers(words, doc) {
  if (!words || !doc?.main?.segments || !doc?.output?.fps) return { markers: [], unavailable: [] };
  const unavailable = unavailableKinds(words);
  let pieces;
  try {
    pieces = docPieces(doc);
  } catch {
    return { markers: [], unavailable };
  }
  const bySegment = new Map();
  for (const piece of pieces) {
    if (!bySegment.has(piece.seg)) bySegment.set(piece.seg, []);
    bySegment.get(piece.seg).push(piece);
  }
  const markers = [];
  markerSources(words).forEach((source, n) => {
    for (const [seg, segmentPieces] of bySegment) {
      let frames = null;
      try {
        frames = wordFrames(source.s, source.e, segmentPieces, doc.output.fps);
      } catch {
        frames = null; // a malformed time in the artifact marks nothing
      }
      if (frames) {
        markers.push({ key: `${source.kind}:${n}:${seg}`, kind: source.kind, src: source.src, seg, s: source.s, e: source.e,
          f0: frames[0], f1: frames[1] });
      }
    }
  });
  markers.sort((a, b) => a.f0 - b.f0 || a.f1 - b.f1 || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
    || a.s - b.s || a.e - b.e || compare(a.src, b.src) || compare(a.seg, b.seg));
  return { markers, unavailable };
}

function spokenLaugh(marker, words) {
  const word = list(words?.words).find((item) => item.s === marker.s && item.e === marker.e);
  const text = (word?.t ?? "").replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, "");
  if (!text) return null;
  return text.length > 12 ? `${text.slice(0, 11)}…` : text;
}

/** `{short, label}`: what the marker is and where it comes from (`label` adds the time). */
export function markerText(marker, { fps, words }) {
  let short = "Potongan kamera";
  if (marker.kind === "laughter") {
    const spoken = marker.src === "transcript" ? spokenLaugh(marker, words) : null;
    short = marker.src === "transcript"
      ? `Tawa, dari transkrip${spoken ? ` ("${spoken}")` : ""}`
      : "Tawa, dari tag caption YouTube";
  } else if (marker.kind === "silence") {
    short = `Jeda ${formatSeconds(marker.e - marker.s)}`;
  }
  return { short, time: formatClock(frameToMs(marker.f0, fps)), label: `${short}, di ${formatClock(frameToMs(marker.f0, fps))}` };
}

/** The sentence under the lane when the job lacks some analysis, or null. */
export function unavailableNote(unavailable) {
  const kinds = new Set(unavailable ?? []);
  const timeline = kinds.has("silence") || kinds.has("camera_cut");
  const tags = kinds.has("laughter_tags");
  if (timeline && tags) {
    return "Jeda, potongan kamera, dan tag tawa dari caption tidak tersedia untuk job ini. Tawa di transkrip tetap ditandai.";
  }
  if (timeline) return "Jeda dan potongan kamera tidak tersedia untuk job ini.";
  if (tags) return "Tag tawa dari caption tidak tersedia untuk job ini. Tawa di transkrip tetap ditandai.";
  return null;
}
