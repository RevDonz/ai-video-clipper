"use client";

// One clip poster, drawn the same on the project page (inside a button that picks the clip) and
// in the Riwayat clip grid (inside a link to the clip in its project). The wrapper takes
// `posterFrame`; these two fill it.
import { useTranslations } from "use-intl";

import styles from "./ClipPoster.module.css";

export const posterFrame = styles.frame;

/**
 * The clip's frame (or a play mark for an old clip), with its number and length on solid chips.
 * A `badge` (the "Gagal" chip of a clip that failed to render) takes the frame's place.
 */
export function PosterThumb({ poster, number, length, badge = null, children = null }) {
  return (
    <span className={styles.thumb}>
      {badge || (poster ? <img src={poster} alt="" loading="lazy" decoding="async" /> : <i className={styles.play} aria-hidden="true" />)}
      <span className={styles.number} aria-hidden="true">{number}</span>
      {length && <span className={styles.length} aria-hidden="true">{length}</span>}
      {children}
    </span>
  );
}

/**
 * The title on two lines, the neutral score pill (a lime dot from 8,0), "Diedit", the page's own
 * `flags` on the same row (the project page's fallback notes), and an optional note line.
 */
export function PosterText({ titleId, title, pill = null, edited = false, flags = [], note = null, children = null }) {
  const t = useTranslations("common");
  const hasFlags = Array.isArray(flags) && flags.length > 0;
  return (
    <span className={styles.text}>
      <span id={titleId} className={styles.title}>{title}</span>
      {(pill || edited || hasFlags) && (
        <span className={styles.meta} aria-hidden="true">
          {pill && <span className={styles.scorePill} data-high={pill.high || undefined}>{pill.high && <i />}{pill.text}</span>}
          {edited && <span className={styles.edited}>{t("edited")}</span>}
          {hasFlags && flags}
        </span>
      )}
      {note && <span className={styles.note} aria-hidden="true">{note}</span>}
      {children}
    </span>
  );
}
