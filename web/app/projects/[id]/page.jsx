"use client";

import { use, useEffect, useRef, useState } from "react";

import AppHeader from "../../../components/AppHeader.jsx";
import { PosterText, PosterThumb, posterFrame } from "../../../components/ClipPoster.jsx";
import StageSummary from "../../../components/StageSummary.jsx";
import TrendChips from "../../../components/trends/TrendChips.jsx";
import { clipDownloads, formatSize } from "../../../lib/clip-download.mjs";
import { clipEntryFor, loadClipEntries } from "../../../lib/clip-entry-view.mjs";
import { jobHelpHref } from "../../../lib/help-catalog.mjs";
import {
  clipLabel,
  failureDetail,
  failureHint,
  formatProjectDate,
  isActiveStatus,
  loadProjectDetail,
  projectName,
  projectProgress,
  projectStageText,
  statusLabel,
} from "../../../lib/project-view.mjs";
import {
  arrowDelta,
  checkZip,
  clipFallbackNotes,
  clipFilterView,
  clipFromParam,
  clipPosition,
  keepSelection,
  pickAll,
  pickSummary,
  pickedInOrder,
  prunePicks,
  scorePill,
  stepSelection,
  togglePick,
} from "../../../lib/project-workspace.mjs";
import {
  archetypeLabel,
  captionParts,
  clipCaptionText,
  clipFocusChip,
  clipPosterUrl,
  clipReasons,
  clipScoreView,
  clipTrendChips,
  coldOpenLength,
  focusSummaryLine,
  formatTenths,
  formatTimestamp,
  selectionNotes,
  selectionNotices,
} from "../../../lib/selection-v3-view.mjs";
import focusStyles from "./focus.module.css";
import styles from "./project.module.css";

// A running job is re-read on this interval until it finishes.
const POLL_MS = 5000;
const COPY_RESET_MS = 2200;
// At this width the detail panel sits under the grid, so picking a poster scrolls to it.
const STACKED = "(max-width: 720px)";
const DETAIL_ID = "klip-detail";
const NO_SEARCH = Promise.resolve({});

function Notice({ notice }) {
  return (
    <div className={`notice ${notice.tone}`}>
      {notice.title && <strong>{notice.title}</strong>}
      <span>{notice.text}</span>
      {(notice.href || notice.help) && (
        <span className={styles.noticeLinks}>
          {notice.help && <a className={styles.noticeLink} href={notice.help}>Cara memperbaiki</a>}
          {notice.href && <a className={styles.noticeLink} href={notice.href}>{notice.action}</a>}
        </span>
      )}
    </div>
  );
}

// Fokus klip: "Fokus: jomok, jomokers · 5 dari 8 klip cocok". Nothing for jobs without focus.
function FocusSummary({ job }) {
  const view = focusSummaryLine(job);
  if (!view) return null;
  return (
    <p className={focusStyles.focusLine}>
      <span className={focusStyles.label}>Fokus:</span> {view.termsText}
      {view.countText && <> · <strong>{view.countText}</strong></>}
    </p>
  );
}

