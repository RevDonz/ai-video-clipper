"use client";

// An action pill (spec §8.2): Putar, Ganti kalimat, Hapus cold open. "strong" is the neutral
// selected look (--text fill), "quiet" has no edge.
import styles from "./ui.module.css";

export default function PillButton({ variant = "default", className, type = "button", ...button }) {
  return (
    <button type={type} {...button} data-variant={variant}
      className={className ? `${styles.pillButton} ${className}` : styles.pillButton} />
  );
}
