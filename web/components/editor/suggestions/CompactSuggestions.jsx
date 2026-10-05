"use client";

// The Hook card's suggestions (docs/plans/2026-10-02-editor-mode-cepat.md §1.4 Hook, AC17): the Teks
// panel's two lists and every state of them, with the same copy (model.mjs COPY, aiView), each
// suggestion one 44 px button. The current one is pressed; a click applies the others as one
// undoable command. The privacy line follows the panel's rule: whenever the AI part shows and is
// not a settings notice. Props: { state, dispatch, api }.
import { useId } from "react";

import PillButton from "../ui/PillButton.jsx";
import { COPY, TASK_SECONDS } from "./model.mjs";
import styles from "./suggestions.module.css";
import { useHookSuggestions } from "./use-hook-suggestions.js";

function SuggestionList({ items, label, labelledBy, hook, busy = false }) {
  return (
    <ul className={styles.compactList} aria-label={labelledBy ? undefined : label} aria-labelledby={labelledBy}
      aria-busy={busy}>
      {items.map((suggestion) => {
        const current = hook.isCurrent(suggestion);
        return (
          <li key={suggestion.id}>
            <button type="button" className={styles.compactButton} data-suggestion={suggestion.id} data-source={suggestion.source}
              aria-pressed={current} disabled={hook.readOnly} title={hook.readOnly ? COPY.readOnly : undefined}
              onClick={() => { if (!current) hook.use(suggestion); }}>
              <span className={styles.compactText}>{suggestion.text}</span>
              {suggestion.fits ? null : <span className={styles.compactFit} data-fit="overflow">{COPY.overflow}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export default function CompactSuggestions({ state, dispatch, api }) {
  const hook = useHookSuggestions({ state, dispatch, api });
  const uid = useId();
  if (!hook.ready) return null;
  const { view, ai } = hook;
  const ids = { title: `${uid}-title`, stale: `${uid}-stale`, ai: `${uid}-ai` };

  return (
    <section className={styles.compact} aria-labelledby={ids.title} data-hook-suggestions="" data-phase={view.phase}>
      <h3 id={ids.title} className={styles.compactTitle}>Saran</h3>
      {hook.stale ? (
        <div className={styles.compactRow}>
          <p id={ids.stale} className={styles.compactNote}>{COPY.stale}</p>
          <PillButton variant="quiet" onClick={hook.refresh} aria-describedby={ids.stale}>{COPY.refresh}</PillButton>
        </div>
      ) : null}
      {hook.message ? <p className={styles.problem} role="alert">{hook.message}</p> : null}
      {hook.loadingFirst ? <p className={styles.compactNote} role="status">{COPY.loading}</p> : null}
      {view.phase === "error" ? (
        <div className={styles.compactRow}>
          <p className={styles.problem} role="alert">{COPY.error}</p>
          <PillButton variant="quiet" onClick={hook.refresh}>{COPY.retry}</PillButton>
        </div>
      ) : null}
      {hook.empty ? <p className={styles.compactNote}>{COPY.empty}</p> : null}

      {view.heuristic.length ? (
        <SuggestionList items={view.heuristic} label="Saran otomatis" hook={hook} busy={view.phase === "loading"} />
      ) : null}

      {ai.visible ? (
        <div className={styles.compactAi} data-ai-status={ai.status}>
          <div aria-live="polite" aria-atomic="true">
            {ai.status === "pending" ? (
              <div className={styles.pending} role="status">
                <p className={styles.compactNote}>{ai.text}</p>
                <div className={styles.track} aria-hidden="true">
                  <div className={styles.fill} style={{ "--task-seconds": `${TASK_SECONDS}s` }} />
                </div>
              </div>
            ) : null}
            {ai.status === "done" ? <p className={styles.srOnly}>{`${view.llm.suggestions.length} saran AI siap.`}</p> : null}
            {["failed", "rate_limited", "notice", "none"].includes(ai.status) ? (
              <p className={styles.compactNotice} data-ai-notice="">{ai.text}</p>
            ) : null}
          </div>
          {ai.status === "failed" ? <PillButton variant="quiet" onClick={hook.refresh}>{COPY.retry}</PillButton> : null}
          {view.llm.suggestions.length ? (
            <>
              <p id={ids.ai} className={styles.compactLabel}>Saran AI</p>
              <SuggestionList items={view.llm.suggestions} labelledBy={ids.ai} hook={hook} />
            </>
          ) : null}
          {hook.privacy ? <p className={styles.compactNote} data-ai-privacy="">{COPY.privacy}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
