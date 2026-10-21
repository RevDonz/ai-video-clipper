// "Atur bingkai", the manual framing of the crop layouts (CONTRACTS §5.44): the words the editor
// shows, the view of the playhead in the dialog, the still's document and the dialog's commands.
// Pure functions, no DOM; FramingDialog.jsx, panels/LayoutPanel.jsx, quick/LayoutCard.jsx and the
// node tests use them.
//
// The dialog draws the 9:16 box over the source picture at the playhead. That picture is the truth
// frame (plan §4.2 `preview/frame`) of `sourceFrameDoc`: the document with the latar blur layout,
// whose middle band is the whole source, and without text, logo, music or transition, so nothing
// covers it. A keyframe is the playhead's source frame; between keyframes the box shows the crop
// the render takes (framing.mjs). Without keyframes, Potong tengah's crop is the centre; face-track
// follows the face, which this view cannot draw, so its result stays hidden until the first drag.
import { KEYFRAME_MOVES, PAN_E5_MAX, canonicalJson } from "../../lib/editor/doc-model.mjs";
import {
  cropAt, framingAvailability, framingSizes, keyframeMarks, keyframesOf, panForCrop, panLimit, sourceFrameAt,
} from "../../lib/editor/framing.mjs";

const option = (fields) => Object.freeze(fields);

/** "Potong" holds the framing until the keyframe; "Geser" moves to it. */
export const FRAMING_MOVES = Object.freeze([
  option({ id: "cut", label: "Potong", title: "Bingkai pindah tepat di keyframe ini" }),
  option({ id: "slide", label: "Geser", title: "Bingkai bergeser pelan dari keyframe sebelumnya" }),
]);

const CENTRE_E5 = PAN_E5_MAX / 2;

/**
 * The line under Tata letak and on the Tata letak card: `{available, reason, count, text}`.
 * `reason` is framingAvailability's ("layout" for latar blur, "portrait" for a source that is
 * already 9:16 or taller).
 */
export function framingSummary(doc) {
  const { ok, reason } = framingAvailability(doc);
  const count = keyframesOf(doc).length;
  if (!ok) {
    const text = reason === "portrait"
      ? "Video sumber sudah tegak, tidak ada yang bisa digeser."
      : "Pilih Ikuti wajah atau Potong tengah untuk mengatur bingkai sendiri.";
    return { available: false, reason, count, text };
  }
  const camera = doc.layout.default.mode === "camera";
  if (!count) {
    return { available: true, reason: null, count, text: camera ? "Otomatis: bingkai mengikuti wajah." : "Otomatis: bingkai di tengah." };
  }
  // keyframes turn face-track's no-face fallback off: the framing holds there too
  return { available: true, reason: null, count, text: `Diatur manual: ${count} keyframe${camera ? ", juga di bagian tanpa wajah" : ""}.` };
}

/**
 * The dialog at output frame `frame`: `{sf, keyframes, count, index, auto, pan, crop, move,
 * moveEditable, previous, next, marks, resultKnown}`. `draft` is the pan of a drag in progress.
 * `index` is the keyframe on the playhead's source frame (−1 if none), `previous`/`next` the
 * output frames of the nearest keyframes on the timeline, `pan`/`crop` what the box shows (between
 * keyframes `pan` is the nearest pan of that crop, what "Tambah keyframe" stores).
 */
export function framingView({ doc, plan, frame, draft = null }) {
  const keyframes = keyframesOf(doc);
  const sf = sourceFrameAt(plan, frame);
  const marks = keyframeMarks(doc, plan);
  const count = keyframes.length;
  const index = sf === null ? -1 : keyframes.findIndex((keyframe) => keyframe.sf === sf);
  const { source, output, zoom } = doc ? framingSizes(doc) : { source: null, output: null, zoom: undefined };
  let pan = CENTRE_E5;
  if (draft !== null) pan = draft;
  else if (index >= 0) pan = keyframes[index].pan_e5;
  let crop = null;
  if (source && output) {
    if (draft === null && index < 0 && count && sf !== null) {
      crop = cropAt(keyframes, sf, source, output, zoom); // between keyframes: the render's crop
      pan = panForCrop(crop, panLimit(source, output, zoom));
    } else crop = cropAt([{ sf: 0, pan_e5: pan, move: "cut" }], 0, source, output, zoom);
  }
  const before = marks.filter((mark) => mark.f < frame).at(-1) ?? null;
  const after = marks.find((mark) => mark.f > frame) ?? null;
  return {
    sf, keyframes, count, index, auto: count === 0, pan, crop,
    move: index >= 0 ? keyframes[index].move : null,
    moveEditable: index > 0,
    previous: before ? before.f : null,
    next: after ? after.f : null,
    marks,
    resultKnown: count > 0 || draft !== null || doc?.layout?.default?.mode === "fill_center",
  };
}

/**
 * The still's document: `doc` with the latar blur layout (no keyframes and no zoom, so it validates
 * and shows the whole picture), no captions, tracks or assets, and its cold-open join as a plain
 * cut without the whoosh, so the truth frame is the source picture (inside its black bars,
 * CONTRACTS §5.47) and nothing over it.
 */
export function sourceFrameDoc(doc) {
  const joins = doc.main.joins.map(({ sfx: _sfx, ...join }) => ({ ...join, style: "cut" }));
  return {
    ...doc,
    main: { ...doc.main, joins },
    captions: { ...doc.captions, enabled: false },
    layout: { default: { ...doc.layout.default, mode: "fit_blur" } },
    tracks: [],
    assets: {},
  };
}

/** What the still depends on (the clip and its cuts): a new key asks for a new still. */
export function stillKey(doc) {
  if (!doc) return null;
  const still = sourceFrameDoc(doc);
  return canonicalJson({ clip: doc.clip_id, base: doc.base, output: doc.output, main: still.main });
}

/** SetKeyframe at a source frame; a drag or a nudge at one frame is one undo step. */
export function keyframeCommand(sf, pan) {
  return { type: "SetKeyframe", args: { sf, pan_e5: pan }, mergeKey: `frame:${sf}` };
}

export function removeKeyframeCommand(sf) {
  return { type: "RemoveKeyframe", args: { sf }, mergeKey: null };
}

export function keyframeMoveCommand(sf, move) {
  if (!KEYFRAME_MOVES.includes(move)) throw new TypeError(`unknown keyframe move: ${move}`);
  return { type: "SetKeyframeMove", args: { sf, move }, mergeKey: null };
}

/** "Kembali ke otomatis": the layout's own framing again. */
export function clearKeyframesCommand() {
  return { type: "ClearKeyframes", args: {}, mergeKey: null };
}
