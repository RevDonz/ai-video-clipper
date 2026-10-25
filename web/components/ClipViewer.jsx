"use client";

// The clip viewer of a project page (05-ui-dashboard.md §6.4): a Modal opened by ?klip=N (N is
// the clip number), the video beside everything needed to post it. ←/→ move between the clips
// the grid shows, Escape closes, and the page returns focus to the poster that opened it.
// [Unduh MP4] is the one primary action; [Edit klip] is a plain link (a full document load, so
// the editor's COOP/COEP headers arrive, P12). A clip that failed to render shows why where the
// video would be, with nothing to download or edit.
import { Button, buttonVariants } from "@heroui/react";
import { useEffect, useRef } from "react";
import { useTranslations } from "use-intl";

import { clipDownloads } from "../lib/clip-download.mjs";
import { failedClipView } from "../lib/clip-status.mjs";
import { clipLabel } from "../lib/project-view.mjs";
import { arrowDelta, clipFallbackNotes } from "../lib/project-workspace.mjs";
import {
  archetypeLabel,
  captionParts,
  clipFocusChip,
  clipPosterUrl,
  clipRangeChip,
  clipReasonTexts,
  clipScoreView,
  clipTrendChips,
  coldOpenLength,
  formatTenths,
  formatTimestamp,
} from "../lib/selection-v3-view.mjs";
import ClipText from "./ClipText.jsx";
import styles from "./ClipViewer.module.css";
import HookSwitch from "./HookSwitch.jsx";
import { useRenderModeName } from "./layout-names.jsx";
import TrendChips from "./trends/TrendChips.jsx";
import Modal from "./ui/Modal.jsx";

const COMPACT = "(max-width: 767px)";

function CopyButton({ state, label, done, failed, onPress }) {
  return (
    <Button variant="ghost" size="sm" className={styles.copy} data-state={state || undefined} onPress={onPress}>
      {state === "copied" ? done : state === "failed" ? failed : label}
    </Button>
  );
}

