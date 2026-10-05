"use client";

// Mode Cepat's Teks caption card (docs/plans/2026-10-02-editor-mode-cepat.md §2). Z0 placeholder:
// task C replaces this body; the props are the card bundle of quick/cards.mjs.
import CardPlaceholder from "./CardPlaceholder.jsx";

export default function CaptionLinesCard({ showLengkap }) {
  return <CardPlaceholder panel="transcript" showLengkap={showLengkap} />;
}
