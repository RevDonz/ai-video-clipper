"use client";

// Placeholder landed by T1.Z; T2.6 replaces this file (pieces, cut markers, the cold-open block
// and trim handles snapped to `bounds`; Appendix C.3).
// Props: { plan, state, dispatch, player, pxPerFrame } (timeline/lanes.mjs).
export default function VideoLane({ plan, pxPerFrame = 1 }) {
  const frames = plan?.totalFrames ?? 0;
  return <div data-lane="video" style={{ width: frames * pxPerFrame }} aria-label="Video" />;
}
