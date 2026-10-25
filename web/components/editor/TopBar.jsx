"use client";

// The editor's top bar, the same in both views (Mode Cepat spec §5.1): "← Proyek"; "Klip 3/8 ‹ ›"
// when the project has more clips (lib/editor/clip-nav.mjs); the clip title with its save state
// and, while another tab has the clip, "Terbuka di tab lain"; the view switch; Urungkan and Ulangi;
// "Perlu dicek (n)", always shown; the ⋯ Lainnya menu ("Kembali ke versi AI", "Pintasan
// keyboard"); and Ekspor, the one lime control.
//
// The one-layout editor (rombak 06 §4) passes `checksButton` (shell-model checksButtonView) and no
// `onViewChange`: no view switch, and "Perlu dicek n" or "Catatan n" only while there is something
// to show.
import { forwardRef, useEffect, useState } from "react";
import { useTranslations } from "use-intl";

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
  onHelp, onExport, exportDisabled, exportBusy, clipNav = null, clipNavBusy = false, onPreviousClip, onNextClip,
  checksButton = null,
}, exportButtonRef) {
  const t = useTranslations("editor.shell");
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
      {clipNav && (
        <div className={styles.clipNav} role="group" aria-label="Pindah klip" aria-busy={clipNavBusy} data-clip-nav="">
          <span className={styles.clipCount}>
            <span aria-hidden="true">{`Klip ${clipNav.position}/${clipNav.total}`}</span>
            <span className={styles.visuallyHidden}>{`Klip ${clipNav.position} dari ${clipNav.total}`}</span>
          </span>
          <button type="button" className={styles.iconButton} onClick={onPreviousClip} disabled={!clipNav.previous}
            aria-label="Klip sebelumnya" title="Klip sebelumnya (Ctrl+Shift+←)" aria-keyshortcuts="Control+Shift+ArrowLeft">
            <Icon name="back" />
          </button>
          <button type="button" className={styles.iconButton} onClick={onNextClip} disabled={!clipNav.next}
            aria-label="Klip berikutnya" title="Klip berikutnya (Ctrl+Shift+→)" aria-keyshortcuts="Control+Shift+ArrowRight">
            <Icon name="forward" />
          </button>
        </div>
      )}
      <div className={styles.titleBlock}>
        <h1 className={styles.title} title={title}>{title}</h1>
        <span className={`${styles.saveStatus} ${styles[`save_${status.tone}`] ?? ""}`} role="status" aria-live="polite" data-testid="save-status">
          {status.text}
        </span>
        {status.retry && <button type="button" className={`${styles.linkButton} ${styles.retryButton}`} onClick={onRetrySave}>Coba simpan lagi</button>}
        {otherTab && <span className={styles.otherTab} data-other-tab="">{OTHER_TAB_TEXT}</span>}
      </div>
      {onViewChange ? <ViewSwitch view={view} onChange={onViewChange} /> : null}
      <div className={styles.historyButtons}>
        <button type="button" className={styles.iconButton} onClick={onUndo} disabled={!canUndo} aria-label="Urungkan"
          title="Urungkan (Ctrl+Z)" aria-keyshortcuts="Control+Z">
          <Icon name="undo" />
        </button>
        <button type="button" className={styles.iconButton} onClick={onRedo} disabled={!canRedo} aria-label="Ulangi"
          title="Ulangi (Ctrl+Shift+Z)" aria-keyshortcuts="Control+Shift+Z Control+Y">
          <Icon name="redo" />
        </button>
      </div>
      {checksButton ? (
        checksButton.kind ? (
          <button
            ref={checksButtonRef}
            type="button"
            className={`${styles.button} ${styles.barButton} ${checksButton.kind === "check" ? styles.warnButton : ""}`}
            aria-expanded={checksOpen}
            aria-haspopup="dialog"
            onClick={onToggleChecks}
            data-checks-button={checksButton.kind}
          >
            {checksButton.kind === "check" ? t("checks.needs", { count: checksButton.count }) : t("checks.notes", { count: checksButton.count })}
          </button>
        ) : null
      ) : (
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
      )}
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
