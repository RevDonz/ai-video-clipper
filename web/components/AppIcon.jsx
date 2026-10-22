// A sidebar icon (lib/app-icons.mjs). Decoration only: the link or button around it carries the name.
import { APP_ICONS } from "../lib/app-icons.mjs";

export default function AppIcon({ name, size = 20, className }) {
  const parts = APP_ICONS[name];
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
