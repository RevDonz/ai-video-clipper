"use client";

// Mode Cepat's Cold open card (docs/plans/2026-10-02-editor-mode-cepat.md §1.4 Cold open). Z0 placeholder:
// task B replaces this body; the props are the card bundle of quick/cards.mjs.
import CardPlaceholder from "./CardPlaceholder.jsx";

export default function ColdOpenCard({ showLengkap }) {
  return <CardPlaceholder panel="coldopen" showLengkap={showLengkap} />;
}
