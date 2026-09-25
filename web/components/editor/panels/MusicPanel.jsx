"use client";

// Placeholder landed by T2.Z (W3 scaffolding, plan §11.2). T3.3 replaces this file with music add/replace/remove, gain, offset, loop, fades, the ducking presets and the advanced section, source volume, normalize with the achieved LUFS and the copyright notice.
// The registry (panels/index.mjs) is never edited. Props: { state, dispatch, player }.
export default function MusicPanel({ state }) {
  return (
    <section data-panel="music" aria-busy={state?.status === "loading"}>
      <p>Panel Musik hadir di tahap berikutnya.</p>
    </section>
  );
}
