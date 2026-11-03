"use client";

// "Pakai di semua klip" under a settings group (CONTRACTS §5.53): the button, the rule that clips
// changed by hand do not take it, then the batch's result ("Dipakai di n klip · k dilewati") with
// Urungkan and the skipped clips. The state lives in the shell's controller (lib/editor/apply-all.mjs),
// so the result stays when the card closes or the view switches. Hidden while the job has no
// other clip. Props: `applyAll` (the bundle's controller), `group`, `disabled`, and `confirm`: the
// one-layout editor asks first (rombak 06 §10 #51), with its words from the catalog.
import { useCallback, useId, useState, useSyncExternalStore } from "react";
import { useTranslations } from "use-intl";

import { APPLY_GROUPS, applySummary, skippedLines, undoSummary } from "../../../lib/editor/apply-all.mjs";
import ConfirmDialog from "../shell/ConfirmDialog.jsx";
import PillButton from "../ui/PillButton.jsx";
import styles from "./apply-all.module.css";

const NONE = () => () => {};

function Skipped({ list }) {
  const t = useTranslations("editor.applyAll");
  const lines = skippedLines(list);
  if (!lines.length) return null;
  return (
    <details className={styles.applySkipped}>
      <summary>{t("skipped")}</summary>
      <ul>{lines.map((line) => <li key={line}>{line}</li>)}</ul>
    </details>
  );
}

/** The catalog's words of a group, literal keys only. */
function useGroupCopy(group) {
  const t = useTranslations("editor.applyAll");
  return {
    captions: { button: t("captions.button"), note: t("captions.note"), title: t("captions.title") },
    layout: { button: t("layout.button"), note: t("layout.note"), title: t("layout.title") },
    logo: { button: t("logo.button"), note: t("logo.note"), title: t("logo.title") },
  }[group];
}

export default function ApplyAll({ applyAll, group, disabled = false, confirm = false }) {
  const t = useTranslations("editor.applyAll");
  const copy = useGroupCopy(group);
  const [asking, setAsking] = useState(false);
  const noteId = useId();
  const subscribe = useCallback((listener) => (applyAll ? applyAll.subscribe(listener) : NONE()), [applyAll]);
  const view = useSyncExternalStore(subscribe, () => applyAll?.get(group) ?? null, () => null);
  const others = useSyncExternalStore(subscribe, () => applyAll?.others() ?? null, () => null);
  const texts = confirm ? copy : APPLY_GROUPS[group];
  if (!applyAll || !texts || !view || !others) return null;
  const busy = view.phase === "running" || view.phase === "undoing";
  const undone = view.phase === "undone";
  const result = view.phase === "done" || view.phase === "undoing" || undone ? view.result : null;

  return (
    <div className={styles.applyAll} data-apply-all={group}>
      {/* aria-disabled while busy, not disabled: the button keeps keyboard focus for the retry. */}
      <PillButton aria-describedby={noteId} disabled={disabled} aria-disabled={busy || undefined}
        aria-busy={view.phase === "running"} aria-haspopup={confirm ? "dialog" : undefined}
        onClick={() => {
          if (busy) return;
          if (confirm) setAsking(true);
          else applyAll.apply(group);
        }}>
        {view.phase === "running" ? t("running") : texts.button}
      </PillButton>
      <p id={noteId} className={styles.applyNote}>{texts.note}</p>
      {view.phase === "error" && view.message ? <p className={styles.applyError} role="alert">{view.message}</p> : null}
      {confirm ? (
        <ConfirmDialog open={asking} title={copy.title} onCancel={() => setAsking(false)}
          actions={(
            <>
              <PillButton variant="quiet" onClick={() => setAsking(false)}>{t("cancel")}</PillButton>
              <PillButton variant="strong" autoFocus onClick={() => { setAsking(false); applyAll.apply(group); }}>{t("confirm")}</PillButton>
            </>
          )}>
          <p className={styles.applyNote}>{copy.note}</p>
        </ConfirmDialog>
      ) : null}
      <div role="status" aria-live="polite">
        {result ? (
          <div className={styles.applyResult} data-apply-result={view.phase}>
            <div className={styles.applyRow}>
              <p className={styles.applySummary}>{undone ? undoSummary(view.undo) : applySummary(result)}</p>
              {!undone && result.applied?.length ? (
                <PillButton variant="quiet" disabled={busy} aria-busy={view.phase === "undoing"}
                  onClick={() => { applyAll.undo(group); }}>
                  {view.phase === "undoing" ? t("undoing") : t("undo")}
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
