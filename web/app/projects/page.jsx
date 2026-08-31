"use client";

import { useEffect, useMemo, useState } from "react";

const statusLabel = {
  queued: "Menunggu",
  preparing: "Menyiapkan",
  downloading: "Mengunduh",
  processing: "Diproses",
  completed: "Selesai",
  failed: "Gagal",
  deleting: "Menghapus",
};

function projectName(job) {
  if (job.source?.name) return job.source.name;
  if (job.source?.type === "youtube") {
    try {
      const url = new URL(job.source.url);
      return `YouTube · ${url.searchParams.get("v") || url.pathname.split("/").filter(Boolean).at(-1) || "Video"}`;
    } catch {
      return "Video YouTube";
    }
  }
  return `Proyek ${job.id.slice(0, 8)}`;
}

function formatDate(value) {
  if (!value) return "Tanggal tidak tersedia";
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export default function ProjectsPage() {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [opened, setOpened] = useState(null);
  const [copiedClip, setCopiedClip] = useState(null);
  const [confirmingId, setConfirmingId] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [actionError, setActionError] = useState("");

  async function loadJobs() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/jobs", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Riwayat tidak dapat dimuat");
      setJobs(payload.jobs || []);
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadJobs();
  }, []);

  // Deletion is permanent and covers running jobs: the server revokes the
  // worker's lease, then reclaims the bytes once that worker has stopped.
  async function deleteProject(job) {
    setBusyId(job.id);
    setActionError("");
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(job.id)}`, {
        method: "DELETE",
        cache: "no-store",
        headers: { "Accept": "application/json" },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Proyek tidak dapat dihapus");
      setConfirmingId(null);
      setOpened((current) => (current === job.id ? null : current));
      setJobs((current) => (payload.removed
        ? current.filter((item) => item.id !== job.id)
        : current.map((item) => (item.id === job.id ? { ...item, status: "deleting", progress: 0 } : item))));
    } catch (deleteError) {
      setActionError(deleteError.message);
    } finally {
      setBusyId(null);
    }
  }

  async function copyCaption(job, clip) {
    await navigator.clipboard.writeText(`${clip.title}\n\n${clip.description}`);
    setCopiedClip(`${job.id}-${clip.index}`);
    setTimeout(() => setCopiedClip(null), 1800);
  }

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return jobs.filter((job) => {
      const matchesStatus = filter === "all"
        || (filter === "active" && !["completed", "failed"].includes(job.status))
        || job.status === filter;
      const haystack = [
        projectName(job),
        job.id,
        job.source?.url,
        ...(job.clips || []).map((clip) => clip.text),
      ].filter(Boolean).join(" ").toLowerCase();
      return matchesStatus && (!needle || haystack.includes(needle));
    });
  }, [jobs, query, filter]);

  const completed = jobs.filter((job) => job.status === "completed").length;
  const clips = jobs.reduce((total, job) => total + (job.clips?.length || 0), 0);

  return (
    <main>
      <nav className="nav shell">
        <a className="brand" href="/"><span>P</span> Potongin AI</a>
        <div className="navActions">
          <div className="navLinks"><a href="/dashboard">Buat Klip</a><a className="active" href="/projects">Riwayat</a></div>
          <form method="post" action="/api/auth/logout"><button type="submit">Keluar</button></form>
        </div>
      </nav>

      <section className="projectsHero shell">
        <div><div className="eyebrow">ARSIP VIDEO · TERSIMPAN DI SERVER</div><h1>Riwayat proyek</h1><p>Buka kembali semua proses dan hasil klip yang pernah dibuat.</p></div>
        <a className="newProject" href="/dashboard">+ Buat proyek baru</a>
      </section>

      <section className="projectStats shell">
        <div><strong>{jobs.length}</strong><span>Total proyek</span></div>
        <div><strong>{completed}</strong><span>Proyek selesai</span></div>
        <div><strong>{clips}</strong><span>Klip tersimpan</span></div>
      </section>

      <section className="projectBrowser shell">
        <div className="projectTools">
          <label className="projectSearch"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Cari nama, ID, URL, atau isi klip…" /></label>
          <div className="projectFilters">
            {[["all", "Semua"], ["completed", "Selesai"], ["active", "Berjalan"], ["failed", "Gagal"]].map(([value, label]) => (
              <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{label}</button>
            ))}
          </div>
          <button className="refreshProjects" onClick={loadJobs} disabled={loading}>↻ Muat ulang</button>
        </div>

        {error && <div className="projectError">{error}</div>}
        {actionError && <div className="projectError" role="alert">{actionError}</div>}
        {loading ? <div className="projectEmpty"><div className="pulse" /><strong>Memuat seluruh riwayat…</strong></div> : null}
        {!loading && !visible.length ? <div className="projectEmpty"><div className="emptyIcon">⌕</div><strong>Tidak ada proyek yang cocok</strong><p>Ubah kata pencarian atau filter status.</p></div> : null}

        <div className="projectList">
          {visible.map((job) => {
            const isOpen = opened === job.id;
            return (
              <article className={`projectCard ${isOpen ? "opened" : ""}`} key={job.id}>
                <button className="projectSummary" onClick={() => setOpened(isOpen ? null : job.id)} aria-expanded={isOpen}>
                  <div className={`projectPoster ${job.status}`}><span>{job.clips?.length || 0}</span><small>KLIP</small></div>
                  <div className="projectIdentity"><small>{formatDate(job.createdAt)}</small><h2>{projectName(job)}</h2><p>ID {job.id.slice(0, 8)} · {job.options?.renderMode || "fit-blur"}</p></div>
                  <div className="projectMetrics"><span className={`statusPill ${job.status}`}>{statusLabel[job.status] || job.status}</span><b>{job.progress || 0}%</b></div>
                  <span className="projectChevron">{isOpen ? "−" : "+"}</span>
                </button>

                {isOpen && (
                  <div className="projectDetail">
                    <a className="projectDetailLink" href={`/projects/${job.id}`}>Buka detail & kandidat V2 →</a>
                    <div className="projectDanger">
                      {confirmingId === job.id ? (
                        <>
                          <strong>Hapus permanen?</strong>
                          <p>Video sumber, seluruh artefak analisis, dan klip hasil render akan hilang dari server. Tindakan ini tidak dapat dibatalkan.{!["completed", "failed", "deleting"].includes(job.status) ? " Proses yang sedang berjalan akan dihentikan lebih dulu, jadi penghapusan selesai dalam waktu kurang dari satu menit." : ""}</p>
                          <div>
                            <button type="button" className="confirmDelete" disabled={busyId === job.id} onClick={() => deleteProject(job)}>
                              {busyId === job.id ? "Menghapus…" : "Ya, hapus permanen"}
                            </button>
                            <button type="button" onClick={() => setConfirmingId(null)} disabled={busyId === job.id}>Batal</button>
                          </div>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="requestDelete"
                          disabled={job.status === "deleting"}
                          onClick={() => { setActionError(""); setConfirmingId(job.id); }}
                        >{job.status === "deleting" ? "Sedang dihapus…" : "Hapus proyek"}</button>
                      )}
                    </div>
                    {job.source?.url && <a className="sourceLink" href={job.source.url} target="_blank" rel="noreferrer">Buka sumber YouTube ↗</a>}
                    {job.error && <div className="projectError">{job.error}</div>}
                    {job.clips?.length ? (
                      <div className="archiveClips">
                        {job.clips.map((clip) => (
                          <article className="archiveClip" key={clip.index}>
                            <video controls preload="metadata" src={clip.videoUrl} />
                            <div><small>CLIP {String(clip.index).padStart(2, "0")} · {Math.round(clip.duration || 0)} DETIK</small><h3>{clip.title}</h3><p className="socialDescription">{clip.description}</p><div className="archiveActions"><a href={clip.downloadUrl}>Download MP4 ↓</a>{clip.subtitleUrl && <a href={clip.subtitleUrl}>Subtitle SRT ↓</a>}<button type="button" onClick={() => copyCaption(job, clip)}>{copiedClip === `${job.id}-${clip.index}` ? "Tersalin ✓" : "Salin caption"}</button></div></div>
                          </article>
                        ))}
                      </div>
                    ) : <div className="noClips"><strong>{job.status === "failed" ? "Proses ini gagal" : "Klip belum tersedia"}</strong><p>{statusLabel[job.status] || job.status} · progres {job.progress || 0}%</p></div>}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>
      <footer className="shell">Potongin AI · Arsip tersimpan di volume server <span>{jobs.length} proyek · {clips} klip</span></footer>
    </main>
  );
}