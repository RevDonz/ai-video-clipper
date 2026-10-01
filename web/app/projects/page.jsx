"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import AppHeader from "../../components/AppHeader.jsx";
import {
  PROJECT_FILTERS,
  formatProjectDate,
  historySummary,
  isActiveStatus,
  matchesProjectFilter,
  matchesProjectQuery,
  projectName,
  projectProgress,
  projectRowDetail,
  statusLabel,
} from "../../lib/project-view.mjs";
import { clipPosterUrl } from "../../lib/selection-v3-view.mjs";
import styles from "./projects.module.css";

// While a project is still running, the list is re-read on this interval.
const POLL_MS = 5000;

function ProjectRow({ job, editor, confirming, busy, onAskDelete, onCancelDelete, onDelete }) {
  const clips = Array.isArray(job.clips) ? job.clips : [];
  const editable = editor && job.status === "completed" && clips.length > 0;
  const poster = clips.map(clipPosterUrl).find(Boolean);
  const active = isActiveStatus(job.status);
  const name = projectName(job);
  const confirmId = `confirm-${job.id}`;
  const askRef = useRef(null);
  const cancelRef = useRef(null);
  const wasConfirming = useRef(false);

  // Opening the confirmation puts focus on "Batal"; closing it returns focus to "Hapus".
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
    else if (wasConfirming.current) askRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  return (
    <li className={styles.row} data-confirming={confirming || undefined}>
      <a className={styles.link} href={`/projects/${encodeURIComponent(job.id)}`}>
        <span className={styles.thumb} aria-hidden="true">
          {poster ? <img src={poster} alt="" loading="lazy" decoding="async" /> : clips.length > 0 && <i className={styles.play} />}
        </span>
        <span className={styles.info}>
          <strong>{name}</strong>
          <small>{formatProjectDate(job.createdAt)} · {projectRowDetail(job)}</small>
        </span>
        <span className={styles.status} data-status={job.status}>
          {statusLabel(job.status)}{active ? ` · ${projectProgress(job)}%` : ""}
        </span>
      </a>
      {job.status !== "deleting" && !confirming && (
        <div className={styles.actions}>
          {editable && (
            <a className={`btn ${styles.edit}`} href={`/projects/${encodeURIComponent(job.id)}#klip`} aria-label={`Edit klip ${name}`}>Edit klip</a>
          )}
          <button ref={askRef} type="button" className={`btn ghost ${styles.ask}`} onClick={onAskDelete} aria-label={`Hapus ${name}`}>Hapus</button>
        </div>
      )}
      {confirming && (
        <div
          className={styles.confirm}
          role="group"
          aria-labelledby={confirmId}
          onKeyDown={(event) => { if (event.key === "Escape" && !busy) onCancelDelete(); }}
        >
          <strong id={confirmId}>Hapus permanen?</strong>
          <p>
            Video sumber, hasil analisis, dan semua klip proyek ini ikut terhapus dari server. Tidak bisa dibatalkan.
            {active ? " Proses yang sedang berjalan dihentikan dulu." : ""}
          </p>
          <div>
            <button type="button" className="btn danger solid" disabled={busy} onClick={onDelete}>{busy ? "Menghapus…" : "Ya, hapus permanen"}</button>
            <button ref={cancelRef} type="button" className="btn" disabled={busy} onClick={onCancelDelete}>Batal</button>
          </div>
        </div>
      )}
    </li>
  );
}

