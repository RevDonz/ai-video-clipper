"use client";

// Mode Lengkap's icon rail (docs/plans/2026-10-02-editor-mode-cepat.md §6.1): a vertical tablist,
// one button per live panel, a 20 px icon above the panel's name. It keeps what the text tabs had:
// the ids (`editor-tab-<id>`), `aria-controls="editor-panel"`, the names, one tab stop (roving
// tabIndex) and selection on move. ↑/↓ move and select (←/→ too, as the text tabs did); Home
// and End go to the ends. The icons are mapped here by panel id, so panels/index.mjs stays as is.
import { useRef } from "react";

import Icon from "../ui/icons.jsx";
import styles from "./rail.module.css";

const RAIL_ICONS = Object.freeze({
  transcript: "transcript", text: "text", coldopen: "coldopen", layout: "layout", logo: "logo", music: "music",
});
const STEPS = Object.freeze({ ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 });

export default function Rail({ panels, value, onChange }) {
  const tabRefs = useRef(new Map());
  const selected = panels.some((entry) => entry.id === value) ? value : panels[0]?.id;

  const onKey = (event, index) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    let next = null;
    if (event.key in STEPS) next = (index + STEPS[event.key] + panels.length) % panels.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = panels.length - 1;
    if (next === null) return;
    event.preventDefault(); // the editor's arrows step frames; on the rail they move between tabs
    const target = panels[next];
    onChange(target.id);
    tabRefs.current.get(target.id)?.focus();
  };

  return (
    <div className={styles.rail} role="tablist" aria-orientation="vertical" aria-label="Panel editor" data-rail="">
      {panels.map((entry, index) => (
        <button
          key={entry.id}
          ref={(element) => { if (element) tabRefs.current.set(entry.id, element); else tabRefs.current.delete(entry.id); }}
          type="button"
          role="tab"
          id={`editor-tab-${entry.id}`}
          className={styles.tab}
          aria-selected={entry.id === selected}
          aria-controls="editor-panel"
          tabIndex={entry.id === selected ? 0 : -1}
          onClick={() => onChange(entry.id)}
          onKeyDown={(event) => onKey(event, index)}
        >
          {RAIL_ICONS[entry.id] ? <Icon name={RAIL_ICONS[entry.id]} className={styles.icon} /> : null}
          <span className={styles.label}>{entry.label}</span>
        </button>
      ))}
    </div>
  );
}
