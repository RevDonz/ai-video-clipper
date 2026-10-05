"use client";

// The editor's icons (spec §8.2): decorative, so always aria-hidden; the control around an icon
// carries the name. Paths live in icon-paths.mjs.
import { ICONS } from "./icon-paths.mjs";

export { ICON_NAMES } from "./icon-paths.mjs";

export default function Icon({ name, size = 20, className }) {
  const parts = ICONS[name];
  if (!parts) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={className}
      fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {parts.map((part) => (part.fill
        ? <path key={part.d} d={part.d} fill="currentColor" stroke="none" />
        : <path key={part.d} d={part.d} />))}
    </svg>
  );
}

export { Icon };