export default function ProjectsPage() {
  const [jobs, setJobs] = useState([]);
  const [editor, setEditor] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [confirmingId, setConfirmingId] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [actionError, setActionError] = useState("");
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    let pollTimer = null;
    const load = async (initial) => {
      if (initial) {
        setLoading(true);
        setError("");
      }
      try {
        const response = await fetch("/api/jobs", { cache: "no-store", signal: controller.signal });
        if (response.status === 401) {
          window.location.assign(`/login?next=${encodeURIComponent("/projects")}`);
          return;
        }
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error("Riwayat tidak bisa dimuat. Coba lagi sebentar lagi.");
        if (!alive) return;
        const list = Array.isArray(payload.jobs) ? payload.jobs : [];
        setJobs(list);
        setEditor(payload.editor === true);
        setLoaded(true);
        setError("");
        if (list.some((job) => isActiveStatus(job.status))) pollTimer = setTimeout(() => load(false), POLL_MS);
      } catch (loadError) {
        if (!alive || loadError?.name === "AbortError") return;
        if (initial) setError(loadError instanceof TypeError ? "Riwayat tidak bisa dimuat. Periksa koneksi, lalu coba lagi." : loadError.message);
        else pollTimer = setTimeout(() => load(false), POLL_MS);
      } finally {
        if (alive && initial) setLoading(false);
      }
    };
    load(true);
    return () => {
      alive = false;
      controller.abort();
      if (pollTimer !== null) clearTimeout(pollTimer);
    };
  }, [generation]);

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
      if (!response.ok) throw new Error(payload.error || "Proyek tidak bisa dihapus. Coba lagi.");
      setConfirmingId(null);
      setJobs((current) => (payload.removed
        ? current.filter((item) => item.id !== job.id)
        : current.map((item) => (item.id === job.id ? { ...item, status: "deleting", progress: 0 } : item))));
    } catch (deleteError) {
      setActionError(deleteError instanceof TypeError ? "Proyek tidak bisa dihapus. Periksa koneksi, lalu coba lagi." : deleteError.message);
    } finally {
      setBusyId(null);
    }
  }

  const visible = useMemo(
    () => jobs.filter((job) => matchesProjectFilter(job, filter) && matchesProjectQuery(job, query)),
    [jobs, query, filter],
  );
  const filtered = query.trim() !== "" || filter !== "all";

  return (
    <main>
      <AppHeader current="/projects" />
      <div className={`shell ${styles.page}`}>
        <header className={styles.head}>
          <div>
            <h1>Riwayat proyek</h1>
            {loaded && <p>{historySummary(jobs)}</p>}
          </div>
          <a className="btn primary" href="/dashboard">Buat klip baru</a>
        </header>

        <div className={styles.tools}>
          <label className={styles.search}>
            <span className="visuallyHidden">Cari proyek</span>
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Cari nama, ID, URL, atau isi klip" />
          </label>
          <div className={`segmented ${styles.filters}`} role="group" aria-label="Saring status">
            {PROJECT_FILTERS.map((item) => (
              <button key={item.value} type="button" aria-pressed={filter === item.value} onClick={() => setFilter(item.value)}>{item.label}</button>
            ))}
          </div>
          <button type="button" className="btn" onClick={() => setGeneration((value) => value + 1)} disabled={loading}>{loading ? "Memuat…" : "Muat ulang"}</button>
        </div>

        {actionError && <div className={`notice error ${styles.notice}`} role="alert">{actionError}</div>}

        {loading && !loaded && (
          <div className={styles.state} role="status" aria-live="polite"><span className="pulse" aria-hidden="true" /><p>Memuat riwayat…</p></div>
        )}
        {!loading && error && (
          <div className={`notice error ${styles.notice}`} role="alert">
            <strong>Riwayat tidak bisa dimuat</strong>
            <span>{error}</span>
            <button type="button" className={`btn ${styles.retry}`} onClick={() => setGeneration((value) => value + 1)}>Coba lagi</button>
          </div>
        )}
        {loaded && jobs.length === 0 && (
          <div className={styles.state}>
            <strong>Belum ada proyek</strong>
            <p>Proyek yang kamu buat di Buat Klip muncul di sini, lengkap dengan klipnya.</p>
          </div>
        )}
        {loaded && jobs.length > 0 && visible.length === 0 && (
          <div className={styles.state}>
            <strong>Tidak ada proyek yang cocok</strong>
            <p>Ubah kata pencarian atau pilih status lain.</p>
            {filtered && <button type="button" className="btn" onClick={() => { setQuery(""); setFilter("all"); }}>Tampilkan semua</button>}
          </div>
        )}

        {visible.length > 0 && (
          <ul className={styles.list} aria-label="Proyek">
            {visible.map((job) => (
              <ProjectRow
                key={job.id}
                job={job}
                editor={editor}
                confirming={confirmingId === job.id}
                busy={busyId === job.id}
                onAskDelete={() => { setActionError(""); setConfirmingId(job.id); }}
                onCancelDelete={() => setConfirmingId(null)}
                onDelete={() => deleteProject(job)}
              />
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
