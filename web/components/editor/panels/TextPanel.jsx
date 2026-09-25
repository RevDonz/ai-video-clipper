"use client";

// Placeholder landed by T1.Z; T2.7 replaces this file (captions on/off, the 4 packs, position,
// size, uppercase, highlight and emphasis swatches; hook on/off, text, fit badge, duration,
// position). Props: { state, dispatch, player } (panels/index.mjs).
export default function TextPanel({ state }) {
  return (
    <section data-panel="text" aria-busy={state?.status === "loading"}>
      <p>Panel Teks belum tersedia.</p>
    </section>
  );
}
