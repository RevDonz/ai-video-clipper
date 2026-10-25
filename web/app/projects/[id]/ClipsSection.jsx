"use client";

// The clips of a project (05-ui-dashboard.md §6.4): Terbaik | Urutan video, the filters (Semua,
// Skor 8+, Diedit, Di luar fokus), [Pilih] for a ZIP of some clips, and the 9:16 posters. A
// running job's clips appear here one by one as they render. A poster opens the clip viewer
// (?klip=N); in Pilih it toggles the clip instead. Its own file, so the pick bar's Unduh (n) is
// the one primary action here; Unduh semua is the page's.
import { Button, ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";

import { PosterText, PosterThumb, posterFrame } from "../../../components/ClipPoster.jsx";
import ClipViewer from "../../../components/ClipViewer.jsx";
import { clipEntryFor } from "../../../lib/clip-entry-view.mjs";
import { msg } from "../../../lib/i18n/descriptor.mjs";
import { failedClipView, isFailedClip, readyClips } from "../../../lib/clip-status.mjs";
import { clipLabel } from "../../../lib/project-view.mjs";
import {
  clipFallbackNotes,
  clipFilterView,
  editedIndexes,
  pickAll,
  pickedInOrder,
  prunePicks,
  scorePill,
  sortClips,
  togglePick,
} from "../../../lib/project-workspace.mjs";
import { clipFocusChip, clipPosterUrl, formatTimestamp } from "../../../lib/selection-v3-view.mjs";
import styles from "./project.module.css";

const asKey = (keys) => (keys === "all" ? null : [...keys][0] ?? null);

function useFilterNames() {
  const t = useTranslations("project");
  return { all: t("filter.all"), high: t("filter.high"), edited: t("filter.edited"), outsideFocus: t("filter.outsideFocus") };
}

function useEmptyFilterText() {
  const t = useTranslations("project");
  return { all: t("filter.allEmpty"), high: t("filter.highEmpty"), edited: t("filter.editedEmpty"), outsideFocus: t("filter.outsideFocusEmpty") };
}

// One poster of the grid. Outside Pilih it opens its clip in the viewer; in Pilih it toggles the
// clip for the ZIP. A clip that failed to render says Gagal in its frame and cannot be picked.
function PosterCard({ clip, entry, picking, picked, onActivate, buttonRef }) {
  const t = useTranslations("project");
  const tAll = useTranslations();
  const titleId = `poster-${clip.index}-title`;
  const metaId = `poster-${clip.index}-meta`;
  const failed = failedClipView(clip);
  const pickable = picking && !failed;
  const pill = scorePill(clip);
  const length = formatTimestamp(clip.duration);
  const number = String(clip.index).padStart(2, "0");
  const edited = entry?.editBadge?.tone === "edited";
  const cardNotes = clipFallbackNotes(clip).filter((note) => note.card).map((note) => ({ ...note, card: msg(tAll, note.card) }));
  const meta = [
    t("poster.number", { n: number }), failed && t("poster.failed"), length, pill && t("poster.score", { score: pill.text }),
    edited && t("poster.edited"), ...cardNotes.map((note) => note.card.toLowerCase()),
  ].filter(Boolean).join(", ");
  return (
    <li>
      <article className={styles.poster} aria-labelledby={titleId} data-picked={(pickable && picked) || undefined} data-failed={failed ? "true" : undefined}>
        <button
          type="button"
          ref={buttonRef}
          className={`${posterFrame} ${styles.posterButton}`}
          data-poster={clip.index}
          aria-labelledby={titleId}
          aria-describedby={metaId}
          aria-pressed={pickable ? picked : undefined}
          aria-disabled={picking && failed ? "true" : undefined}
          aria-haspopup={picking ? undefined : "dialog"}
          onClick={() => onActivate(clip.index)}
        >
          <PosterThumb poster={clipPosterUrl(clip)} number={number} length={length}
            badge={failed && <span className="statusPill error">{msg(tAll, failed.label)}</span>}>
            {pickable && <span className={styles.check} aria-hidden="true" />}
          </PosterThumb>
          <PosterText titleId={titleId} title={clip.title || clipLabel(clip)} pill={pill} edited={edited}
            flags={cardNotes.map((note) => <span key={note.code} className={styles.posterNote}>{note.card}</span>)}>
            <span id={metaId} className="visuallyHidden">{meta}</span>
          </PosterText>
        </button>
      </article>
    </li>
  );
}

export default function ClipsSection({ job, entries, zip, onDownload, viewing, onView, copyState, onCopy, onClipSaved, onEntriesChanged }) {
  const t = useTranslations("project");
  const filterNames = useFilterNames();
  const emptyText = useEmptyFilterText();
  const clips = Array.isArray(job.clips) ? job.clips : [];
  const [sort, setSort] = useState("best");
  const [filter, setFilter] = useState("all");
  const [picking, setPicking] = useState(false);
  const [picks, setPicks] = useState(() => new Set());
  const posterRefs = useRef(new Map());
  const pickButton = useRef(null);
  const focusAfter = useRef(null);
  // Unsaved title/description drafts and open suggestions, by clip number, while another clip shows.
  const textDrafts = useRef(new Map());
  const opener = useRef(null);

  // A failed clip has no file: no editor entry, nothing to pick.
  const entryFor = (clip) => (isFailedClip(clip) ? null : clipEntryFor(entries, job, clip.index));
  const edited = editedIndexes(clips, entryFor);
  const outside = new Set(clips.filter((clip) => clipFocusChip(clip, job)?.tone === "none").map((clip) => clip.index));
  const view = clipFilterView(sortClips(clips, sort), filter, edited, outside);
  const visible = view.visible;
  const downloadable = job.status === "completed" && readyClips(clips).length > 0;
  const busy = zip.state === "checking";

  const startPicking = () => {
    setPicking(true);
    setPicks(new Set());
    focusAfter.current = "poster";
  };
  const stopPicking = () => {
    setPicking(false);
    setPicks(new Set());
    focusAfter.current = "pick";
  };

  const changeFilter = (value) => {
    setFilter(value);
    setPicks((previous) => prunePicks(previous, clipFilterView(clips, value, edited, outside).visible));
  };

  const activate = (index) => {
    if (picking) {
      if (!isFailedClip(clips.find((clip) => clip.index === index))) setPicks((previous) => togglePick(previous, index));
      return;
    }
    opener.current = index;
    onView(index);
  };

  // Closing the viewer returns focus to the poster of the clip it showed last.
  const closeViewer = () => {
    const last = viewing;
    onView(null);
    requestAnimationFrame(() => posterRefs.current.get(last ?? opener.current)?.focus());
  };

  useEffect(() => {
    const target = focusAfter.current;
    focusAfter.current = null;
    if (target === "poster") posterRefs.current.get(visible[0]?.index)?.focus();
    if (target === "pick") pickButton.current?.focus();
  }, [picking]);

  // Escape leaves Pilih.
  useEffect(() => {
    if (!picking) return undefined;
    const listener = (event) => { if (event.key === "Escape" && !event.defaultPrevented) stopPicking(); };
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, [picking]);

  if (!clips.length) return null;

  return (
    <section id="klip" className={styles.clips} aria-labelledby="clips-title">
      <h2 id="clips-title" className="visuallyHidden">{t("clips.title")}</h2>
      <div className={styles.clipsBar}>
        <ToggleButtonGroup aria-label={t("sort.label")} disallowEmptySelection selectedKeys={[sort]}
          onSelectionChange={(keys) => { const key = asKey(keys); if (key) setSort(String(key)); }} className={styles.segmented}>
          <ToggleButton id="best">{t("sort.best")}</ToggleButton>
          <ToggleButton id="timeline">{t("sort.timeline")}</ToggleButton>
        </ToggleButtonGroup>
        {view.showFilters && (
          <ToggleButtonGroup aria-label={t("filter.label")} disallowEmptySelection selectedKeys={[view.active]}
            onSelectionChange={(keys) => { const key = asKey(keys); if (key) changeFilter(String(key)); }} className={styles.segmented}>
            {view.filters.map((item) => (
              <ToggleButton key={item.value} id={item.value}>
                {filterNames[item.value]} <span className={styles.count}>{item.count}</span>
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        )}
        {downloadable && !picking && (
          <Button ref={pickButton} variant="secondary" className={styles.pickButton} onPress={startPicking}>{t("select")}</Button>
        )}
      </div>

      {picking && (
        <div className={styles.pickBar} role="group" aria-label={t("bulk.label")}>
          <span className={styles.pickCount} aria-live="polite">{t("bulk.count", { count: picks.size })}</span>
          <Button variant="ghost" onPress={() => setPicks(pickAll(visible))}>{t("bulk.all")}</Button>
          <Button variant="ghost" onPress={stopPicking}>{t("bulk.cancel")}</Button>
          <Button variant="primary" isDisabled={!picks.size} isPending={busy}
            onPress={async () => { if (await onDownload(pickedInOrder(clips, picks))) stopPicking(); }}>
            {t("bulk.download", { n: picks.size })}
          </Button>
        </div>
      )}

      {visible.length > 0 ? (
        <ul className={styles.posterGrid} aria-label={t("clips.list")} aria-live={job.status === "completed" ? undefined : "polite"}>
          {visible.map((clip) => (
            <PosterCard key={clip.index} clip={clip} entry={entryFor(clip)} picking={picking} picked={picks.has(clip.index)} onActivate={activate}
              buttonRef={(node) => {
                posterRefs.current.set(clip.index, node);
                return () => posterRefs.current.delete(clip.index);
              }} />
          ))}
        </ul>
      ) : (
        <div className={styles.filterEmpty}>
          <span>{emptyText[view.active]}</span>
          <Button variant="secondary" onPress={() => changeFilter("all")}>{t("filter.showAll")}</Button>
        </div>
      )}

      <ClipViewer job={job} clips={visible} index={picking ? null : viewing} entryFor={entryFor} copyState={copyState} onCopy={onCopy}
        textDrafts={textDrafts.current} onClipSaved={onClipSaved} onEntriesChanged={onEntriesChanged} onMove={onView} onClose={closeViewer} />
    </section>
  );
}
