"use client";

// The restore chip of a removal ("⋯ 1,4 dtk", plan Appendix C.2): one click is RestoreRemoval.
import { memo } from "react";

import styles from "./transcript.module.css";

function RemovalChip({ chip, onRestore, disabled }) {
  const seconds = chip.label.replace(/^⋯\s*/, "");
  return (
    <button
      type="button"
      className={chip.cold ? `${styles.chip} ${styles.chipCold}` : styles.chip}
      data-removal-id={chip.removalId}
      aria-label={`Pulihkan potongan ${seconds}${chip.cold ? " di cold open" : ""}`}
      title={chip.cold ? "Potongan di cold open; klik untuk memulihkan" : "Klik untuk memulihkan potongan ini"}
      disabled={disabled}
      onClick={() => onRestore(chip.removalId)}
    >
      {chip.label}
    </button>
  );
}

export default memo(RemovalChip);
