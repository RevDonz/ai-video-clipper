"use client";

// An on/off pill (spec §8.2): a button with aria-pressed, as Frame akhir and Zona aman.
import styles from "./ui.module.css";

export default function PillToggle({ pressed, onPressedChange, onClick, children, className, ...button }) {
  return (
    <button type="button" {...button} className={className ? `${styles.toggle} ${className}` : styles.toggle}
      aria-pressed={Boolean(pressed)}
      onClick={(event) => {
        onClick?.(event);
        onPressedChange?.(!pressed);
      }}>
      {children}
    </button>
  );
}
