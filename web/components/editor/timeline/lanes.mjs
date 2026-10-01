// Registry of the timeline lanes, top to bottom (plan Appendix C.3), landed by the W1
// integrator (T1.Z) before W2 starts. It lists every W2 lane; T2.6 replaces the placeholder
// files and never edits this list (plan §11.0). T2.Z added the W3 lanes (audio, markers and
// music, Appendix C.3) at the end of W2; W3 tasks replace their placeholder files.
//
// Every lane component receives the same props: `{ plan, state, dispatch, player, pxPerFrame }`
// (`plan` is the plan DTO of §4.3; every position is an output frame), plus `notify` (a toast),
// `readOnly` and `onNote(text | null)`, which shows a note about the lane in the timeline's
// header, where nothing in the lane covers it.
// `load` is a lazy import, so this file stays importable outside the bundler (node tests).
const entry = (fields) => Object.freeze(fields);

export const LANES = Object.freeze([
  entry({
    id: "video", label: "Video", wave: "W2", owner: "T2.6", component: "VideoLane",
    file: "timeline/VideoLane.jsx", load: () => import("./VideoLane.jsx"),
  }),
  entry({
    id: "captions", label: "Teks", wave: "W2", owner: "T2.6", component: "CaptionLane",
    file: "timeline/CaptionLane.jsx", load: () => import("./CaptionLane.jsx"),
  }),
  entry({
    id: "hook", label: "Hook", wave: "W2", owner: "T2.6", component: "HookLane",
    file: "timeline/HookLane.jsx", load: () => import("./HookLane.jsx"),
  }),
  // W3 (landed by T2.Z; each task replaces its placeholder file, never this list).
  entry({
    id: "audio", label: "Audio", wave: "W3", owner: "T3.7", component: "AudioLane",
    file: "timeline/lanes/AudioLane.jsx", load: () => import("./lanes/AudioLane.jsx"),
  }),
  entry({
    id: "markers", label: "Penanda", wave: "W3", owner: "T3.7", component: "MarkerLane",
    file: "timeline/lanes/MarkerLane.jsx", load: () => import("./lanes/MarkerLane.jsx"),
  }),
  entry({
    id: "music", label: "Musik", wave: "W3", owner: "T3.3", component: "MusicLane",
    file: "timeline/lanes/MusicLane.jsx", load: () => import("./lanes/MusicLane.jsx"),
  }),
]);

export function laneById(id) {
  return LANES.find((lane) => lane.id === id) ?? null;
}
