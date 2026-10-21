"use client";

// "Pakai di semua klip" under a settings group (CONTRACTS §5.48): the button, the rule that clips
// changed by hand do not take it, then the batch's result ("Dipakai di n klip · k dilewati") with
// Urungkan and the skipped clips. The state lives in the shell's controller (lib/editor/apply-all.mjs),
// so the result stays when the card closes or the view switches. Hidden while the job has no
// other clip. Props: `applyAll` (the bundle's controller), `group`, `disabled`.
import { useCallback, useId, useSyncExternalStore } from "react";

import { APPLY_GROUPS, applySummary, skippedLines, undoSummary } from "../../../lib/editor/apply-all.mjs";
import PillButton from "../ui/PillButton.jsx";
import styles from "./apply-all.module.css";

const NONE = () => () => {};

function Skipped({ list }) {
  const lines = skippedLines(list);
  if (!lines.length) return null;
  return (
    <details className={styles.applySkipped}>
      <summary>Lihat yang dilewati</summary>
      <ul>{lines.map((line) => <li key={line}>{line}</li>)}</ul>
    </details>
  );
}

export default function ApplyAll({ applyAll, group, disabled = false }) {
  const noteId = useId();
  const subscribe = useCallback((listener) => (applyAll ? applyAll.subscribe(listener) : NONE()), [applyAll]);
  const view = useSyncExternalStore(subscribe, () => applyAll?.get(group) ?? null, () => null);
  const others = useSyncExternalStore(subscribe, () => applyAll?.others() ?? null, () => null);
  const texts = APPLY_GROUPS[group];
  if (!applyAll || !texts || !view || !others) return null;
  const busy = view.phase === "running" || view.phase === "undoing";
  const undone = view.phase === "undone";
  const result = view.phase === "done" || view.phase === "undoing" || undone ? view.result : null;

  return (
    <div className={styles.applyAll} data-apply-all={group}>
      {/* aria-disabled while busy, not disabled: the button keeps keyboard focus for the retry. */}
      <PillButton aria-describedby={noteId} disabled={disabled} aria-disabled={busy || undefined}
        aria-busy={view.phase === "running"} onClick={() => { if (!busy) applyAll.apply(group); }}>
        {view.phase === "running" ? "Menerapkan…" : texts.button}
      </PillButton>
      <p id={noteId} className={styles.applyNote}>{texts.note}</p>
      {view.phase === "error" && view.message ? <p className={styles.applyError} role="alert">{view.message}</p> : null}
      <div role="status" aria-live="polite">
        {result ? (
          <div className={styles.applyResult} data-apply-result={view.phase}>
            <div className={styles.applyRow}>
              <p className={styles.applySummary}>{undone ? undoSummary(view.undo) : applySummary(result)}</p>
              {!undone && result.applied?.length ? (
                <PillButton variant="quiet" disabled={busy} aria-busy={view.phase === "undoing"}
                  onClick={() => { applyAll.undo(group); }}>
                  {view.phase === "undoing" ? "Mengurungkan…" : "Urungkan"}
                </PillButton>
              ) : null}
            </div>
            {view.message ? <p className={styles.applyError}>{view.message}</p> : null}
            <Skipped list={undone ? view.undo?.skipped : result.skipped} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
