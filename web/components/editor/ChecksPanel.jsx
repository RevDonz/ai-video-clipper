"use client";

// "Perlu dicek" (plan Appendix C.1, §3.7): every warning with its Indonesian message and a jump to
// its frame; blocking plan errors on top. A non-modal popover under the top bar; Escape closes it
// and focus returns to the button that opened it (EditorApp).
import { useEffect, useRef } from "react";

import styles from "./shell.module.css";

export default function ChecksPanel({ open, checks, onJump, onClose }) {
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    panelRef.current?.focus();
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div ref={panelRef} className={styles.panelPopover} role="dialog" aria-modal="false" aria-labelledby="editor-checks-title" tabIndex={-1}>
      <div className={styles.dialogHeader}>
        <h2 id="editor-checks-title">Perlu dicek</h2>
        <button type="button" className={`${styles.button} ${styles.quiet}`} onClick={onClose}>Tutup</button>
      </div>
      <div className={styles.dialogBody}>
        {checks.length === 0 ? (
          <p className={styles.muted}>Tidak ada yang perlu dicek.</p>
        ) : (
          <ul className={styles.checkList}>
            {checks.map((check) => (
              <li key={check.key} className={`${styles.checkItem} ${check.severity === "error" ? styles.checkItem_error : ""}`}>
                <span style={{ flex: "1 1 auto" }}>
                  {check.severity === "error" && <strong>Harus diperbaiki: </strong>}
                  {check.message}
                </span>
                {check.timeText !== null && (
                  <button type="button" className={styles.linkButton} onClick={() => onJump(check)}>
                    {`Lihat di ${check.timeText}`}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
