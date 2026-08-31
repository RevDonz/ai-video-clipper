"use client";

import { use, useEffect, useRef, useState } from "react";

import {
  CONTRIBUTION_LABELS,
  FEATURE_LABELS,
  MEDIA_LABELS,
  buildFeedbackView,
  classifyFeedbackSaveFailure,
  createFeedbackSaveAttempt,
  formatDuration,
  formatScore,
  loadProjectDetail,
  profileLabel,
  validateFeedbackPayload,
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

function FeedbackEditor({ candidate, jobId, latest, enabled, disabledReason, onSaved, onReloadRequired }) {
  const [decision, setDecision] = useState(latest?.decision || "");
  const [note, setNote] = useState(latest?.note || "");
  const [savedDecision, setSavedDecision] = useState(latest?.decision || "");
  const [savedNote, setSavedNote] = useState(latest?.note || "");
  const [saveState, setSaveState] = useState({ status: "idle", message: "" });
  const pendingAttempt = useRef(null);
  const requestController = useRef(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestController.current?.abort();
    };
  }, []);

  const chooseDecision = (value) => {
    setDecision(value);
    if (saveState.status !== "saving") setSaveState({ status: "idle", message: "" });
  };
  const changeNote = (value) => {
    setNote(value);
    if (saveState.status !== "saving") setSaveState({ status: "idle", message: "" });
  };
  const dirty = decision !== savedDecision || note !== savedNote;

  const save = async () => {
    const attempt = createFeedbackSaveAttempt(
      pendingAttempt.current,
      { candidateId: candidate.id, decision, note },
      () => crypto.randomUUID(),
    );
    // Validate the raw note so trimming can never hide a control character.
    const validation = validateFeedbackPayload({ ...attempt, note });
    if (!validation.valid) {
      setSaveState({ status: "error", message: validation.error });
      return;
    }

    pendingAttempt.current = attempt;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setSaveState({ status: "saving", message: "Menyimpan feedback…" });
    try {
      const response = await fetch(`/api/jobs/${jobId}/candidate-feedback`, {
        method: "PUT",
        cache: "no-store",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(attempt),
      });
      let payload = {};
      try {
        payload = await response.json();
      } catch {
        payload = {};
      }
      if (!mounted.current) return;
      if (response.status === 401) {
        window.location.assign(`/login?next=${encodeURIComponent(`/projects/${jobId}`)}`);
        return;
      }
      if (!response.ok) {
        const failure = classifyFeedbackSaveFailure(response.status, payload);
        pendingAttempt.current = failure.retryable ? { ...attempt, retryable: true } : null;
        setSaveState(failure);
        if (failure.reloadRequired) onReloadRequired(failure.message);
        return;
      }

      const next = buildFeedbackView(payload);
      const saved = next.latestByCandidate[candidate.id];
      if (!next.available || !saved) throw new Error("Respons feedback tidak valid.");
      pendingAttempt.current = null;
      setDecision(saved.decision);
      setNote(saved.note);
      setSavedDecision(saved.decision);
      setSavedNote(saved.note);
      onSaved(next);
      setSaveState({ status: "success", message: "Feedback tersimpan secara durabel untuk evaluasi/kalibrasi mendatang." });
    } catch (error) {
      if (!mounted.current || error?.name === "AbortError") return;
      pendingAttempt.current = { ...attempt, retryable: true };
      setSaveState({ status: "error", message: "Jaringan terputus; feedback belum dipastikan tersimpan. Coba lagi dengan ID permintaan yang sama." });
    }
  };

  const noteLength = Array.from(note).length;
  const reloadRequired = saveState.reloadRequired === true;
  const disabled = !enabled || reloadRequired || saveState.status === "saving";
  return (
    <section className="feedbackEditor" aria-labelledby={`feedback-title-${candidate.id}`}>
      <div className="feedbackHeading">
        <div><h4 id={`feedback-title-${candidate.id}`}>Feedback kandidat</h4><p>Feedback tersimpan untuk evaluasi/kalibrasi mendatang; ini tidak mengaktifkan pelatihan otomatis.</p></div>
        {latest?.createdAt && <span>Terakhir tersimpan {formatDate(latest.createdAt)}</span>}
      </div>
      <fieldset disabled={disabled}>
        <legend>Keputusan untuk kandidat ini</legend>
        <div className="decisionSegments">
          {[["accepted", "Accept"], ["rejected", "Tolak"], ["undecided", "Belum diputuskan"]].map(([value, label]) => (
            <label key={value} className={decision === value ? "selected" : ""}>
              <input type="radio" name={`decision-${candidate.id}`} value={value} checked={decision === value} onChange={() => chooseDecision(value)} />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="feedbackNote" htmlFor={`feedback-note-${candidate.id}`}>
        <span>Catatan opsional</span>
        <textarea id={`feedback-note-${candidate.id}`} aria-describedby={`feedback-note-help-${candidate.id}`} value={note} disabled={disabled} onChange={(event) => changeNote(event.target.value)} placeholder="Tambahkan alasan singkat (opsional)" />
        <small id={`feedback-note-help-${candidate.id}`} className={noteLength > 500 ? "over" : ""}>{noteLength}/500 karakter Unicode. Baris baru dan karakter kontrol tidak didukung.</small>
      </label>
      {(!enabled || reloadRequired) && <p className="feedbackDisabled" role="status">{reloadRequired ? saveState.message : disabledReason}</p>}
      <div className="feedbackActions">
        <button type="button" onClick={save} disabled={disabled || !dirty || !decision}>{saveState.status === "saving" ? "Menyimpan…" : "Simpan feedback"}</button>
        <span className={`feedbackStatus ${saveState.status}`} role={saveState.status === "error" || reloadRequired ? "alert" : "status"} aria-live="polite">{saveState.message || (dirty ? "Perubahan belum disimpan." : "Tidak ada perubahan yang belum disimpan.")}</span>
      </div>
      {reloadRequired && <button className="feedbackReload" type="button" onClick={() => window.location.reload()}>Muat ulang halaman</button>}
    </section>
  );
}

function CandidateCard({ candidate, jobId, latestFeedback, feedbackEnabled, feedbackDisabledReason, onFeedbackSaved, onFeedbackReloadRequired }) {
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
      <p className="boundaryNote">Batas kandidat tetap mengikuti segmen transkrip utuh dan tidak dapat di-trim di editor.</p>
      <a className="openEditorLink" href={`/projects/${encodeURIComponent(jobId)}/candidates/${encodeURIComponent(candidate.id)}/edit`}>Buka editor <span aria-hidden="true">→</span></a>

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

      <FeedbackEditor
        candidate={candidate}
        jobId={jobId}
        latest={latestFeedback}
        enabled={feedbackEnabled}
        disabledReason={feedbackDisabledReason}
        onSaved={onFeedbackSaved}
        onReloadRequired={onFeedbackReloadRequired}
      />
    </article>
  );
}

export default function ProjectDetailPage({ params }) {
  const { id } = use(params);
  const [job, setJob] = useState(null);
  const [candidateView, setCandidateView] = useState({ available: false, selectionVersion: "", candidates: [] });
  const [feedbackView, setFeedbackView] = useState({ available: false, selectionVersion: "", eventCount: 0, latestByCandidate: {} });
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState("");
  const [candidateNotice, setCandidateNotice] = useState("");
  const [feedbackNotice, setFeedbackNotice] = useState("");
  const [feedbackReloadRequired, setFeedbackReloadRequired] = useState("");
  const [reloadGeneration, setReloadGeneration] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setJob(null);
    setCandidateView({ available: false, selectionVersion: "", candidates: [] });
    setFeedbackView({ available: false, selectionVersion: "", eventCount: 0, latestByCandidate: {} });
    setPageError("");
    setCandidateNotice("");
    setFeedbackNotice("");
    setFeedbackReloadRequired("");
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
        setFeedbackView(result.feedbackView);
        setFeedbackNotice(result.feedbackNotice);
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
  const selectionVersionMatches = feedbackView.available
    && !!candidateView.selectionVersion
    && feedbackView.selectionVersion === candidateView.selectionVersion;
  const feedbackDisabledReason = feedbackReloadRequired || feedbackNotice
    || (!feedbackView.available
      ? "Penyimpanan feedback belum tersedia untuk proyek ini."
      : "Versi pilihan kandidat berubah. Muat ulang halaman agar feedback tidak diterapkan ke versi yang salah.");

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
            <header><div><div className="eyebrow">SELECTION V2 · SHADOW OUTPUT</div><h2 id="candidate-title">Kandidat potongan</h2><p>Analisis tetap read-only; keputusan dan catatan di bawah hanya disimpan sebagai feedback evaluasi. Kandidat belum dirender atau diaktifkan untuk produksi.</p></div>{candidates.length > 0 && <strong>{candidates.length} kandidat · {feedbackView.eventCount} event feedback</strong>}</header>
            {feedbackNotice && <div className="feedbackPanelWarning" role="status" aria-live="polite"><strong>Feedback sementara tidak tersedia.</strong><span>{feedbackNotice}</span></div>}
            {feedbackReloadRequired && <div className="feedbackPanelWarning" role="alert"><strong>Feedback dikunci sampai halaman dimuat ulang.</strong><span>{feedbackReloadRequired}</span><button className="feedbackReload" type="button" onClick={() => window.location.reload()}>Muat ulang halaman</button></div>}
            {feedbackView.available && !selectionVersionMatches && <div className="feedbackPanelWarning" role="alert"><strong>Versi kandidat tidak cocok.</strong><span>{feedbackDisabledReason}</span></div>}
            {candidateView.available && candidates.length > 0 ? <div className="candidateList">{candidates.map((candidate) => (
              <CandidateCard
                key={candidate.id}
                candidate={candidate}
                jobId={id}
                latestFeedback={feedbackView.latestByCandidate[candidate.id]}
                feedbackEnabled={selectionVersionMatches && !feedbackReloadRequired}
                feedbackDisabledReason={feedbackDisabledReason}
                onFeedbackSaved={setFeedbackView}
                onFeedbackReloadRequired={setFeedbackReloadRequired}
              />
            ))}</div> : (
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
