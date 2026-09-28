"use client";

// "Rapikan" (plan §7.3): the review list of fillers, repeats and long gaps, shown in the
// transcript panel. Items come in transcript order, grouped by class, each with its words in
// context, "Putar" (audition from the preview) and "Lihat" (select it in the transcript).
// Fillers and repeats start unchecked, silent gaps checked (the list's `defaultOn`); voiced gaps
// can only be heard. "Terapkan (n)" applies the checked items as one undoable command. Protected
// particles are never listed; the copy says honestly why the filler list can be short.
//
// Props: { view (cleanup-model.mjs), status: "idle"|"loading"|"ready"|"error", isChecked(entry),
// onToggle(id, on), onGroup(kind, on), onApply(), onPlay(entry), playing (entry id | null),
// onReveal(entry), onRetry(), readOnly, message, fps }.
import { memo } from "react";

import { KIND_LABELS, KIND_ORDER } from "./cleanup-model.mjs";
import styles from "./transcript.module.css";

const SECONDS = new Intl.NumberFormat("id-ID", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const seconds = (ms) => `${SECONDS.format(ms / 1000)} dtk`;
const HINTS = Object.freeze({
  filler: "Belum dicentang otomatis: periksa dulu.",
  repeat: "Kata atau frasa yang diulang saat bicara tersendat; yang terakhir dipertahankan.",
  gap_silent: "Jeda hening dipendekkan menjadi 0,2 dtk.",
  gap_voiced: "Jeda yang masih ada suaranya: dengarkan dulu. Memendekkannya belum tersedia.",
});

export function entryLabel(entry) {
  if (entry.kind === "gap_silent" || entry.kind === "gap_voiced") return `jeda ${seconds(entry.durationMs)}`;
  return entry.context.removed;
}

function Context({ entry }) {
  const { before, removed, kept, after } = entry.context;
  const gap = entry.kind === "gap_silent" || entry.kind === "gap_voiced";
  return (
    <span className={styles.reviewContext}>
      {before ? <span className={styles.reviewAround}>…{before} </span> : null}
      {gap ? (
        <span className={styles.reviewGap}>
          jeda {seconds(entry.durationMs)}{entry.keptMs !== null ? ` → ${seconds(entry.keptMs)}` : ""}
        </span>
      ) : <del className={styles.reviewRemoved}>{removed}</del>}
      {kept ? <> <span className={styles.reviewKept}>{kept}</span></> : null}
      {after ? <span className={styles.reviewAround}> {after}…</span> : null}
    </span>
  );
}

const Row = memo(function Row({ entry, checked, onToggle, onPlay, playing, onReveal, readOnly }) {
  const label = entryLabel(entry);
  const inputId = `cleanup-${entry.id}`;
  return (
    <li className={styles.reviewRow} data-cleanup-item={entry.id} data-kind={entry.kind}
      data-words={entry.item?.wordIds?.join(" ") ?? ""}>
      {entry.checkable ? (
        <input id={inputId} type="checkbox" className={styles.reviewCheck} checked={checked} disabled={readOnly}
          onChange={(event) => onToggle(entry.id, event.target.checked)} />
      ) : <span className={styles.reviewNoCheck} aria-hidden="true" />}
      {entry.checkable
        ? <label htmlFor={inputId} className={styles.reviewText}><Context entry={entry} /></label>
        : <span className={styles.reviewText}><Context entry={entry} /></span>}
      <span className={styles.reviewActions}>
        <button type="button" className={styles.tool} aria-label={`${playing ? "Hentikan" : "Putar"}: ${label}`}
          aria-pressed={playing} onClick={() => onPlay(entry)}>
          {playing ? "Hentikan" : "Putar"}
        </button>
        <button type="button" className={styles.tool} aria-label={`Lihat di transkrip: ${label}`} onClick={() => onReveal(entry)}>
          Lihat
        </button>
      </span>
    </li>
  );
});

function CleanupReview({ view, status, isChecked, onToggle, onGroup, onApply, onPlay, playing, onReveal, onRetry, readOnly, message }) {
  const entries = view?.entries ?? [];
  const count = entries.filter((entry) => entry.checkable && isChecked(entry)).length;
  const missingGaps = view?.missing?.includes("audio_timeline");
  return (
    <section id="cleanup-review" className={styles.review} role="region" aria-labelledby="cleanup-review-title" data-cleanup-review="">
      <div className={styles.reviewHead}>
        <h2 id="cleanup-review-title" className={styles.reviewTitle}>Rapikan</h2>
        <p className={styles.reviewNote}>
          Whisper sering tidak menulis “eh/em”, jadi daftar kata pengisi bisa pendek. Partikel seperti sih, dong
          dan kok tidak pernah diusulkan; hapus sendiri di transkrip bila perlu.
        </p>
      </div>
      {status === "loading" || status === "idle" ? <p className={styles.reviewEmpty}>Mencari yang bisa dirapikan…</p> : null}
      {status === "error" ? (
        <p className={styles.reviewError} role="alert">
          Daftar Rapikan belum tersedia.{" "}
          <button type="button" className={styles.tool} onClick={onRetry}>Coba lagi</button>
        </p>
      ) : null}
      {status === "ready" && entries.length === 0 ? <p className={styles.reviewEmpty}>Tidak ada yang perlu dirapikan di klip ini.</p> : null}
      {status === "ready" && missingGaps ? (
        <p className={styles.reviewEmpty}>Jeda hening tidak tersedia untuk job ini (analisis audio tidak ada).</p>
      ) : null}
      {status === "ready" ? KIND_ORDER.map((kind) => {
        const group = entries.filter((entry) => entry.kind === kind);
        if (!group.length) return null;
        const legendId = `cleanup-group-${kind}`;
        const checkable = group.some((entry) => entry.checkable);
        return (
          <fieldset key={kind} className={styles.reviewGroup} aria-labelledby={legendId} data-cleanup-group={kind}>
            <legend id={legendId} className={styles.reviewLegend}>{KIND_LABELS[kind]} ({group.length})</legend>
            <p className={styles.reviewHint}>{HINTS[kind]}</p>
            {checkable && !readOnly ? (
              <p className={styles.reviewBulk}>
                <button type="button" className={styles.linkButton} onClick={() => onGroup(kind, true)}>Pilih semua</button>
                <button type="button" className={styles.linkButton} onClick={() => onGroup(kind, false)}>Kosongkan</button>
              </p>
            ) : null}
            <ul className={styles.reviewList}>
              {group.map((entry) => (
                <Row key={entry.id} entry={entry} checked={isChecked(entry)} onToggle={onToggle} onPlay={onPlay}
                  playing={playing === entry.id} onReveal={onReveal} readOnly={readOnly} />
              ))}
            </ul>
          </fieldset>
        );
      }) : null}
      <div className={styles.reviewFoot}>
        <button type="button" className={styles.apply} disabled={readOnly || count === 0 || status !== "ready"} onClick={onApply}>
          Terapkan ({count})
        </button>
        <p className={styles.reviewStatus} role="status">{message ?? ""}</p>
        {view?.hidden.applied ? <p className={styles.reviewMeta}>{view.hidden.applied} sudah diterapkan · urungkan dengan Ctrl+Z</p> : null}
        {view?.locked ? <p className={styles.reviewMeta}>{view.locked} saran di sekitar tawa dikunci</p> : null}
      </div>
    </section>
  );
}

export default memo(CleanupReview);
