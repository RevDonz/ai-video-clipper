"use client";

// Mode Lengkap's panel tabs (spec §6.1). Z0 moves today's text tabs here unchanged: the tab ids
// (`editor-tab-<id>`), `aria-controls="editor-panel"`, the names, roving tabIndex, ←/→ and
// Home/End. Task D turns them into the vertical icon rail.
import { useRef } from "react";

import styles from "../shell.module.css";

export default function Rail({ panels, value, onChange }) {
  const tabRefs = useRef(new Map());
  const selected = panels.some((entry) => entry.id === value) ? value : panels[0]?.id;

  const onKey = (event, index) => {
    const moves = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: panels.length - 1 };
    if (!(event.key in moves)) return;
    event.preventDefault();
    const target = panels[(moves[event.key] + panels.length) % panels.length];
    onChange(target.id);
    tabRefs.current.get(target.id)?.focus();
  };

  return (
    <div className={styles.tabs} role="tablist" aria-label="Panel editor">
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
          {entry.label}
        </button>
      ))}
    </div>
  );
}
