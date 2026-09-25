"use client";

// The stage state badge (plan §6.1): "● Sesuai hasil akhir" only when every layer is current,
// otherwise what is pending; plus the help popover with the one statement of what "sesuai"
// cannot mean. The text comes from shell-model.badgeView.
import { useEffect, useId, useRef, useState } from "react";

import styles from "./shell.module.css";
import { BADGE_HELP } from "./shell-model.mjs";

export default function StageBadge({ view }) {
  const [open, setOpen] = useState(false);
  const helpId = useId();
  const buttonRef = useRef(null);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onPointer = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, [open]);

  const tone = view?.tone ?? "loading";
  return (
    <div ref={rootRef} className={`${styles.badge} ${styles[`badge_${tone}`] ?? ""}`} data-badge-tone={tone}>
      <span className={styles.badgeText} role="status" aria-live="polite" data-testid="stage-badge">{view?.text ?? ""}</span>
      {view?.detail && <span className={styles.badgeDetail}>{view.detail}</span>}
      <button
        ref={buttonRef}
        type="button"
        className={styles.helpButton}
        aria-expanded={open}
        aria-controls={open ? helpId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        Apa artinya?
      </button>
      {open && <div id={helpId} role="note" className={styles.popover}>{BADGE_HELP}</div>}
    </div>
  );
}