function ScoreBlock({ score }) {
  return (
    <div className={styles.score}>
      {score.total !== null && (
        <p className={styles.scoreTotal}>
          <span>Skor</span>
          <strong>{formatTenths(score.total)}<small>/10</small></strong>
        </p>
      )}
      {score.rows.length > 0 && (
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
    </div>
  );
}

// The editor entry of a clip (POTONGIN_EDITOR_V3=on): "Edit klip" on every clip that can be
// edited, including one whose job was never prepared (the editor prepares it on open), else the
// reason it cannot be edited (also for a clip the listing does not name); plus the latest export
// of an edited clip.
function EditorEntry({ entry }) {
  if (!entry) return null;
  const latest = entry.latestExport;
  return (
    <>
      {entry.editHref
        ? <a className={`btn ${styles.edit}`} href={entry.editHref}>Edit klip</a>
        : entry.reasonText && <span className={styles.editNote}>{entry.reasonText}</span>}
      {latest?.href && <a className="btn ghost" href={latest.href} download={latest.filename || true}>{latest.label}</a>}
      {latest && !latest.href && <span className={styles.editNote}>{latest.label}</span>}
    </>
  );
}

function CopyButton({ state, label, done, onClick, ghost = false }) {
  return (
    <button type="button" className={`btn ${ghost ? "ghost " : ""}${styles.copy}`} data-state={state || undefined} onClick={onClick}>
      {state === "copied" ? done : state === "failed" ? "Gagal menyalin" : label}
    </button>
  );
}

// One poster of the grid. Outside "Pilih" it shows its clip in the detail panel (the current one
// is marked); in "Pilih" it toggles the clip for the ZIP. Only the current poster is a tab stop:
// the arrows move between posters.
function PosterCard({ clip, entry, selected, picking, picked, onActivate, buttonRef }) {
  const titleId = `poster-${clip.index}-title`;
  const metaId = `poster-${clip.index}-meta`;
  const pill = scorePill(clip);
  const length = formatTimestamp(clip.duration);
  const number = String(clip.index).padStart(2, "0");
  const edited = entry?.editBadge?.tone === "edited";
  const cardNotes = clipFallbackNotes(clip).filter((note) => note.card);
  const meta = [`Klip ${number}`, length, pill && `skor ${pill.text}`, edited && "diedit",
    ...cardNotes.map((note) => note.card.toLowerCase())].filter(Boolean).join(", ");
  return (
    <li>
      <article className={styles.poster} aria-labelledby={titleId} data-selected={(!picking && selected) || undefined} data-picked={(picking && picked) || undefined}>
        <button
          type="button"
          ref={buttonRef}
          className={`${posterFrame} ${styles.posterButton}`}
          data-poster={clip.index}
          tabIndex={selected ? 0 : -1}
          aria-labelledby={titleId}
          aria-describedby={metaId}
          aria-current={!picking && selected ? "true" : undefined}
          aria-pressed={picking ? picked : undefined}
          aria-controls={picking ? undefined : DETAIL_ID}
          onClick={() => onActivate(clip.index)}
        >
          <PosterThumb poster={clipPosterUrl(clip)} number={number} length={length}>
            {picking && <span className={styles.check} aria-hidden="true" />}
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

// The selected clip: the video beside everything needed to post it.
function ClipDetail({ clip, job, entry = null, copied, onCopy, position, onStep, panelRef }) {
  const label = clipLabel(clip);
  const titleId = `clip-${clip.index}-title`;
  const score = clipScoreView(clip);
  const archetype = archetypeLabel(clip.archetype);
  const coldOpen = coldOpenLength(clip);
  const caption = captionParts(clip);
  const reasons = clipReasons(clip);
  const trendChips = clipTrendChips(clip);
  const focusChip = clipFocusChip(clip, job);
  const downloads = clipDownloads(clip);
  const notes = clipFallbackNotes(clip);
  const from = formatTimestamp(clip.sourceStart);
  const to = formatTimestamp(clip.sourceEnd);
  const titleState = copied?.what === "title" ? copied.status : "";
  const captionState = copied?.what === "caption" ? copied.status : "";
  const hasTags = archetype || coldOpen !== null || focusChip || entry?.editBadge?.tone === "edited";

  return (
    <section ref={panelRef} id={DETAIL_ID} className={styles.detail} aria-labelledby={titleId} data-clip-detail={clip.index}>
      <video key={clip.index} className={styles.video} controls preload="metadata" src={clip.videoUrl} poster={clipPosterUrl(clip)} aria-label={`Video ${label}`} />
      <div className={styles.clipBody}>
        <div className={styles.detailBar}>
          <span className={styles.clipNumber}>{label}</span>
          {position && position.total > 1 && (
            <div className={styles.stepper}>
              <button type="button" className={styles.step} aria-label="Klip sebelumnya" aria-disabled={position.first || undefined}
                onClick={() => onStep(-1)}><span aria-hidden="true">‹</span></button>
              <span className={styles.stepCount}>
                <span aria-hidden="true">{position.position}/{position.total}</span>
                <span className="visuallyHidden">Klip {position.position} dari {position.total} yang tampil</span>
              </span>
              <button type="button" className={styles.step} aria-label="Klip berikutnya" aria-disabled={position.last || undefined}
                onClick={() => onStep(1)}><span aria-hidden="true">›</span></button>
            </div>
          )}
        </div>
        {hasTags && (
          <div className={styles.tags}>
            {archetype && <span className="chip">{archetype}</span>}
            {coldOpen !== null && <span className="chip">Dibuka kalimat terkuat · {formatTenths(coldOpen)} dtk</span>}
            {focusChip && <span className={`${focusStyles.chip} ${focusStyles[focusChip.tone]}`} data-focus={focusChip.tone}>{focusChip.label}</span>}
            {entry?.editBadge?.tone === "edited" && <span className="chip info">{entry.editBadge.text}</span>}
          </div>
        )}
        {notes.length > 0 && (
          <ul className={styles.clipNotes} aria-label="Catatan klip">
            {notes.map((note) => <li key={note.code}>{note.text}</li>)}
          </ul>
        )}
        <div className={styles.titleRow}>
          <h3 id={titleId}>{clip.title || label}</h3>
          {clip.title && <CopyButton ghost state={titleState} label="Salin judul" done="Tersalin" onClick={() => onCopy(clip, "title")} />}
        </div>
        {clip.hookText && <p className={styles.hook}><span>Teks hook</span>{clip.hookText}</p>}
        {trendChips.length > 0 && <TrendChips chips={trendChips} />}
        {score && <ScoreBlock score={score} />}

        {reasons.length > 0 && (
          <section className={styles.reasons} aria-labelledby={`${titleId}-reasons`}>
            <h4 id={`${titleId}-reasons`}>Kenapa dipilih</h4>
            <ul>{reasons.map((reason, at) => <li key={`${clip.index}-reason-${at}`}>{reason}</li>)}</ul>
          </section>
        )}

        <section className={styles.caption} aria-labelledby={`${titleId}-caption`}>
          <h4 id={`${titleId}-caption`}>Caption</h4>
          {caption.body && <p className={styles.captionBody}>{caption.body}</p>}
          {caption.hashtags.length > 0 && <p className={styles.hashtags}>{caption.hashtags.map((tag) => <span key={tag}>{tag}</span>)}</p>}
          <CopyButton state={captionState} label="Salin caption" done="Tersalin" onClick={() => onCopy(clip, "caption")} />
        </section>
        <span className="visuallyHidden" role="status" aria-live="polite">
          {copied?.status === "copied" ? `${copied.what === "title" ? "Judul" : "Caption"} tersalin.`
            : copied?.status === "failed" ? "Gagal menyalin. Pilih teksnya, lalu salin manual." : ""}
        </span>

        <div className={styles.actions}>
          <EditorEntry entry={entry} />
          {downloads.mp4 && <a className="btn" href={downloads.mp4} download={downloads.mp4File || true}>Unduh MP4</a>}
          {downloads.srt && <a className="btn ghost" href={downloads.srt} download={downloads.srtFile || true} aria-label={`Unduh subtitle SRT ${label}`}>Subtitle SRT</a>}
          {from && to && <span className={styles.sourceRange}>Di video sumber: {from} sampai {to}</span>}
        </div>
      </div>
    </section>
  );
}

// Starts a same-origin download without leaving the page (the route answers as an attachment).
function saveFile(href, filename) {
  const link = document.createElement("a");
  link.href = href;
  if (filename) link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
}

function ClipsSection({ job, copyState, onCopy, entries, initialClip = null }) {
  const clips = Array.isArray(job.clips) ? job.clips : [];
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState(initialClip);
  const [picking, setPicking] = useState(false);
  const [picks, setPicks] = useState(() => new Set());
  const [zip, setZip] = useState({ state: "idle", message: "" });
  const posterRefs = useRef(new Map());
  const detailRef = useRef(null);
  const pickButton = useRef(null);
  const focusAfter = useRef(null);
  const zipRequest = useRef(null);
  const keyHandler = useRef(null);

  const view = clipFilterView(clips, filter);
  const visible = view.visible;
  const currentIndex = keepSelection(visible, selected);
  const current = visible.find((clip) => clip.index === currentIndex) || null;
  const position = clipPosition(visible, currentIndex);
  const downloadable = job.status === "completed" && clips.length > 0;
  const busy = zip.state === "checking";

  const move = (delta, { focusPoster = false } = {}) => {
    const next = stepSelection(visible, currentIndex, delta);
    if (next === null) return;
    setSelected(next);
    if (focusPoster) posterRefs.current.get(next)?.focus();
  };

  const startPicking = () => {
    setPicking(true);
    setPicks(new Set());
    setZip({ state: "idle", message: "" });
    focusAfter.current = "poster";
  };
  const stopPicking = () => {
    setPicking(false);
    setPicks(new Set());
    focusAfter.current = "pick";
  };

  const changeFilter = (value) => {
    setFilter(value);
    setPicks((previous) => prunePicks(previous, clipFilterView(clips, value).visible));
  };

  const activate = (index) => {
    if (picking) {
      setPicks((previous) => togglePick(previous, index));
      setSelected(index);
      return;
    }
    setSelected(index);
    if (window.matchMedia?.(STACKED).matches) {
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      requestAnimationFrame(() => detailRef.current?.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" }));
    }
  };

  // `indexes` null zips every clip of the project. The route is asked first, so a refusal (too
  // big, a missing file) reads as a message here instead of a failed browser download.
  const download = async (indexes) => {
    if (busy) return;
    zipRequest.current?.abort();
    const controller = new AbortController();
    zipRequest.current = controller;
    setZip({ state: "checking", message: "Menyiapkan ZIP…" });
    let result;
    try {
      result = await checkZip(job.id, indexes, { signal: controller.signal });
    } catch {
      return;
    }
    if (controller.signal.aborted) return;
    if (result.type === "redirect") {
      window.location.assign(result.location);
      return;
    }
    if (result.type === "error") {
      setZip({ state: "error", message: result.message });
      return;
    }
    saveFile(result.href, result.filename);
    setZip({ state: "started", message: `ZIP ${result.count} klip (${formatSize(result.bytes)}) mulai diunduh.` });
    if (indexes) stopPicking();
  };

  keyHandler.current = (event) => {
    if (!visible.length) return;
    if (event.key === "Escape" && picking && !event.defaultPrevented) {
      stopPicking();
      return;
    }
    const delta = arrowDelta(event);
    if (!delta) return;
    event.preventDefault();
    move(delta, { focusPoster: Boolean(event.target?.closest?.("[data-poster]")) });
  };

  useEffect(() => {
    const listener = (event) => keyHandler.current?.(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);

  useEffect(() => () => zipRequest.current?.abort(), []);

  // Opened from the Riwayat clip grid (?klip=N): on the first render only, that clip's poster
  // takes the focus and the clip comes into view.
  useEffect(() => {
    if (initialClip === null || !clips.some((clip) => clip.index === initialClip)) return;
    const stacked = window.matchMedia?.(STACKED).matches;
    const poster = posterRefs.current.get(initialClip);
    poster?.focus({ preventScroll: true });
    (stacked ? detailRef.current : poster)?.scrollIntoView({ block: stacked ? "start" : "center" });
  }, []);

  // The panel scrolls on its own on wide screens: another clip starts at its top.
  useEffect(() => {
    if (detailRef.current) detailRef.current.scrollTop = 0;
  }, [currentIndex]);

  useEffect(() => {
    const target = focusAfter.current;
    focusAfter.current = null;
    if (target === "poster") posterRefs.current.get(currentIndex)?.focus();
    if (target === "pick") pickButton.current?.focus();
  }, [picking, currentIndex]);

  if (!clips.length) {
    if (job.status !== "completed") return null;
    return (
      <section className={styles.empty} aria-labelledby="clips-title">
        <h2 id="clips-title">Tidak ada klip dari video ini</h2>
        <p>Proses selesai, tetapi tidak ada momen yang lolos jadi klip.</p>
        <a className="btn" href="/dashboard">Buat proyek baru</a>
      </section>
    );
  }

  return (
    <section id="klip" className={styles.clips} aria-labelledby="clips-title">
      <div className={styles.clipsHead}>
        <h2 id="clips-title">{job.status === "completed" ? `${clips.length} klip siap diunggah` : `${clips.length} klip`}</h2>
        {downloadable && (picking ? (
          <div className={styles.pickBar} role="group" aria-label="Pilih klip untuk diunduh">
            <span className={styles.pickCount} aria-live="polite">{pickSummary(picks.size)}</span>
            <button type="button" className="btn ghost" onClick={() => setPicks(pickAll(visible))}>Pilih semua</button>
            <button type="button" className="btn ghost" onClick={stopPicking}>Batal</button>
            <button type="button" className="btn primary" disabled={!picks.size} aria-disabled={busy || undefined} onClick={() => download(pickedInOrder(clips, picks))}>
              Unduh ({picks.size})
            </button>
          </div>
        ) : (
          <div className={styles.pickBar}>
            <button type="button" ref={pickButton} className="btn" onClick={startPicking}>Pilih</button>
            <button type="button" className="btn" aria-disabled={busy || undefined} onClick={() => download(null)}>Unduh semua</button>
          </div>
        ))}
      </div>

      {view.showFilters && (
        <div className={styles.filters} role="group" aria-label="Saring klip">
          {view.filters.map((item) => (
            <button key={item.value} type="button" aria-pressed={item.active} onClick={() => changeFilter(item.value)}>
              {item.label} <span className={styles.count}>{item.count}</span>
            </button>
          ))}
        </div>
      )}

      <p className={styles.zipStatus} role="status" aria-live="polite">{zip.state === "error" ? "" : zip.message}</p>
      {zip.state === "error" && <div className={`notice error ${styles.zipError}`} role="alert">{zip.message}</div>}

      {visible.length > 0 ? (
        <div className={styles.workspace}>
          <ul className={styles.posterGrid} aria-label="Daftar klip">
            {visible.map((clip) => (
              <PosterCard key={clip.index} clip={clip} entry={clipEntryFor(entries, job, clip.index)} selected={clip.index === currentIndex}
                picking={picking} picked={picks.has(clip.index)} onActivate={activate}
                buttonRef={(node) => {
                  posterRefs.current.set(clip.index, node);
                  return () => posterRefs.current.delete(clip.index);
                }} />
            ))}
          </ul>
          {current && (
            <ClipDetail clip={current} job={job} entry={clipEntryFor(entries, job, current.index)}
              copied={copyState.index === current.index ? copyState : null} onCopy={onCopy} position={position}
              onStep={(delta) => move(delta)} panelRef={detailRef} />
          )}
        </div>
      ) : (
        <div className={styles.filterEmpty}>
          <p>Belum ada klip dengan skor 8 atau lebih.</p>
          <button type="button" className="btn" onClick={() => changeFilter("all")}>Tampilkan semua klip</button>
        </div>
      )}
    </section>
  );
}

function ProjectView({ job, copyState, onCopy, entries, initialClip }) {
  const active = isActiveStatus(job.status);
  const progress = projectProgress(job);
  const notices = selectionNotices(job);
  const notes = selectionNotes(job);
  const serverError = failureDetail(job);
  const hint = failureHint(job);
  const help = jobHelpHref(job);
  const clipCount = Array.isArray(job.clips) ? job.clips.length : 0;

  return (
    <div className={`shell ${styles.page}`}>
      <a className={styles.back} href="/projects"><span aria-hidden="true">←</span> Riwayat</a>
      <header className={styles.head}>
        <h1>{projectName(job)}</h1>
        <p className={styles.meta}>
          <span className={styles.status} data-status={job.status}>{statusLabel(job.status)}</span>
          <span>{formatProjectDate(job.createdAt)}</span>
          {clipCount > 0 && <span>{clipCount} klip</span>}
          {job.source?.type === "youtube" && job.source.url && (
            <a href={job.source.url} target="_blank" rel="noopener noreferrer">Buka di YouTube<span className="visuallyHidden"> (tab baru)</span></a>
          )}
        </p>
      </header>

      {active && (
        <section className={styles.progressPanel} aria-labelledby="progress-title">
          <div>
            <h2 id="progress-title">{projectStageText(job)}</h2>
            <b>{progress}%</b>
          </div>
          <div className="progress" role="progressbar" aria-labelledby="progress-title" aria-valuemin="0" aria-valuemax="100" aria-valuenow={progress}><i style={{ width: `${progress}%` }} /></div>
          <StageSummary job={job} className={styles.stageSummary} />
          <p>Progres diperbarui otomatis. Klip muncul di sini setelah selesai.</p>
        </section>
      )}

      {job.status === "failed" && (
        <div className={`notice error ${styles.failed}`}>
          <strong>Proses gagal</strong>
          <span>{projectStageText(job)}</span>
          {hint && <span>{hint}</span>}
          {serverError && <span className={styles.errorDetail}>Pesan dari server: {serverError}</span>}
          <span className={styles.noticeLinks}>
            {help && <a className={styles.noticeLink} href={help}>Cara memperbaiki</a>}
            <a className={styles.noticeLink} href="/dashboard">Buat ulang di Buat Klip</a>
          </span>
        </div>
      )}

      {notices.length > 0 && <div className={styles.notices}>{notices.map((notice) => <Notice key={`${notice.tone}:${notice.text}`} notice={notice} />)}</div>}
      {notes.length > 0 && (
        <details className={styles.notes}>
          <summary>Catatan pemilihan ({notes.length})</summary>
          <ul>{notes.map((note, position) => <li key={`${position}:${note}`}>{note}</li>)}</ul>
        </details>
      )}
      <FocusSummary job={job} />
      <ClipsSection job={job} copyState={copyState} onCopy={onCopy} entries={entries} initialClip={initialClip} />
    </div>
  );
}

export default function ProjectPage({ params, searchParams }) {
  const { id } = use(params);
  const initialClip = clipFromParam(use(searchParams ?? NO_SEARCH)?.klip);
  const [job, setJob] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [generation, setGeneration] = useState(0);
  const [copyState, setCopyState] = useState({ index: null, what: null, status: "" });
  const [entries, setEntries] = useState(() => ({ state: "idle", byIndex: new Map() }));
  const copyTimer = useRef(null);
  const editable = job?.status === "completed" && Array.isArray(job?.clips) && job.clips.length > 0;

  useEffect(() => () => {
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let pollTimer = null;
    const load = async (initial) => {
      if (initial) {
        setLoading(true);
        setJob(null);
        setError(null);
      }
      try {
        const result = await loadProjectDetail(id, { signal: controller.signal });
        if (!active) return;
        if (result.type === "redirect") {
          window.location.assign(result.location);
          return;
        }
        setJob(result.job);
        if (isActiveStatus(result.job.status)) pollTimer = setTimeout(() => load(false), POLL_MS);
      } catch (loadError) {
        if (!active || loadError?.name === "AbortError") return;
        // A failed poll keeps the page as it is and tries again; only the first load shows the error.
        if (initial) setError({ message: loadError?.message || "Proyek tidak bisa dimuat.", kind: loadError?.kind || "request" });
        else pollTimer = setTimeout(() => load(false), POLL_MS);
      } finally {
        if (active && initial) setLoading(false);
      }
    };
    load(true);
    return () => {
      active = false;
      controller.abort();
      if (pollTimer !== null) clearTimeout(pollTimer);
    };
  }, [id, generation]);

  useEffect(() => {
    if (job) document.title = `${projectName(job)} · Potongin`;
  }, [job]);

  // The editor entries come from the clips listing, which answers only when the editor is on (a
  // 404 leaves the cards as they are).
  useEffect(() => {
    if (!editable) return undefined;
    const controller = new AbortController();
    let active = true;
    loadClipEntries(id, { signal: controller.signal }).then((result) => {
      if (!active) return;
      if (result.state === "redirect") window.location.assign(result.location);
      else setEntries(result);
    }).catch(() => {});
    return () => {
      active = false;
      controller.abort();
    };
  }, [id, editable, generation]);

  // `what`: "title" copies the title alone, "caption" the whole post text.
  const copyText = async (clip, what) => {
    let status = "copied";
    try {
      await navigator.clipboard.writeText(what === "title" ? clip.title || "" : clipCaptionText(clip));
    } catch {
      status = "failed";
    }
    setCopyState({ index: clip.index, what, status });
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => {
      copyTimer.current = null;
      setCopyState({ index: null, what: null, status: "" });
    }, COPY_RESET_MS);
  };

  return (
    <main>
      <AppHeader current="/projects" />
      {loading && (
        <section className={`shell ${styles.state}`} role="status" aria-live="polite">
          <span className="pulse" aria-hidden="true" />
          <p>Memuat proyek…</p>
        </section>
      )}
      {!loading && error && (
        <section className={`shell ${styles.state}`} role="alert">
          <h1>Proyek tidak bisa dibuka</h1>
          <p>{error.message}</p>
          <div>
            {error.kind !== "not-found" && <button type="button" className="btn primary" onClick={() => setGeneration((value) => value + 1)}>Coba lagi</button>}
            <a className={error.kind === "not-found" ? "btn primary" : "btn"} href="/projects">Kembali ke Riwayat</a>
          </div>
        </section>
      )}
      {!loading && job && <ProjectView job={job} copyState={copyState} onCopy={copyText} entries={entries} initialClip={initialClip} />}
    </main>
  );
}
