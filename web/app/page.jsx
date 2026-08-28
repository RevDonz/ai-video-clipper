"use client";

import { useEffect, useMemo, useState } from "react";

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

const statusLabel = {
  queued: "Menunggu worker",
  preparing: "Menyiapkan video",
  downloading: "Mengunduh YouTube",
  processing: "Transkripsi dan render",
  completed: "Selesai",
  failed: "Gagal",
};

export default function Home() {
  const [sourceType, setSourceType] = useState("youtube");
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [video, setVideo] = useState(null);
  const [renderMode, setRenderMode] = useState("fit-blur");
  const [limit, setLimit] = useState(3);
  const [minDuration, setMinDuration] = useState(20);
  const [maxDuration, setMaxDuration] = useState(60);
  const [jobs, setJobs] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [copiedClip, setCopiedClip] = useState(null);

  const activeJob = useMemo(() => jobs.find((job) => job.id === activeId), [jobs, activeId]);

  async function refreshJobs() {
    const response = await fetch("/api/jobs", { cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json();
    setJobs(payload.jobs || []);
    setActiveId((current) => current || payload.jobs?.[0]?.id || null);
  }

  useEffect(() => {
    refreshJobs();
  }, []);

  useEffect(() => {
    if (!activeId || ["completed", "failed"].includes(activeJob?.status)) return undefined;
    const timer = setInterval(async () => {
      const response = await fetch(`/api/jobs/${activeId}`, { cache: "no-store" });
      if (!response.ok) return;
      const payload = await response.json();
      setJobs((current) => {
        const exists = current.some((job) => job.id === activeId);
        return exists
          ? current.map((job) => (job.id === activeId ? payload.job : job))
          : [payload.job, ...current];
      });
    }, 2500);
    return () => clearInterval(timer);
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
      if (sourceType === "youtube") data.set("youtubeUrl", youtubeUrl);
      else if (video) data.set("video", video);
      const response = await fetch("/api/jobs", { method: "POST", body: data });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Gagal membuat job");
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
    await navigator.clipboard.writeText(`${clip.title}\n\n${clip.description}`);
    setCopiedClip(`${activeJob.id}-${clip.index}`);
    setTimeout(() => setCopiedClip(null), 1800);
  }

  return (
    <main>
      <nav className="nav shell">
        <a className="brand" href="/"><span>P</span> Potongin AI</a>
        <div className="navActions"><div className="navLinks"><a className="active" href="/">Buat Klip</a><a href="/projects">Riwayat</a></div><div className="navMeta"><i /> Worker lokal siap</div><form method="post" action="/api/auth/logout"><button type="submit">Keluar</button></form></div>
      </nav>

      <section className="hero shell" id="top">
        <div className="eyebrow">AI VIDEO REPURPOSING · BAHASA INDONESIA</div>
        <h1>Satu video panjang.<br /><em>Banyak klip yang layak ditonton.</em></h1>
        <p>Masukkan URL YouTube atau unggah video. Engine lokal akan memilih momen, membuat subtitle, dan merender klip siap Shorts, Reels, atau TikTok.</p>
        <div className="trust"><span>✓ Data tersimpan di server sendiri</span><span>✓ FFmpeg + Whisper lokal</span><span>✓ Tanpa biaya API per video</span></div>
      </section>

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
          <button className="submit" disabled={submitting}>{submitting ? "Membuat job…" : "Buat klip sekarang"}<span>→</span></button>
          {message && <p className="message">{message}</p>}
        </form>

        <aside className="panel monitor">
          <div className="panelHead"><span>03</span><div><h2>Progres & hasil</h2><p>Pantau worker tanpa membuka terminal.</p></div></div>
          {activeJob ? (
            <>
              <div className={`jobState ${activeJob.status}`}><div><small>JOB {activeJob.id.slice(0, 8)}</small><strong>{statusLabel[activeJob.status] || activeJob.status}</strong></div><b>{activeJob.progress || 0}%</b></div>
              <div className="progress"><i style={{ width: `${activeJob.progress || 0}%` }} /></div>
              {activeJob.error && <div className="error">{activeJob.error}</div>}
              <div className="results">
                {activeJob.clips?.map((clip) => (
                  <article className="clip" key={clip.index}>
                    <video controls preload="metadata" src={clip.videoUrl} />
                    <div className="clipMeta"><small>CLIP {String(clip.index).padStart(2, "0")} · {Math.round(clip.duration)} DETIK</small><h3>{clip.title}</h3><p className="socialDescription">{clip.description}</p><div className="clipActions"><a href={clip.downloadUrl}>Download MP4 ↓</a><button type="button" onClick={() => copyCaption(clip)}>{copiedClip === `${activeJob.id}-${clip.index}` ? "Tersalin ✓" : "Salin caption"}</button></div></div>
                  </article>
                ))}
                {!activeJob.clips?.length && activeJob.status !== "failed" && <div className="empty"><div className="pulse" /><strong>Worker sedang bekerja</strong><p>Video panjang di CPU dapat membutuhkan beberapa menit.</p></div>}
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
