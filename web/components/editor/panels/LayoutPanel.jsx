"use client";

// Placeholder landed by T2.Z (W3 scaffolding, plan §11.2). T3.6 replaces this file with the layout picker (fit-blur, center-crop, face-track) with live thumbnails from truth frames at the playhead, camera-analysis progress and the no_face list with jump-to.
// The registry (panels/index.mjs) is never edited. Props: { state, dispatch, player }.
export default function LayoutPanel({ state }) {
  return (
    <section data-panel="layout" aria-busy={state?.status === "loading"}>
      <p>Panel Tata letak hadir di tahap berikutnya.</p>
    </section>
  );
}
