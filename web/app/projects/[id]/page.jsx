"use client";

import { use, useEffect, useState } from "react";

import {
  CONTRIBUTION_LABELS,
  FEATURE_LABELS,
  MEDIA_LABELS,
  formatDuration,
  formatScore,
  loadProjectDetail,
  profileLabel,
} from "../../../lib/candidate-view.mjs";

const STATUS_LABELS = {
  queued: "Menunggu",
  preparing: "Menyiapkan",
  downloading: "Mengunduh",
  processing: "Diproses",
  completed: "Selesai",
  failed: "Gagal",
};

function safePercent(value) {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

function projectName(job) {
  if (job?.source?.name) return job.source.name;
  if (job?.source?.type === "youtube") return "Video YouTube";
  return job?.id ? `Proyek ${job.id.slice(0, 8)}` : "Detail proyek";
}

function formatDate(value) {
  if (!value) return "Tanggal tidak tersedia";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Tanggal tidak tersedia";
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function CandidateCard({ candidate }) {
  const score = safePercent(candidate.score * 10);
  const features = Object.entries(candidate.features || {});
  const contributions = candidate.scoreBreakdown?.contributions || [];
  const measurements = Object.entries(candidate.measuredMedia?.measurements || {})
    .filter(([, value]) => value !== null && Number.isFinite(value));

  return (
    <article className="candidateCard" aria-labelledby={`candidate-${candidate.id}`}>
      <header className="candidateHead">
        <div className="candidateRank"><span>Peringkat</span><strong>#{candidate.rank}</strong></div>
        <div className="candidateTitle">
          <div><span className="profileBadge">{profileLabel(candidate.profile)}</span><span>Urutan tampil {candidate.displayOrder}</span></div>
          <h3 id={`candidate-${candidate.id}`}>{candidate.text}</h3>
        </div>
        <div className="candidateScore">
          <span>Clip Potential Score</span><strong>{formatScore(candidate.score)}<small>/10</small></strong>
          <div className="scoreMeter" role="progressbar" aria-label={`Clip Potential Score ${formatScore(candidate.score)} dari 10`} aria-valuemin="0" aria-valuemax="10" aria-valuenow={candidate.score}>
            <i style={{ width: `${score}%` }} />
          </div>
        </div>
      </header>

      <div className="candidateTiming" aria-label="Batas waktu kandidat">
        <span><small>Mulai</small>{formatDuration(candidate.start)}</span>
        <i aria-hidden="true">→</i>
        <span><small>Selesai</small>{formatDuration(candidate.end)}</span>
        <span><small>Durasi</small>{formatDuration(candidate.duration)}</span>
      </div>
      <p className="boundaryNote">Preview menggunakan kutipan transkrip dan batas waktu. Video kandidat belum ditampilkan karena kontrak media/manifest edit belum tersedia.</p>

      {!!candidate.topicTerms?.length && <div className="topicTerms" aria-label="Istilah topik">{candidate.topicTerms.map((term) => <span key={term}>{term}</span>)}</div>}

      <div className="candidateColumns">
        <section aria-labelledby={`reason-${candidate.id}`}>
          <h4 id={`reason-${candidate.id}`}>Alasan pemilihan</h4>
          {candidate.reasons?.length ? <ul>{candidate.reasons.map((reason, index) => <li key={`${candidate.id}-reason-${index}`}>{reason}</li>)}</ul> : <p>Alasan tidak tersedia.</p>}
        </section>
        <section aria-labelledby={`feature-${candidate.id}`}>
          <h4 id={`feature-${candidate.id}`}>Fitur penilaian</h4>
          <dl className="featureGrid">{features.map(([name, value]) => <div key={name}><dt>{FEATURE_LABELS[name] || name}</dt><dd>{formatScore(value)}</dd></div>)}</dl>
        </section>
      </div>

      {measurements.length > 0 && (
        <section className="mediaSignals" aria-labelledby={`media-${candidate.id}`}>
          <h4 id={`media-${candidate.id}`}>Sinyal media terukur</h4>
          <p>Audio dan visual di bawah adalah sinyal aktivitas hasil pengukuran, bukan klaim emosi, identitas pembicara, atau active-speaker.</p>
          <dl>{measurements.map(([name, value]) => <div key={name}><dt>{MEDIA_LABELS[name] || name}</dt><dd>{formatScore(value)}</dd></div>)}</dl>
        </section>
      )}

      <details className="scoreDetails">
        <summary>Lihat rincian skor</summary>
        <div className="breakdownSummary">
          <span>Pra-penalti <b>{formatScore(candidate.scoreBreakdown?.weightedPrePenaltyScore)}</b></span>
          <span>Penalti <b>−{formatScore(candidate.scoreBreakdown?.penaltyDeduction)}</b></span>
          <span>Diversitas <b>−{formatScore(candidate.scoreBreakdown?.diversityDeduction)}</b></span>
          <span>Skor akhir <b>{formatScore(candidate.scoreBreakdown?.finalScore)}</b></span>
        </div>
        {!!contributions.length && <div className="contributions" role="list">{contributions.map((item) => <div role="listitem" key={item.name}><span>{CONTRIBUTION_LABELS[item.name] || item.name}<small>{item.source === "media" ? "sinyal media" : "sinyal teks"}</small></span><b>{formatScore(item.weightedValue)}</b></div>)}</div>}
      </details>
    </article>
  );
}

export default function ProjectDetailPage({ params }) {
  const { id } = use(params);
  const [job, setJob] = useState(null);
  const [candidateView, setCandidateView] = useState({ available: false, candidates: [] });
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState("");
  const [candidateNotice, setCandidateNotice] = useState("");
  const [reloadGeneration, setReloadGeneration] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setJob(null);
    setCandidateView({ available: false, candidates: [] });
    setPageError("");
    setCandidateNotice("");
    (async () => {
      try {
        const result = await loadProjectDetail(id, { signal: controller.signal });
        if (!active) return;
        if (result.type === "redirect") {
          window.location.assign(result.location);
          return;
        }
        setJob(result.job);
        setCandidateView(result.candidateView);
        setCandidateNotice(result.candidateNotice);
      } catch (error) {
        if (!active || error?.name === "AbortError") return;
        setPageError(error instanceof Error ? error.message : "Terjadi gangguan jaringan saat memuat proyek.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [id, reloadGeneration]);

  const clips = job?.clips || [];
  const progress = safePercent(job?.progress);
  const candidates = candidateView.candidates;

  return (
    <main>
      <nav className="nav shell">
        <a className="brand" href="/"><span>P</span> Potongin AI</a>
        <div className="navActions"><div className="navLinks"><a href="/dashboard">Buat Klip</a><a className="active" href="/projects">Riwayat</a></div><form method="post" action="/api/auth/logout"><button type="submit">Keluar</button></form></div>
      </nav>

      {loading && <section className="detailState shell" role="status" aria-live="polite"><div className="pulse" /><h1>Memuat detail proyek…</h1><p>Ringkasan job dan kandidat V2 sedang diambil.</p></section>}

      {!loading && pageError && <section className="detailState detailError shell" role="alert"><div className="emptyIcon">!</div><h1>Detail proyek tidak tersedia</h1><p>{pageError}</p><div><button type="button" onClick={() => setReloadGeneration((value) => value + 1)}>Coba lagi</button><a href="/projects">Kembali ke riwayat</a></div></section>}

      {!loading && job && (
        <>
          <header className="detailHero shell">
            <a className="backLink" href="/projects">← Kembali ke riwayat</a>
            <div className="eyebrow">DETAIL PROYEK · READ-ONLY</div>
            <div className="detailHeroRow"><div><h1>{projectName(job)}</h1><p>ID {job.id} · dibuat {formatDate(job.createdAt)}</p></div><span className={`statusPill ${job.status}`}>{STATUS_LABELS[job.status] || job.status}</span></div>
          </header>

          <section className="jobOverview shell" aria-labelledby="job-summary-title">
            <div className="jobSummaryCard">
              <div><span>JOB</span><h2 id="job-summary-title">Ringkasan pemrosesan</h2></div>
              <dl><div><dt>Status</dt><dd>{STATUS_LABELS[job.status] || job.status}</dd></div><div><dt>Mode render</dt><dd>{job.options?.renderMode || "—"}</dd></div><div><dt>Klip lama</dt><dd>{clips.length}</dd></div><div><dt>Diperbarui</dt><dd>{formatDate(job.updatedAt)}</dd></div></dl>
              <div className="progress" role="progressbar" aria-label="Progres pemrosesan proyek" aria-valuemin="0" aria-valuemax="100" aria-valuenow={progress}><i style={{ width: `${progress}%` }} /></div>
              <p>{job.stageDetail || `Progres ${progress}%`}</p>
              {job.error && <div className="projectError" role="alert">{job.error}</div>}
              {job.source?.type === "youtube" && job.source.url && <a className="sourceLink" href={job.source.url} target="_blank" rel="noreferrer">Buka sumber YouTube ↗</a>}
            </div>
          </section>

          <section className="candidatePanel shell" aria-labelledby="candidate-title">
            <header><div><div className="eyebrow">SELECTION V2 · SHADOW OUTPUT</div><h2 id="candidate-title">Kandidat potongan</h2><p>Analisis read-only untuk membantu meninjau batas transkrip. Kandidat ini belum diterima, dirender, atau diaktifkan untuk produksi.</p></div>{candidates.length > 0 && <strong>{candidates.length} kandidat</strong>}</header>
            {candidateView.available && candidates.length > 0 ? <div className="candidateList">{candidates.map((candidate) => <CandidateCard key={candidate.id} candidate={candidate} />)}</div> : (
              <div className="candidateEmpty">
                <div className="emptyIcon">◇</div><h3>Kandidat V2 belum tersedia</h3>
                <p>{candidateNotice || "V2 shadow mungkin belum dijalankan untuk job lama, atau artifact analisis belum tersedia."}</p>
                <p>Klip hasil job lama tetap dapat diputar dan diunduh di bagian “Klip yang sudah dirender” di bawah.</p>
              </div>
            )}
          </section>

          <section className="legacySection shell" aria-labelledby="legacy-title">
            <header><div className="eyebrow">HASIL JOB LAMA</div><h2 id="legacy-title">Klip yang sudah dirender</h2><p>Hasil lama tetap tersedia terlepas dari ketersediaan kandidat V2.</p></header>
            {clips.length ? <div className="archiveClips">{clips.map((clip) => <article className="archiveClip" key={clip.index}><video controls preload="metadata" src={clip.videoUrl} /><div><small>CLIP {String(clip.index).padStart(2, "0")} · {Math.round(clip.duration || 0)} DETIK</small><h3>{clip.title}</h3><p className="socialDescription">{clip.description}</p>{clip.subtitleUrl && <p className="subtitleNote">Subtitle SRT tersedia sebagai file unduhan dan tidak dimuat sebagai track browser.</p>}<div className="archiveActions"><a href={clip.downloadUrl}>Download MP4 ↓</a>{clip.subtitleUrl && <a href={clip.subtitleUrl}>Subtitle SRT ↓</a>}</div></div></article>)}</div> : <div className="noClips"><strong>{job.status === "failed" ? "Proses ini gagal" : "Klip belum tersedia"}</strong><p>{STATUS_LABELS[job.status] || job.status} · progres {progress}%</p></div>}
          </section>
        </>
      )}
      <footer className="shell">Potongin AI · Peninjau kandidat read-only <span>Selection V2 shadow</span></footer>
    </main>
  );
}
