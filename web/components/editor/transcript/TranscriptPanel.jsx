"use client";

// Placeholder landed by T1.Z; T2.7 replaces this file and owns web/components/editor/transcript/**
// (the word list, selection model, inline word editor, removal chips; Appendix C.2).
// Props: { state, dispatch, player } (panels/index.mjs).
export default function TranscriptPanel({ state }) {
  return (
    <section data-panel="transcript" aria-busy={state?.status === "loading"}>
      <p>Transkrip belum tersedia.</p>
    </section>
  );
}
