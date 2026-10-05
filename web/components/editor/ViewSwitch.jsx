"use client";

// The top bar's view switch (Mode Cepat spec §4.5, §5.1): "Cepat | Lengkap" as one native radio
// group drawn as a segmented pill. Tab reaches the checked radio, ←/→ switch the view (selection
// follows focus, as native radios do) and focus stays on the switch. A polite live region names the
// view after a switch; nothing is announced on load. No shortcut of its own (WCAG 2.1.4).
import { useId, useState } from "react";

import styles from "./shell.module.css";

const OPTIONS = Object.freeze([
  Object.freeze({ id: "cepat", label: "Cepat", spoken: "Tampilan Cepat" }),
  Object.freeze({ id: "lengkap", label: "Lengkap", spoken: "Tampilan Lengkap" }),
]);

export default function ViewSwitch({ view, onChange }) {
  const name = useId();
  const [spoken, setSpoken] = useState("");
  return (
    <div className={styles.viewSwitchWrap}>
      <div role="radiogroup" aria-label="Tampilan editor" className={styles.viewSwitch} data-view-switch="">
        {OPTIONS.map((option) => (
          <label key={option.id} className={styles.viewOption}>
            <input
              type="radio"
              className={styles.viewRadio}
              name={name}
              value={option.id}
              checked={view === option.id}
              onChange={() => {
                setSpoken(option.spoken);
                onChange(option.id);
              }}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
      <span className={styles.visuallyHidden} aria-live="polite" data-testid="view-announcement">{spoken}</span>
    </div>
  );
}
