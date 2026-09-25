"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  createStorageStatusRecovery,
  recoverFailedJobSelection,
  storageStatusView,
} from "../../lib/dashboard-storage-status.mjs";
import { clipCaptionText, clipPosterUrl, llmStatusView, selectionSourceLabel } from "../../lib/selection-v3-view.mjs";

const layouts = [
  {
    id: "fit-blur",
    name: "Full Frame + Blur",
    badge: "Aman",
    description: "Video landscape tetap utuh; area portrait diisi latar blur.",
  },
  {
    id: "face-track",
    name: "Follow Speaker",
    badge: "AI",
    description: "Layar 9:16 penuh dengan crop yang mengikuti wajah terbesar.",
  },
  {
    id: "center-crop",
    name: "Center Crop",
    badge: "Cepat",
    description: "Crop tengah sederhana untuk video dengan subjek selalu di pusat.",
  },
];

const legacyModes = [
  {
    id: "v1",
    name: "Klasik V1",
    description: "Pemilih kata kunci lama. Klip dirender tanpa teks hook, cold open, atau judul AI.",
  },
  {
    id: "v2-shadow",
    name: "V2 shadow",
    description: "V1 tetap merender klip; V2 hanya membuat kandidat pembanding untuk ditinjau di detail proyek.",
  },
];

const LLM_STATUS_UNREADABLE = { state: "invalid", label: "Status LLM tidak dapat dibaca — job tetap jalan, dengan heuristik bila perlu" };

const statusLabel = {
  queued: "Menunggu worker",
  preparing: "Menyiapkan video",
  downloading: "Mengunduh YouTube",
  processing: "Transkripsi dan render",
  completed: "Selesai",
  failed: "Gagal",
};

const stageLabel = {
  analyzing: "Menganalisis video",
  transcribing: "Membuat transkrip",
  selecting: "Memilih highlight",
  candidates_generating: "Membuat kandidat V2",
  features: "Mengukur fitur kandidat V2",
  ranking: "Menyusun shortlist V2",
  media: "Menganalisis media kandidat V2",
  candidates_ready: "Kandidat bayangan V2 siap",
  captions: "Mengambil subtitle YouTube",
  audio: "Menganalisis audio",
  llm: "AI memilih momen",
  packaging: "Menyiapkan judul dan hook",
  rendering: "Merender klip",
  finalizing: "Menyelesaikan hasil",
  completed: "Selesai",
  failed: "Gagal",
};

const storageMessages = {
  storage_quota_exhausted: "Penyimpanan server tidak cukup untuk job baru.",
  storage_free_space_low: "Ruang kosong penyimpanan server terlalu rendah.",
  storage_admission_unavailable: "Status penyimpanan server tidak dapat diverifikasi. Coba lagi nanti.",
};

function LlmBadge({ status, llmMode }) {
  const view = llmStatusView(status, llmMode);
  return (
    <p className={`llmBadge ${view.tone}`} role="status" aria-live="polite">
      <i aria-hidden="true" />
      <span>{view.label}</span>
    </p>
  );
}

