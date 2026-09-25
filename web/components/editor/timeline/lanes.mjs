// Registry of the timeline lanes, top to bottom (plan Appendix C.3), landed by the W1
// integrator (T1.Z) before W2 starts. It lists every W2 lane; T2.6 replaces the placeholder
// files and never edits this list (plan §11.0). T2.Z adds the W3 lanes (music, audio and
// markers) at the end of W2.
//
// Every lane component receives the same props: `{ plan, state, dispatch, player, pxPerFrame }`
// (`plan` is the plan DTO of §4.3; every position is an output frame).
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
]);

export function laneById(id) {
  return LANES.find((lane) => lane.id === id) ?? null;
}
