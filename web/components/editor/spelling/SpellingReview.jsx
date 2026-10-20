"use client";

// Cek ejaan's review list, in the style of Rapikan (CleanupReview.jsx): each open suggestion reads
// "…context salah → benar context…" with its kind, and "Terima", "Lewati" and "Putar".
// "Terima semua (n)" accepts every listed row as one Urungkan. After a row leaves the list, focus
// moves to the next row's "Terima" (or the status line), so the keyboard never drops to the page.
//
// Props: { id, check } where `check` is useSpellCheck()'s result.
import { memo, useEffect, useRef } from "react";

import { TASK_SECONDS, rateLimitedText } from "../suggestions/model.mjs";
import { COPY } from "./model.mjs";
import styles from "./spelling.module.css";

function notice(view) {
  switch (view.phase) {
    case "failed": return { alert: true, text: COPY.failed, retry: true };
    case "error": return { alert: true, text: COPY.error, retry: true };
    case "rate_limited": return { alert: true, text: rateLimitedText(view.retryAfterMs), retry: false };
    case "off": return { alert: false, text: view.message ?? COPY.off, retry: false };
    default: return null;
  }
}

const Row = memo(function Row({ row, playing, readOnly, onAccept, onSkip, onPlay }) {
  return (
    <li className={styles.row} data-spelling-row={row.id} data-kind={row.kind}>
      <p className={styles.text}>
        {row.before.length ? <span className={styles.around}>…{row.before.join(" ")} </span> : null}
        <del className={styles.from}>{row.from}</del>
        <span className={styles.arrow} aria-hidden="true"> → </span>
        <span className={styles.srOnly}> jadi </span>
        <ins className={styles.to}>{row.to}</ins>
        {row.after.length ? <span className={styles.around}> {row.after.join(" ")}…</span> : null}
        <span className={styles.kind}>{row.kindLabel}</span>
      </p>
      <span className={styles.actions}>
        <button type="button" className={styles.button} data-spelling-accept="" disabled={readOnly}
          aria-label={`${COPY.accept}: ${row.from} jadi ${row.to}`} onClick={() => onAccept(row)}>
          {COPY.accept}
        </button>
        <button type="button" className={styles.button} aria-label={`${COPY.skip}: ${row.from}`} onClick={() => onSkip(row)}>
          {COPY.skip}
        </button>
        <button type="button" className={styles.button} aria-pressed={playing}
          aria-label={`${playing ? COPY.stop : COPY.play}: ${row.from}`} onClick={() => onPlay(row)}>
          {playing ? COPY.stop : COPY.play}
        </button>
      </span>
    </li>
  );
});

function SpellingReview({ id, check }) {
  const { view, rows, stale, skipped, readOnly, message, playing } = check;
  const listRef = useRef(null);
  const statusRef = useRef(null);
  const focusNext = useRef(null);
  const titleId = `${id}-title`;
  const shown = notice(view);
  const sent = !["idle", "off"].includes(view.phase);

  // A handled row leaves the list: the keyboard goes on to the next one.
  const handled = (row, action) => {
    const index = rows.findIndex((entry) => entry.id === row.id);
    const next = rows[index + 1] ?? rows[index - 1] ?? null;
    if (action(row) !== false) focusNext.current = next ? next.id : "status";
  };
  useEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    focusNext.current = null;
    const button = target === "status" ? null
      : listRef.current?.querySelector(`[data-spelling-row="${CSS.escape(target)}"] [data-spelling-accept]`);
    (button && !button.disabled ? button : statusRef.current)?.focus();
  }, [rows]);

  return (
    <section id={id} className={styles.review} role="region" aria-labelledby={titleId} data-spelling-review="">
      <div className={styles.head}>
        <h2 id={titleId} className={styles.title}>{COPY.title}</h2>
        <p className={styles.note}>{COPY.intro}</p>
        {sent ? <p className={styles.note}>{COPY.privacy}</p> : null}
      </div>
      {view.phase === "checking" || view.phase === "idle" ? (
        <div className={styles.busy} role="status" data-spelling-state="checking">
          <p className={styles.note}>{COPY.checking}</p>
          <div className={styles.track} aria-hidden="true">
            <div className={styles.fill} style={{ "--task-seconds": `${TASK_SECONDS}s` }} />
          </div>
        </div>
      ) : null}
      {shown ? (
        <p className={shown.alert ? styles.error : styles.note} role={shown.alert ? "alert" : "status"} data-spelling-state={view.phase}>
          {shown.text}
          {shown.retry ? <>{" "}<button type="button" className={styles.button} onClick={check.again}>{COPY.retry}</button></> : null}
        </p>
      ) : null}
      {view.phase === "done" && rows.length === 0 ? (
        <p className={styles.note} data-spelling-state="done">{view.suggestions.length ? COPY.finished : COPY.none}</p>
      ) : null}
      {view.phase === "done" && view.truncated ? <p className={styles.note}>{COPY.truncated}</p> : null}
      {rows.length ? (
        <ul ref={listRef} className={styles.list} aria-label="Saran ejaan">
          {rows.map((row) => (
            <Row key={row.id} row={row} playing={playing === row.id} readOnly={readOnly}
              onAccept={(entry) => handled(entry, check.accept)} onSkip={(entry) => handled(entry, check.skip)} onPlay={check.play} />
          ))}
        </ul>
      ) : null}
      <div className={styles.foot}>
        {rows.length || view.phase === "done" ? (
          <p className={styles.footActions}>
            {rows.length ? (
              <button type="button" className={styles.apply} disabled={readOnly}
                onClick={() => { if (check.acceptAll() !== false) focusNext.current = "status"; }}>
                {COPY.acceptAll(rows.length)}
              </button>
            ) : null}
            {view.phase === "done" ? <button type="button" className={styles.button} onClick={check.again}>{COPY.again}</button> : null}
          </p>
        ) : null}
        <p ref={statusRef} className={styles.status} role="status" tabIndex={-1} data-spelling-status="">{message ?? ""}</p>
        {skipped ? (
          <p className={styles.meta}>
            {COPY.skipped(skipped)}{" · "}
            <button type="button" className={styles.linkButton} onClick={check.restoreSkipped}>{COPY.unskip}</button>
          </p>
        ) : null}
        {stale ? <p className={styles.meta}>{COPY.stale(stale)}</p> : null}
      </div>
    </section>
  );
}

export default memo(SpellingReview);
