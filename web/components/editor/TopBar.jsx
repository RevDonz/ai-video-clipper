"use client";

// The editor's top bar (plan Appendix C.1): "← Proyek", the clip title, the save state, Undo and
// Redo, "Kembali ke versi AI", "Perlu dicek (n)", the shortcut help and "Ekspor".
import { forwardRef, useEffect, useState } from "react";

import styles from "./shell.module.css";
import { saveStatusView } from "./shell-model.mjs";

function useNow(active) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

const TopBar = forwardRef(function TopBar({
  jobId, title, save, savedAtMs, canUndo, canRedo, onUndo, onRedo, onReset, resetDisabled, onRetrySave,
  checksCount, checksOpen, onToggleChecks, onHelp, onExport, exportDisabled, exportBusy, checksButtonRef,
}, exportButtonRef) {
  const now = useNow(save === "saved");
  const status = saveStatusView({ save, savedAtMs }, now);
  const hasChecks = checksCount > 0;
  return (
    <header className={styles.topBar} data-slot="topBar">
      <a className={styles.backLink} href={`/projects/${encodeURIComponent(jobId)}`}>← Proyek</a>
      <div className={styles.titleBlock}>
        <h1 className={styles.title} title={title}>{title}</h1>
        <span className={`${styles.saveStatus} ${styles[`save_${status.tone}`] ?? ""}`} role="status" aria-live="polite" data-testid="save-status">
          {status.text}
        </span>
        {status.retry && <button type="button" className={styles.linkButton} onClick={onRetrySave}>Coba simpan lagi</button>}
      </div>
      <div className={styles.toolbar}>
        <button type="button" className={`${styles.button} ${styles.quiet}`} onClick={onUndo} disabled={!canUndo} aria-keyshortcuts="Control+Z">
          Urungkan
        </button>
        <button type="button" className={`${styles.button} ${styles.quiet}`} onClick={onRedo} disabled={!canRedo} aria-keyshortcuts="Control+Shift+Z Control+Y">
          Ulangi
        </button>
        <span className={styles.divider} aria-hidden="true" />
        <button type="button" className={styles.button} onClick={onReset} disabled={resetDisabled}>Kembali ke versi AI</button>
        <button
          ref={checksButtonRef}
          type="button"
          className={`${styles.button} ${hasChecks ? styles.warnButton : ""}`}
          aria-expanded={checksOpen}
          aria-haspopup="dialog"
          onClick={onToggleChecks}
        >
          {`Perlu dicek (${checksCount})`}
        </button>
        <button type="button" className={`${styles.button} ${styles.iconButton}`} aria-label="Pintasan keyboard" aria-keyshortcuts="?" onClick={onHelp}>
          ?
        </button>
        <button
          ref={exportButtonRef}
          type="button"
          className={`${styles.button} ${styles.primary}`}
          onClick={onExport}
          disabled={exportDisabled}
          aria-keyshortcuts="Control+Shift+E"
          aria-describedby={exportBusy ? "editor-export-busy" : undefined}
        >
          Ekspor
        </button>
        {exportBusy && <span id="editor-export-busy" className={styles.visuallyHidden}>Ekspor sedang berjalan</span>}
      </div>
    </header>
  );
});

export default TopBar;
