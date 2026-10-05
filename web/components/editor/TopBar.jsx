"use client";

// The editor's top bar, the same in both views (Mode Cepat spec §5.1): "← Proyek", the clip title
// with its save state and, while another tab has the clip, "Terbuka di tab lain"; the view switch;
// Urungkan and Ulangi; "Perlu dicek (n)", always shown; the ⋯ Lainnya menu ("Kembali ke versi AI",
// "Pintasan keyboard"); and Ekspor, the one lime control.
import { forwardRef, useEffect, useState } from "react";

import styles from "./shell.module.css";
import { OTHER_TAB_TEXT, saveStatusView } from "./shell-model.mjs";
import Icon from "./ui/icons.jsx";
import MenuButton from "./ui/MenuButton.jsx";
import ViewSwitch from "./ViewSwitch.jsx";

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
  jobId, title, save, savedAtMs, otherTab = false, view, onViewChange, canUndo, canRedo, onUndo, onRedo,
  onReset, resetDisabled, resetReason = null, onRetrySave, checksCount, checksOpen, onToggleChecks, checksButtonRef,
  onHelp, onExport, exportDisabled, exportBusy,
}, exportButtonRef) {
  const now = useNow(save === "saved");
  const status = saveStatusView({ save, savedAtMs }, now);
  const hasChecks = checksCount > 0;
  const more = [
    { id: "reset", label: "Kembali ke versi AI", disabled: resetDisabled, reason: resetDisabled ? resetReason : null, onSelect: onReset },
    { id: "help", label: "Pintasan keyboard", shortcut: "?", onSelect: onHelp },
  ];
  return (
    <header className={styles.topBar} data-slot="topBar">
      <a className={styles.backLink} href={`/projects/${encodeURIComponent(jobId)}`}>← Proyek</a>
      <div className={styles.titleBlock}>
        <h1 className={styles.title} title={title}>{title}</h1>
        <span className={`${styles.saveStatus} ${styles[`save_${status.tone}`] ?? ""}`} role="status" aria-live="polite" data-testid="save-status">
          {status.text}
        </span>
        {status.retry && <button type="button" className={styles.linkButton} onClick={onRetrySave}>Coba simpan lagi</button>}
        {otherTab && <span className={styles.otherTab} data-other-tab="">{OTHER_TAB_TEXT}</span>}
      </div>
      <ViewSwitch view={view} onChange={onViewChange} />
      <div className={styles.history}>
        <button type="button" className={styles.iconButton} onClick={onUndo} disabled={!canUndo} aria-label="Urungkan"
          title="Urungkan (Ctrl+Z)" aria-keyshortcuts="Control+Z">
          <Icon name="undo" />
        </button>
        <button type="button" className={styles.iconButton} onClick={onRedo} disabled={!canRedo} aria-label="Ulangi"
          title="Ulangi (Ctrl+Shift+Z)" aria-keyshortcuts="Control+Shift+Z Control+Y">
          <Icon name="redo" />
        </button>
      </div>
      <button
        ref={checksButtonRef}
        type="button"
        className={`${styles.button} ${styles.barButton} ${hasChecks ? styles.warnButton : ""}`}
        aria-expanded={checksOpen}
        aria-haspopup="dialog"
        onClick={onToggleChecks}
      >
        {`Perlu dicek (${checksCount})`}
      </button>
      <MenuButton label="Lainnya" icon="more" items={more} align="end" />
      <button
        ref={exportButtonRef}
        type="button"
        className={`${styles.button} ${styles.primary} ${styles.exportButton}`}
        onClick={onExport}
        disabled={exportDisabled}
        aria-keyshortcuts="Control+Shift+E"
        aria-describedby={exportBusy ? "editor-export-busy" : undefined}
      >
        Ekspor
      </button>
      {exportBusy && <span id="editor-export-busy" className={styles.visuallyHidden}>Ekspor sedang berjalan</span>}
    </header>
  );
});

export default TopBar;
