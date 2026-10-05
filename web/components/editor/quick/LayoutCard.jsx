"use client";

// Mode Cepat's Tata letak card (docs/plans/2026-10-02-editor-mode-cepat.md §1.4 Tata letak). Z0 placeholder:
// task B replaces this body; the props are the card bundle of quick/cards.mjs.
import CardPlaceholder from "./CardPlaceholder.jsx";

export default function LayoutCard({ showLengkap }) {
  return <CardPlaceholder panel="layout" showLengkap={showLengkap} />;
}
