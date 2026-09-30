"use client";

import { use, useEffect, useRef, useState } from "react";

import AppHeader from "../../../components/AppHeader.jsx";
import TrendChips from "../../../components/trends/TrendChips.jsx";
import {
  clipLabel,
  formatProjectDate,
  isActiveStatus,
  loadProjectDetail,
  projectName,
  projectProgress,
  statusLabel,
} from "../../../lib/project-view.mjs";
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
  selectionNotices,
} from "../../../lib/selection-v3-view.mjs";
import focusStyles from "./focus.module.css";
import styles from "./project.module.css";

// A running job is re-read on this interval until it finishes.
const POLL_MS = 5000;
const COPY_RESET_MS = 2200;

function Notice({ notice }) {
  return (
    <div className={`notice ${notice.tone}`}>
      {notice.title && <strong>{notice.title}</strong>}
      <span>{notice.text}</span>
      {notice.href && <a className={styles.noticeLink} href={notice.href}>{notice.action}</a>}
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

function ClipCard({ clip, job, copied, onCopy }) {
  const label = clipLabel(clip);
  const titleId = `clip-${clip.index}-title`;
  const score = clipScoreView(clip);
  const archetype = archetypeLabel(clip.archetype);
  const coldOpen = coldOpenLength(clip);
  const caption = captionParts(clip);
  const reasons = clipReasons(clip);
  const trendChips = clipTrendChips(clip);
  const focusChip = clipFocusChip(clip, job);
  const from = formatTimestamp(clip.sourceStart);
  const to = formatTimestamp(clip.sourceEnd);

  return (
    <article className={styles.clip} aria-labelledby={titleId}>
      <video className={styles.video} controls preload="metadata" src={clip.videoUrl} poster={clipPosterUrl(clip)} aria-label={`Video ${label}`} />
      <div className={styles.clipBody}>
        <div className={styles.tags}>
          <span className={styles.clipNumber}>{label}</span>
          {archetype && <span className="chip">{archetype}</span>}
          {coldOpen !== null && <span className="chip">Dibuka kalimat terkuat · {formatTenths(coldOpen)} dtk</span>}
          {focusChip && <span className={`${focusStyles.chip} ${focusStyles[focusChip.tone]}`} data-focus={focusChip.tone}>{focusChip.label}</span>}
        </div>
        <h3 id={titleId}>{clip.title || label}</h3>
        {clip.hookText && <p className={styles.hook}><span>Teks hook</span>{clip.hookText}</p>}
        {trendChips.length > 0 && <TrendChips chips={trendChips} />}
        {score && <ScoreBlock score={score} />}

        {reasons.length > 0 && (
          <section className={styles.reasons} aria-labelledby={`${titleId}-reasons`}>
            <h4 id={`${titleId}-reasons`}>Kenapa dipilih</h4>
            <ul>{reasons.map((reason, position) => <li key={`${clip.index}-reason-${position}`}>{reason}</li>)}</ul>
          </section>
        )}

        <section className={styles.caption} aria-labelledby={`${titleId}-caption`}>
          <h4 id={`${titleId}-caption`}>Caption</h4>
          {caption.body && <p className={styles.captionBody}>{caption.body}</p>}
          {caption.hashtags.length > 0 && <p className={styles.hashtags}>{caption.hashtags.map((tag) => <span key={tag}>{tag}</span>)}</p>}
          <button type="button" className={`btn ${styles.copy}`} data-state={copied || undefined} onClick={() => onCopy(clip)}>
            {copied === "copied" ? "Tersalin" : copied === "failed" ? "Gagal menyalin" : "Salin caption"}
          </button>
          <span className="visuallyHidden" role="status" aria-live="polite">
            {copied === "copied" ? "Caption tersalin." : copied === "failed" ? "Caption gagal disalin. Pilih teksnya, lalu salin manual." : ""}
          </span>
        </section>

        <div className={styles.actions}>
          <a className="btn" href={clip.downloadUrl}>Unduh MP4</a>
          {clip.subtitleUrl && <a className="btn ghost" href={clip.subtitleUrl} aria-label={`Unduh subtitle SRT ${label}`}>Subtitle SRT</a>}
          {from && to && <span className={styles.sourceRange}>Di video sumber: {from} sampai {to}</span>}
        </div>
      </div>
    </article>
  );
}

function ClipsSection({ job, copyState, onCopy }) {
  const clips = Array.isArray(job.clips) ? job.clips : [];
  if (clips.length) {
    return (
      <section className={styles.clips} aria-labelledby="clips-title">
        <h2 id="clips-title">{job.status === "completed" ? `${clips.length} klip siap diunggah` : `${clips.length} klip`}</h2>
        <div className={styles.clipList}>
          {clips.map((clip) => <ClipCard key={clip.index} clip={clip} job={job} copied={copyState.index === clip.index ? copyState.status : ""} onCopy={onCopy} />)}
        </div>
      </section>
    );
  }
  if (job.status !== "completed") return null;
  return (
    <section className={styles.empty} aria-labelledby="clips-title">
      <h2 id="clips-title">Tidak ada klip dari video ini</h2>
      <p>Proses selesai, tetapi tidak ada momen yang lolos jadi klip.</p>
      <a className="btn" href="/dashboard">Buat proyek baru</a>
    </section>
  );
}

function ProjectView({ job, copyState, onCopy }) {
  const active = isActiveStatus(job.status);
  const progress = projectProgress(job);
  const notices = selectionNotices(job);
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
            <h2 id="progress-title">{job.stageDetail || "Sedang diproses"}</h2>
            <b>{progress}%</b>
          </div>
          <div className="progress" role="progressbar" aria-labelledby="progress-title" aria-valuemin="0" aria-valuemax="100" aria-valuenow={progress}><i style={{ width: `${progress}%` }} /></div>
          <p>Progres diperbarui otomatis. Klip muncul di sini setelah selesai.</p>
        </section>
      )}

      {job.status === "failed" && (
        <div className={`notice error ${styles.failed}`}>
          <strong>Proses gagal</strong>
          <span>{job.stageDetail || "Proyek ini berhenti sebelum klip selesai."}</span>
          <a className={styles.noticeLink} href="/dashboard">Buat ulang di Buat Klip</a>
        </div>
      )}

      {notices.length > 0 && <div className={styles.notices}>{notices.map((notice) => <Notice key={`${notice.tone}:${notice.text}`} notice={notice} />)}</div>}
      <FocusSummary job={job} />
      <ClipsSection job={job} copyState={copyState} onCopy={onCopy} />
    </div>
  );
}

export default function ProjectPage({ params }) {
  const { id } = use(params);
  const [job, setJob] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [generation, setGeneration] = useState(0);
  const [copyState, setCopyState] = useState({ index: null, status: "" });
  const copyTimer = useRef(null);

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

  const copyCaption = async (clip) => {
    let status = "copied";
    try {
      await navigator.clipboard.writeText(clipCaptionText(clip));
    } catch {
      status = "failed";
    }
    setCopyState({ index: clip.index, status });
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => {
      copyTimer.current = null;
      setCopyState({ index: null, status: "" });
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
      {!loading && job && <ProjectView job={job} copyState={copyState} onCopy={copyCaption} />}
    </main>
  );
}
