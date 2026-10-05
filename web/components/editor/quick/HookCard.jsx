"use client";

// Mode Cepat's Hook card (docs/plans/2026-10-02-editor-mode-cepat.md §1.4 Hook). Z0 placeholder:
// task B replaces this body; the props are the card bundle of quick/cards.mjs.
import CardPlaceholder from "./CardPlaceholder.jsx";

export default function HookCard({ showLengkap }) {
  return <CardPlaceholder panel="text" showLengkap={showLengkap} />;
}
