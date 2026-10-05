"use client";

// The stage status (plan §6.1), at the top left beside the stage in both views (Mode Cepat spec
// §5.2): "Sesuai hasil akhir" only when every layer is current, otherwise what is pending, with its
// detail line, and a "?" button with the help popover of that status (shell-model.badgeHelp).
// The status text keeps its polite live region, so every change is announced; in the legacy state
// it is empty and the "?" help says what the on-screen line used to.
import { useEffect, useId, useRef, useState } from "react";

import styles from "./shell.module.css";
import { badgeHelp } from "./shell-model.mjs";
import Icon from "./ui/icons.jsx";

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
      <div className={styles.badgeLines}>
        <span className={styles.badgeText} role="status" aria-live="polite" data-testid="stage-badge">{view?.text ?? ""}</span>
        {view?.detail && <span className={styles.badgeDetail}>{view.detail}</span>}
      </div>
      <button
        ref={buttonRef}
        type="button"
        className={styles.helpButton}
        aria-label="Apa artinya?"
        title="Apa artinya?"
        aria-expanded={open}
        aria-controls={open ? helpId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="help" />
      </button>
      {open && <div id={helpId} role="note" className={styles.popover}>{badgeHelp(view)}</div>}
    </div>
  );
}
