"use client";

// Hook suggestions under the "Teks hook" field (plan §7.1 "UI"): ghost cards, the instant ones at
// once and the AI ones when the task is done, each with its source label, the fit badge and
// "Pakai" (one undoable command, origin `suggestion:<id>`). The AI lines are hidden while the
// LLM part is off. Props: { state, dispatch, api } (api: createApiClient of Appendix A.2). The
// controller and view state are use-hook-suggestions.js, shared with the Hook card's compact list.
import { COPY, SOURCE_HINTS, SOURCE_LABELS, TASK_SECONDS } from "./model.mjs";
import styles from "./suggestions.module.css";
import { useHookSuggestions } from "./use-hook-suggestions.js";

function Card({ suggestion, current, disabled, onUse }) {
  const label = SOURCE_LABELS[suggestion.source] ?? SOURCE_LABELS.heuristic;
  return (
    <li className={styles.card} data-suggestion={suggestion.id} data-source={suggestion.source}
      data-current={current ? "true" : "false"}>
      <p className={styles.text}>{suggestion.text}</p>
      {suggestion.basis ? (
        <p className={styles.basis}><span className={styles.basisLabel}>{COPY.basis}</span> “{suggestion.basis}”</p>
      ) : null}
      <div className={styles.meta}>
        <span className={styles.source} data-source-label="" title={SOURCE_HINTS[suggestion.source]}>{label}</span>
        {suggestion.style ? <span className={styles.style}>{suggestion.style}</span> : null}
        <span className={styles.fit} data-fit={suggestion.fits ? "fits" : "overflow"}>
          {suggestion.fits ? COPY.fits : COPY.overflow}
        </span>
        <button type="button" className={styles.use} disabled={disabled || current}
          aria-label={current ? `${COPY.used}: ${suggestion.text}` : `${COPY.use} hook: ${suggestion.text}`}
          title={disabled ? COPY.readOnly : undefined} onClick={() => onUse(suggestion)}>
          {current ? COPY.used : COPY.use}
        </button>
      </div>
    </li>
  );
}

export default function HookSuggestions({ state, dispatch, api }) {
  const hook = useHookSuggestions({ state, dispatch, api });
  if (!hook.ready) return null;
  const { view, ai, readOnly } = hook;

  return (
    <section className={styles.section} aria-labelledby="hook-suggestions-title" data-hook-suggestions=""
      data-phase={view.phase}>
      <div className={styles.head}>
        <h4 id="hook-suggestions-title" className={styles.title}>{COPY.title}</h4>
        {hook.stale ? (
          <button type="button" className={styles.link} onClick={hook.refresh} aria-describedby="hook-suggestions-stale">
            {COPY.refresh}
          </button>
        ) : null}
      </div>
      {hook.stale ? <p id="hook-suggestions-stale" className={styles.muted}>{COPY.stale}</p> : null}
      {hook.message ? <p className={styles.problem} role="alert">{hook.message}</p> : null}

      {hook.loadingFirst ? (
        <div className={styles.loading} role="status">
          <p className={styles.muted}>{COPY.loading}</p>
          <div className={styles.placeholder} aria-hidden="true" />
          <div className={styles.placeholder} aria-hidden="true" />
        </div>
      ) : null}
      {view.phase === "error" ? (
        <p className={styles.problem} role="alert">
          {COPY.error}{" "}
          <button type="button" className={styles.link} onClick={hook.refresh}>{COPY.retry}</button>
        </p>
      ) : null}
      {hook.empty ? <p className={styles.muted}>{COPY.empty}</p> : null}

      {view.heuristic.length ? (
        <ul className={styles.list} aria-label="Saran otomatis" aria-busy={view.phase === "loading"}>
          {view.heuristic.map((suggestion) => (
            <Card key={suggestion.id} suggestion={suggestion} current={hook.isCurrent(suggestion)}
              disabled={readOnly} onUse={hook.use} />
          ))}
        </ul>
      ) : null}

      {ai.visible ? (
        <div className={styles.ai} data-ai-status={ai.status}>
          <div aria-live="polite" aria-atomic="true">
            {ai.status === "pending" ? (
              <div className={styles.pending} role="status">
                <p className={styles.muted}>{ai.text}</p>
                <div className={styles.track} aria-hidden="true">
                  <div className={styles.fill} style={{ "--task-seconds": `${TASK_SECONDS}s` }} />
                </div>
              </div>
            ) : null}
            {ai.status === "done" ? <p className={styles.srOnly}>{`${view.llm.suggestions.length} saran AI siap.`}</p> : null}
            {["failed", "rate_limited", "notice", "none"].includes(ai.status) ? (
              <p className={styles.notice} data-ai-notice="">
                {ai.text}
                {ai.status === "failed" ? (
                  <>
                    {" "}
                    <button type="button" className={styles.link} onClick={hook.refresh}>{COPY.retry}</button>
                  </>
                ) : null}
              </p>
            ) : null}
          </div>
          {view.llm.suggestions.length ? (
            <ul className={styles.list} aria-label="Saran AI">
              {view.llm.suggestions.map((suggestion) => (
                <Card key={suggestion.id} suggestion={suggestion} current={hook.isCurrent(suggestion)}
                  disabled={readOnly} onUse={hook.use} />
              ))}
            </ul>
          ) : null}
          {hook.privacy ? <p className={styles.privacy}>{COPY.privacy}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
