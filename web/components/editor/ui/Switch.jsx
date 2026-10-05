"use client";

// An on/off setting (spec §8.2): a checkbox with role="switch" and its visible label.
import styles from "./ui.module.css";

export default function Switch({ label, checked, onChange, disabled = false, describedBy }) {
  return (
    <label className={styles.switch}>
      <span>{label}</span>
      <input type="checkbox" role="switch" className={styles.cover} checked={Boolean(checked)} disabled={disabled}
        aria-describedby={describedBy} onChange={(event) => onChange?.(event.target.checked)} />
      <span className={styles.switchTrack} aria-hidden="true" />
    </label>
  );
}
