"use client";

// The read-only state (plan §3.6 "Transcript changed", Appendix C.6): the document's words no
// longer match the job's transcript, so the clip opens read-only and offers "Mulai dari versi AI".
import styles from "./shell.module.css";
import { messageFor } from "./shell-model.mjs";

export default function ReadOnlyBanner({ reason, onStartFromSeed }) {
  if (!reason) return null;
  return (
    <div className={styles.banner} role="status">
      <span>{messageFor(reason)}</span>
      {onStartFromSeed && (
        <button type="button" className={`${styles.button} ${styles.primary}`} onClick={onStartFromSeed}>Mulai dari versi AI</button>
      )}
    </div>
  );
}
