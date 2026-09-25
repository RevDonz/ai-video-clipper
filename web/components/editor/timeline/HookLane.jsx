"use client";

// Placeholder landed by T1.Z; T2.6 replaces this file (the hook block with its duration handle,
// from `plan.hook`; Appendix C.3). Props: { plan, state, dispatch, player, pxPerFrame }
// (timeline/lanes.mjs).
export default function HookLane({ plan, pxPerFrame = 1 }) {
  const frames = plan?.totalFrames ?? 0;
  return <div data-lane="hook" style={{ width: frames * pxPerFrame }} aria-label="Hook" />;
}