export default function DashboardPage() {
  const [sourceType, setSourceType] = useState("youtube");
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [video, setVideo] = useState(null);
  const [renderMode, setRenderMode] = useState("fit-blur");
  const [limit, setLimit] = useState(3);
  const [minDuration, setMinDuration] = useState(20);
  const [maxDuration, setMaxDuration] = useState(60);
  const [selectionMode, setSelectionMode] = useState("v3");
  const [llmMode, setLlmMode] = useState("auto");
  const [coldOpen, setColdOpen] = useState(true);
  const [hookOverlay, setHookOverlay] = useState(true);
  const [captionStyle, setCaptionStyle] = useState("karaoke");
  const [clipProfile, setClipProfile] = useState("standard");
  const [llmStatus, setLlmStatus] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [copiedClip, setCopiedClip] = useState(null);
  const [storageView, setStorageView] = useState(() => storageStatusView(null));
  const storageRecovery = useRef(null);
  const copiedTimer = useRef(null);
  const mounted = useRef(false);
  const jobsRefreshGeneration = useRef(0);

  const activeJob = useMemo(() => jobs.find((job) => job.id === activeId), [jobs, activeId]);
  const storageBlocked = storageView.submitBlocked;

  async function refreshJobs(selectedId = null, signal = undefined) {
    jobsRefreshGeneration.current += 1;
    const generation = jobsRefreshGeneration.current;
    const response = await fetch("/api/jobs", { cache: "no-store", signal });
    if (!response.ok || signal?.aborted || generation !== jobsRefreshGeneration.current) return;
    const payload = await response.json();
    if (signal?.aborted || generation !== jobsRefreshGeneration.current) return;
    setJobs(payload.jobs || []);
    setActiveId((current) => selectedId || current || payload.jobs?.[0]?.id || null);
  }

  async function refreshStorageStatus() {
    await storageRecovery.current?.retry();
  }

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void refreshJobs(null, controller.signal).catch(() => {});
    void (async () => {
      // The badge is informative only; the worker decides at run time.
      let next = LLM_STATUS_UNREADABLE;
      try {
        const response = await fetch("/api/llm/status", { cache: "no-store", signal: controller.signal });
        const payload = await response.json();
        if (payload?.llm && typeof payload.llm.label === "string") next = payload.llm;
      } catch {
        // Fall through to the "unreadable" badge unless the page is gone.
      }
      if (!controller.signal.aborted) setLlmStatus(next);
    })();
    const recovery = createStorageStatusRecovery({ fetchImpl: fetch, onChange: setStorageView });
    storageRecovery.current = recovery;
    void recovery.start();
    return () => {
      mounted.current = false;
      jobsRefreshGeneration.current += 1;
      controller.abort();
      storageRecovery.current = null;
      recovery.dispose();
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
      copiedTimer.current = null;
    };
  }, []);

  useEffect(() => {
    if (!activeId || ["completed", "failed"].includes(activeJob?.status)) return undefined;
    const controller = new AbortController();
    let requestInFlight = false;
    const timer = setInterval(async () => {
      if (requestInFlight) return;
      requestInFlight = true;
      try {
        const response = await fetch(`/api/jobs/${activeId}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok || controller.signal.aborted) return;
        const payload = await response.json();
        if (controller.signal.aborted) return;
        setJobs((current) => {
          const exists = current.some((job) => job.id === activeId);
          return exists
            ? current.map((job) => (job.id === activeId ? payload.job : job))
            : [payload.job, ...current];
        });
      } catch {
        // Transient polling failures are retried on the next interval.
      } finally {
        requestInFlight = false;
      }
    }, 2500);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [activeId, activeJob?.status]);

  async function submit(event) {
    event.preventDefault();
    setMessage("");
    setSubmitting(true);
    try {
      const data = new FormData();
      data.set("renderMode", renderMode);
      data.set("limit", String(limit));
      data.set("minDuration", String(minDuration));
      data.set("maxDuration", String(maxDuration));
      data.set("selectionMode", selectionMode);
      if (selectionMode === "v3") {
        data.set("llmMode", llmMode);
        data.set("coldOpen", String(coldOpen));
        data.set("hookOverlay", String(hookOverlay));
        data.set("captionStyle", captionStyle);
      } else if (selectionMode === "v2-shadow") {
        data.set("clipProfile", clipProfile);
      }
      if (sourceType === "youtube") data.set("youtubeUrl", youtubeUrl);
      else if (video) data.set("video", video);
      const response = await fetch("/api/jobs", { method: "POST", body: data });
      const payload = await response.json();
      if (!response.ok) {
        if (payload.jobId) {
          await recoverFailedJobSelection(payload.jobId, {
            select: setActiveId,
            refreshJobs,
          });
        }
        if ([507, 503].includes(response.status)) await refreshStorageStatus();
        setMessage(storageMessages[payload.code] || "Gagal membuat job");
        return;
      }
      setJobs((current) => [payload.job, ...current]);
      setActiveId(payload.job.id);
      setMessage("Job berhasil dibuat. Halaman akan memperbarui progres otomatis.");
    } catch (error) {
      setMessage(error.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function copyCaption(clip) {
    await navigator.clipboard.writeText(clipCaptionText(clip));
    if (!mounted.current) return;
    setCopiedClip(`${activeJob.id}-${clip.index}`);
    if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => {
      copiedTimer.current = null;
      setCopiedClip(null);
    }, 1800);
  }

  return (
    <main>
      <nav className="nav shell">
        <a className="brand" href="/"><span>P</span> Potongin AI</a>
        <div className="navActions"><div className="navLinks"><a className="active" href="/dashboard">Buat Klip</a><a href="/projects">Riwayat</a><a href="/trends">Konteks Tren</a><a href="/settings">Pengaturan</a></div><div className="navMeta"><i /> Worker lokal siap</div><form method="post" action="/api/auth/logout"><button type="submit">Keluar</button></form></div>
      </nav>

      <section className="hero shell" id="top">
        <div className="eyebrow">AI VIDEO REPURPOSING · BAHASA INDONESIA</div>
        <h1>Satu video panjang.<br /><em>Banyak klip yang layak ditonton.</em></h1>
        <p>Masukkan URL YouTube atau unggah video. Engine memilih momen dengan hook terkuat, menulis judul dan teks hook, membuat subtitle karaoke, lalu merender klip siap Shorts, Reels, atau TikTok.</p>
        <div className="trust"><span>✓ Data tersimpan di server sendiri</span><span>✓ FFmpeg + Whisper lokal</span><span>✓ Tanpa biaya API per video</span></div>
      </section>

      {storageView.warning && (
        <div className={`storageBanner shell ${storageView.unavailable ? "unavailable" : "blocked"}`} role="alert" aria-live="polite">
          <div>
            <strong>{storageBlocked ? "Job baru dihentikan sementara" : "Status penyimpanan belum tersedia"}</strong>
            <span>{storageMessages[storageView.admission.code] || storageMessages.storage_admission_unavailable}</span>
          </div>
          <button type="button" onClick={refreshStorageStatus} aria-label="Coba lagi memeriksa status penyimpanan">Coba lagi</button>
        </div>
      )}

      <section className="workspace shell">
        <form className="panel creator" onSubmit={submit}>
          <div className="panelHead"><span>01</span><div><h2>Sumber video</h2><p>Pilih salah satu sumber untuk diproses.</p></div></div>
          <div className="tabs">
            <button type="button" className={sourceType === "youtube" ? "active" : ""} onClick={() => setSourceType("youtube")}>URL YouTube</button>
            <button type="button" className={sourceType === "upload" ? "active" : ""} onClick={() => setSourceType("upload")}>Upload file</button>
          </div>
          {sourceType === "youtube" ? (
            <label className="field"><span>URL video</span><input type="url" required placeholder="https://youtube.com/watch?v=..." value={youtubeUrl} onChange={(e) => setYoutubeUrl(e.target.value)} /></label>
          ) : (
            <label className="drop"><input type="file" required accept="video/mp4,video/quicktime,video/webm,.mkv,.m4v" onChange={(e) => setVideo(e.target.files?.[0] || null)} /><strong>{video ? video.name : "Tarik atau pilih file video"}</strong><small>MP4, MOV, MKV, WEBM · maksimal mengikuti konfigurasi server</small></label>
          )}

          <div className="divider" />
          <div className="panelHead compact"><span>02</span><div><h2>Layout output</h2><p>Mode bisa diganti untuk setiap job.</p></div></div>
          <div className="layoutGrid">
            {layouts.map((layout) => (
              <button type="button" key={layout.id} className={`layoutCard ${renderMode === layout.id ? "selected" : ""}`} onClick={() => setRenderMode(layout.id)}>
                <div className={`phone ${layout.id}`}><b /><i /></div>
                <div><strong>{layout.name}</strong><small>{layout.description}</small></div><mark>{layout.badge}</mark>
              </button>
            ))}
          </div>

          <div className="settings">
            <label><span>Jumlah klip</span><input type="number" min="1" max="10" value={limit} onChange={(e) => setLimit(e.target.value)} /></label>
            <label><span>Durasi minimum</span><div><input type="number" min="5" max="180" value={minDuration} onChange={(e) => setMinDuration(e.target.value)} /><b>detik</b></div></label>
            <label><span>Durasi maksimum</span><div><input type="number" min="5" max="180" value={maxDuration} onChange={(e) => setMaxDuration(e.target.value)} /><b>detik</b></div></label>
          </div>
          <div className="divider" />
          <section className="modePanel" aria-labelledby="selection-mode-title">
            <div className="panelHead compact"><span>03</span><div><h2 id="selection-mode-title">Pemilihan momen</h2><p>Cara engine memilih dan mengemas setiap klip.</p></div></div>
            <label className={`modeCard ${selectionMode === "v3" ? "selected" : ""}`}>
              <input type="radio" name="selectionMode" value="v3" checked={selectionMode === "v3"} onChange={() => setSelectionMode("v3")} />
              <span>
                <strong>AI Hook (V3) <mark>Disarankan</mark></strong>
                <small>AI membaca transkrip, memilih momen yang langsung menarik di detik pertama, lalu menulis judul, teks hook, deskripsi, dan hashtag. Kalau LLM gratis sedang tidak tersedia, pemilih heuristik lokal otomatis dipakai, jadi klip tetap jadi.</small>
              </span>
            </label>

            {selectionMode === "v3" && (
              <div className="v3Options">
                <LlmBadge status={llmStatus} llmMode={llmMode} />
                <a className="llmSettingsLink" href="/settings">Atur penyedia AI, API key, dan model di Pengaturan →</a>
                <fieldset className="choiceGroup">
                  <legend>Pemilihan momen</legend>
                  <label className={llmMode === "auto" ? "selected" : ""}>
                    <input type="radio" name="llmMode" value="auto" checked={llmMode === "auto"} onChange={() => setLlmMode("auto")} />
                    <span><strong>AI (LLM gratis)</strong><small>Otomatis cadangan heuristik bila LLM gagal.</small></span>
                  </label>
                  <label className={llmMode === "off" ? "selected" : ""}>
                    <input type="radio" name="llmMode" value="off" checked={llmMode === "off"} onChange={() => setLlmMode("off")} />
                    <span><strong>Tanpa LLM (heuristik)</strong><small>Tanpa internet; transkrip tidak dikirim ke mana pun.</small></span>
                  </label>
                </fieldset>
                <div className="toggleList">
                  <label className="shadowToggle">
                    <input type="checkbox" checked={coldOpen} onChange={(event) => setColdOpen(event.target.checked)} />
                    <span><strong>Buka dengan kalimat terkuat</strong><small>Kalimat hook diputar dulu beberapa detik (cold open), lalu klip berjalan dari awal.</small></span>
                  </label>
                  <label className="shadowToggle">
                    <input type="checkbox" checked={hookOverlay} onChange={(event) => setHookOverlay(event.target.checked)} />
                    <span><strong>Teks hook 4 detik pertama</strong><small>Kalimat pemancing singkat tampil di bagian atas layar.</small></span>
                  </label>
                </div>
                <fieldset className="choiceGroup">
                  <legend>Gaya subtitle</legend>
                  <label className={captionStyle === "karaoke" ? "selected" : ""}>
                    <input type="radio" name="captionStyle" value="karaoke" checked={captionStyle === "karaoke"} onChange={() => setCaptionStyle("karaoke")} />
                    <span><strong>Karaoke</strong><small>Kata yang sedang diucapkan menyala kuning.</small></span>
                  </label>
                  <label className={captionStyle === "classic" ? "selected" : ""}>
                    <input type="radio" name="captionStyle" value="classic" checked={captionStyle === "classic"} onChange={() => setCaptionStyle("classic")} />
                    <span><strong>Klasik</strong><small>Subtitle putih biasa, beberapa kata per baris.</small></span>
                  </label>
                </fieldset>
              </div>
            )}

            <details className="legacyModes" open={selectionMode !== "v3" || undefined}>
              <summary>Mode lama</summary>
              <div>
                {legacyModes.map((mode) => (
                  <label key={mode.id} className={`modeCard compactMode ${selectionMode === mode.id ? "selected" : ""}`}>
                    <input type="radio" name="selectionMode" value={mode.id} checked={selectionMode === mode.id} onChange={() => setSelectionMode(mode.id)} />
                    <span><strong>{mode.name}</strong><small>{mode.description}</small></span>
                  </label>
                ))}
                {selectionMode === "v2-shadow" && (
                  <label className="profileField">
                    <span>Profil kandidat V2</span>
                    <select value={clipProfile} onChange={(event) => setClipProfile(event.target.value)}>
                      <option value="viral-short">Klip singkat</option>
                      <option value="standard">Standar</option>
                      <option value="deep-dive">Pembahasan mendalam</option>
                    </select>
                  </label>
                )}
              </div>
            </details>
          </section>
          <button className="submit" disabled={submitting || storageBlocked}>{submitting ? "Membuat job…" : "Buat klip sekarang"}<span>→</span></button>
          {message && <p className="message">{message}</p>}
        </form>

        <aside className="panel monitor">
          <div className="panelHead"><span>03</span><div><h2>Progres & hasil</h2><p>Pantau worker tanpa membuka terminal.</p></div></div>
          {activeJob ? (
            <>
              <div className={`jobState ${activeJob.status}`}><div><small>JOB {activeJob.id.slice(0, 8)}</small><strong>{stageLabel[activeJob.stage] || statusLabel[activeJob.status] || activeJob.status}</strong></div><b>{activeJob.progress || 0}%</b></div>
              <div className="progress" role="progressbar" aria-label="Progres pemrosesan video" aria-valuemin="0" aria-valuemax="100" aria-valuenow={activeJob.progress || 0}><i style={{ width: `${activeJob.progress || 0}%` }} /></div>
              {!["completed", "failed"].includes(activeJob.status) && <div className="jobActivity" role="status" aria-live="polite"><i /><span>{activeJob.stageDetail || "Worker aktif memproses video"}</span><b>AKTIF</b></div>}
              {activeJob.error && <div className="error">{activeJob.error}</div>}
              <div className="results">
                {activeJob.clips?.map((clip) => (
                  <article className="clip" key={clip.index}>
                    <video controls preload="metadata" src={clip.videoUrl} poster={clipPosterUrl(clip)} />
                    <div className="clipMeta"><small>CLIP {String(clip.index).padStart(2, "0")} · {Math.round(clip.duration)} DETIK{selectionSourceLabel(clip.selectionSource) && clip.selectionSource !== "v1" ? ` · ${selectionSourceLabel(clip.selectionSource).toUpperCase()}` : ""}</small><h3>{clip.title}</h3>{clip.hookText && <p className="hookLine"><span>Hook</span>{clip.hookText}</p>}<p className="socialDescription">{clip.description}</p><div className="clipActions"><a href={clip.downloadUrl}>Download MP4 ↓</a><button type="button" onClick={() => copyCaption(clip)}>{copiedClip === `${activeJob.id}-${clip.index}` ? "Tersalin ✓" : "Salin caption"}</button></div></div>
                  </article>
                ))}
                {!activeJob.clips?.length && activeJob.status !== "failed" && <div className="empty"><div className="pulse" /><strong>{activeJob.stageDetail || "Worker sedang bekerja"}</strong><p>Progres diperbarui otomatis selama engine bekerja.</p></div>}
              </div>
            </>
          ) : <div className="empty"><div className="emptyIcon">▶</div><strong>Belum ada job</strong><p>Buat job pertama untuk melihat progres dan preview klip di sini.</p></div>}
          {jobs.length > 1 && <div className="history"><div className="historyTitle"><h3>Riwayat terbaru</h3><a href="/projects">Lihat semua →</a></div>{jobs.slice(0, 8).map((job) => <button key={job.id} onClick={() => setActiveId(job.id)} className={job.id === activeId ? "active" : ""}><span>{job.source?.name || job.id.slice(0, 8)}</span><b>{statusLabel[job.status] || job.status}</b></button>)}</div>}
        </aside>
      </section>
      <footer className="shell">Potongin AI · Self-hosted video worker <span>Next.js · Whisper · FFmpeg</span></footer>
    </main>
  );
}
