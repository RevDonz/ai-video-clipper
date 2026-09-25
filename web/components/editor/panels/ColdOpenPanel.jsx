"use client";

// Placeholder landed by T1.Z; T2.7 replaces this file (cold open on/off, current line and
// length, ± word on each edge, "Jadikan cold open" from a selection, the 0.5–8 s reason).
// Props: { state, dispatch, player } (panels/index.mjs).
export default function ColdOpenPanel({ state }) {
  return (
    <section data-panel="coldopen" aria-busy={state?.status === "loading"}>
      <p>Panel Cold open belum tersedia.</p>
    </section>
  );
}
