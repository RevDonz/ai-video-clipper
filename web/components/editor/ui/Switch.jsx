"use client";

// An on/off setting (spec §8.2): a checkbox with role="switch" and its visible label. `title`
// repeats on hover why a disabled switch is off.
import styles from "./ui.module.css";

export default function Switch({ label, checked, onChange, disabled = false, describedBy, title }) {
  return (
    <label className={styles.switch} title={title}>
      <span>{label}</span>
      <input type="checkbox" role="switch" className={styles.cover} checked={Boolean(checked)} disabled={disabled}
        aria-describedby={describedBy} onChange={(event) => onChange?.(event.target.checked)} />
      <span className={styles.switchTrack} aria-hidden="true" />
    </label>
  );
}
