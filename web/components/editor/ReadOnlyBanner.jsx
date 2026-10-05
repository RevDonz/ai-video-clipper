"use client";

// The read-only state (plan §3.6 "Transcript changed", Appendix C.6): the document's words no
// longer match the job's transcript, so the clip opens read-only and offers "Mulai dari versi AI".
// Neutral since Mode Cepat (spec §8.1): lime stays with Ekspor, so the one action here is the
// strong neutral button.
import styles from "./shell.module.css";
import { messageFor } from "./shell-model.mjs";

export default function ReadOnlyBanner({ reason, onStartFromSeed }) {
  if (!reason) return null;
  return (
    <div className={styles.banner} role="status">
      <span>{messageFor(reason)}</span>
      {onStartFromSeed && (
        <button type="button" className={`${styles.button} ${styles.strong}`} onClick={onStartFromSeed}>Mulai dari versi AI</button>
      )}
    </div>
  );
}
