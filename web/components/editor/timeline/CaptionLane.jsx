"use client";

// Placeholder landed by T1.Z; T2.6 replaces this file (cue blocks from `plan.cues`; Appendix C.3).
// Props: { plan, state, dispatch, player, pxPerFrame } (timeline/lanes.mjs).
export default function CaptionLane({ plan, pxPerFrame = 1 }) {
  const frames = plan?.totalFrames ?? 0;
  return <div data-lane="captions" style={{ width: frames * pxPerFrame }} aria-label="Teks" />;
}