function Body({ clip, job, entry, copied, onCopy, textDrafts, onClipSaved, onEntriesChanged, titleId }) {
  const t = useTranslations("project");
  const tAll = useTranslations();
  const layoutName = useRenderModeName();
  const failed = failedClipView(clip);
  const label = clipLabel(clip);
  const score = clipScoreView(clip);
  const archetype = archetypeLabel(clip.archetype);
  const coldOpen = coldOpenLength(clip);
  const caption = captionParts(clip);
  const reasons = clipReasonTexts(tAll, clip);
  const trendChips = clipTrendChips(clip);
  const focusChip = clipFocusChip(clip, job);
  const rangeChip = clipRangeChip(clip);
  const notes = clipFallbackNotes(clip);
  const from = formatTimestamp(clip.sourceStart);
  const to = formatTimestamp(clip.sourceEnd);
  const edited = entry?.editBadge?.tone === "edited";
  // A clip whose face was not found was cut from the middle (lib/jobs.mjs CLIP_FALLBACKS).
  const layout = clip.fallbacks?.includes?.("no_face") ? layoutName("center-crop") : layoutName(job.options?.renderMode);
  const titleState = copied?.what === "title" ? copied.status : "";
  const captionState = copied?.what === "caption" ? copied.status : "";
  const editable = job.status === "completed" && !failed;
  const tags = [rangeChip, archetype, coldOpen !== null ? t("viewer.coldOpen", { seconds: formatTenths(coldOpen) }) : null].filter(Boolean);

  return (
    <div className={styles.body}>
      {failed ? (
        <div key={clip.index} className={`${styles.video} ${styles.failedFrame}`}>
          <span className="statusPill error">{failed.label}</span>
          <p><strong>{failed.text}</strong></p>
          <p>{failed.hint}</p>
        </div>
      ) : (
        <video key={clip.index} className={styles.video} controls preload="metadata" src={clip.videoUrl} poster={clipPosterUrl(clip)}
          aria-label={t("viewer.video", { clip: label })} />
      )}
      <div className={styles.details} lang={job.options?.videoLanguage && job.options.videoLanguage !== "auto" ? job.options.videoLanguage : undefined}>
        {(tags.length > 0 || focusChip || edited) && (
          <div className={styles.tags}>
            {tags.map((tag) => <span key={tag} className="statusPill">{tag}</span>)}
            {focusChip && <span className={`statusPill ${styles.focusChip}`} data-focus={focusChip.tone}>{focusChip.label}</span>}
            {edited && <span className="statusPill info">{entry.editBadge.text}</span>}
          </div>
        )}
        <div className={styles.titleRow}>
          <h3 id={titleId}>{clip.title || label}</h3>
          {clip.title && (
            <CopyButton state={titleState} label={t("viewer.copyTitle")} done={t("viewer.copied")} failed={t("viewer.copyFailed")} onPress={() => onCopy(clip, "title")} />
          )}
        </div>
        {score?.total !== null && score?.total !== undefined && (
          // A plain role=meter: HeroUI's Meter writes role="meter progressbar", which axe reads as
          // one unknown role and then refuses its aria-value* attributes.
          <div className={styles.score} role="meter" aria-valuenow={score.total} aria-valuemin={0} aria-valuemax={10}
            aria-valuetext={formatTenths(score.total)} aria-labelledby={`${titleId}-score`}>
            <span id={`${titleId}-score`} className={styles.scoreLabel}>{t("viewer.score")}</span>
            <span className={styles.scoreValue} aria-hidden="true">{formatTenths(score.total)}</span>
            <span className={styles.bar} aria-hidden="true"><i style={{ width: `${Math.max(0, Math.min(100, score.total * 10))}%` }} /></span>
          </div>
        )}
        {notes.length > 0 && (
          <ul className={styles.clipNotes} aria-label={t("viewer.notes")}>
            {notes.map((note) => <li key={note.code}>{note.text}</li>)}
          </ul>
        )}
        {clip.hookText && <p className={styles.hook}><span>{t("viewer.hookText")}</span>{clip.hookText}</p>}
        <section className={styles.caption} aria-labelledby={`${titleId}-caption`}>
          <h4 id={`${titleId}-caption`}>{t("viewer.caption")}</h4>
          <ClipText key={`text-${clip.index}`} jobId={job.id} clip={clip} editable={editable} drafts={textDrafts} onSaved={onClipSaved}
            view={(caption.body || caption.hashtags.length > 0) && (
              <>
                {caption.body && <p className={styles.captionBody}>{caption.body}</p>}
                {caption.hashtags.length > 0 && <p className={styles.hashtags}>{caption.hashtags.map((tag) => <span key={tag}>{tag}</span>)}</p>}
              </>
            )}
            copy={<CopyButton state={captionState} label={t("viewer.copyCaption")} done={t("viewer.copied")} failed={t("viewer.copyFailed")} onPress={() => onCopy(clip, "caption")} />} />
          <HookSwitch key={`hook-${clip.index}`} jobId={job.id} entry={entry} editable={editable} onChanged={onEntriesChanged} />
        </section>
        {trendChips.length > 0 && <TrendChips chips={trendChips} />}
        <p className={styles.range}>
          {from && to && <span>{t("viewer.range", { from, to })}</span>}
          {layout && <span>{t("viewer.layout", { value: layout })}</span>}
        </p>
        {(reasons.length > 0 || score?.rows?.length > 0) && (
          <details className={styles.why}>
            <summary>{t("viewer.why")}</summary>
            {reasons.length > 0 && <ul>{reasons.map((reason, at) => <li key={`${clip.index}-reason-${at}`}>{reason}</li>)}</ul>}
            {score?.rows?.length > 0 && (
              <dl className={styles.scoreRows}>
                {score.rows.map((row) => (
                  <div key={row.name}>
                    <dt>{row.label}</dt>
                    <dd>
                      <span className={styles.bar} aria-hidden="true"><i style={{ width: `${Math.max(0, Math.min(100, row.percent))}%` }} /></span>
                      <b>{formatTenths(row.value)}</b>
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </details>
        )}
        <span className="visuallyHidden" role="status" aria-live="polite">
          {copied?.status === "copied" ? (copied.what === "title" ? t("viewer.titleCopied") : t("viewer.captionCopied"))
            : copied?.status === "failed" ? t("viewer.copyFailed") : ""}
        </span>
      </div>
    </div>
  );
}

function Actions({ clip, entry }) {
  const t = useTranslations("project");
  const failed = failedClipView(clip);
  const downloads = clipDownloads(clip);
  const latest = entry?.latestExport;
  if (failed) return null;
  return (
    <div className={styles.actions}>
      {downloads.mp4 && <a className={buttonVariants({ variant: "primary" })} href={downloads.mp4} download={downloads.mp4File || true}>{t("viewer.downloadMp4")}</a>}
      {entry?.editHref
        ? <a className={buttonVariants({ variant: "secondary" })} href={entry.editHref}>{t("viewer.editClip")}</a>
        : entry?.reasonText && <span className={styles.editNote}>{entry.reasonText}</span>}
      {latest?.href && <a className={buttonVariants({ variant: "ghost" })} href={latest.href} download={latest.filename || true}>{latest.label}</a>}
      {latest && !latest.href && <span className={styles.editNote}>{latest.label}</span>}
      {downloads.srt && (
        <a className={buttonVariants({ variant: "ghost" })} href={downloads.srt} download={downloads.srtFile || true}
          aria-label={t("viewer.srtFor", { clip: clipLabel(clip) })}>{t("viewer.srt")}</a>
      )}
    </div>
  );
}

/**
 * `clips`: the clips the grid shows, in its order; `index` the open clip's number (null: closed).
 * `onMove(index)` shows another clip, `onClose()` closes the viewer.
 */
export default function ClipViewer({ job, clips, index, entryFor, copyState, onCopy, textDrafts, onClipSaved, onEntriesChanged, onMove, onClose }) {
  const t = useTranslations("project");
  const tAria = useTranslations("aria");
  const compact = useRef(false);
  const at = clips.findIndex((clip) => clip.index === index);
  const clip = at >= 0 ? clips[at] : null;
  const keyHandler = useRef(null);
  if (typeof window !== "undefined") compact.current = window.matchMedia?.(COMPACT).matches ?? false;

  const step = (delta) => {
    const next = clips[at + delta];
    if (next) onMove(next.index);
  };

  keyHandler.current = (event) => {
    const delta = arrowDelta(event);
    if (!delta) return;
    event.preventDefault();
    step(delta);
  };

  useEffect(() => {
    if (!clip) return undefined;
    const listener = (event) => keyHandler.current?.(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, [Boolean(clip)]);

  const titleId = clip ? `clip-${clip.index}-title` : undefined;
  const entry = clip ? entryFor(clip) : null;

  return (
    <Modal.Backdrop isOpen={Boolean(clip)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Modal.Container size={compact.current ? "full" : "lg"} scroll="inside" className={styles.container}>
        <Modal.Dialog aria-labelledby={titleId} className={styles.dialog} data-clip-detail={clip?.index}>
          {clip && (
            <>
              <Modal.Header className={styles.header}>
                <Modal.Heading level={2} className={styles.position}>{t("viewer.position", { n: at + 1, total: clips.length })}</Modal.Heading>
                <div className={styles.stepper}>
                  <Button variant="ghost" isIconOnly aria-label={tAria("prev")} isDisabled={at <= 0} onPress={() => step(-1)}>
                    <span aria-hidden="true">‹</span>
                  </Button>
                  <Button variant="ghost" isIconOnly aria-label={tAria("next")} isDisabled={at >= clips.length - 1} onPress={() => step(1)}>
                    <span aria-hidden="true">›</span>
                  </Button>
                  <Modal.CloseTrigger aria-label={tAria("close")} className={styles.close} />
                </div>
              </Modal.Header>
              <Modal.Body className={styles.modalBody}>
                <Body clip={clip} job={job} entry={entry} copied={copyState.index === clip.index ? copyState : null} onCopy={onCopy}
                  textDrafts={textDrafts} onClipSaved={onClipSaved} onEntriesChanged={onEntriesChanged} titleId={titleId} />
              </Modal.Body>
              <Modal.Footer className={styles.footer}>
                <Actions clip={clip} entry={entry} />
              </Modal.Footer>
            </>
          )}
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
