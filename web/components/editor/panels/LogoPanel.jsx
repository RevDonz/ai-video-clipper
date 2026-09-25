"use client";

// Placeholder landed by T2.Z (W3 scaffolding, plan §11.2). T3.2 replaces this file with upload, place, size, opacity and remove through SetLogo, MoveLogo, ResizeLogo, SetLogoOpacity, SnapLogo and RemoveLogo; uploads go through web/lib/editor/upload-client.mjs (T3.1).
// The registry (panels/index.mjs) is never edited. Props: { state, dispatch, player }.
export default function LogoPanel({ state }) {
  return (
    <section data-panel="logo" aria-busy={state?.status === "loading"}>
      <p>Panel Logo hadir di tahap berikutnya.</p>
    </section>
  );
}
