"use client";

import { useEffect, useRef, useState } from "react";

import { notifyJobsChanged } from "../lib/job-badge.mjs";
import { cancelJob } from "../lib/job-cancel.mjs";
import styles from "./CancelJob.module.css";

/**
 * "Batalkan" for a queued or running job, confirmed inside the page (a browser dialog would block
 * it). `onSettled(job, note)` gets the job as the server has it afterwards: cancelled, or already
 * finished, with a short note in that case.
 */
export default function CancelJob({ job, next, onSettled }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const askRef = useRef(null);
  const keepRef = useRef(null);
  const wasConfirming = useRef(false);
  const titleId = `cancel-${job.id}`;

  // Opening moves focus to "Lanjutkan proses", the safe choice; closing returns it to "Batalkan".
  useEffect(() => {
    if (confirming) keepRef.current?.focus();
    else if (wasConfirming.current) askRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  function close() {
    if (busy) return;
    setConfirming(false);
    setError("");
  }

  async function confirmCancel() {
    setBusy(true);
    setError("");
    const result = await cancelJob(job.id, { next });
    if (result.type === "redirect") {
      window.location.assign(result.location);
      return;
    }
    setBusy(false);
    if (result.type === "error") {
      setError(result.message);
      return;
    }
    setConfirming(false);
    notifyJobsChanged();
    onSettled(result.job, result.type === "finished" ? result.message : null);
  }

  if (!confirming) {
    return (
      <button ref={askRef} type="button" className={`btn ghost ${styles.ask}`} onClick={() => setConfirming(true)}>
        Batalkan
      </button>
    );
  }

  return (
    <div
      className={styles.confirm}
      role="group"
      aria-labelledby={titleId}
      onKeyDown={(event) => { if (event.key === "Escape") close(); }}
    >
      <strong id={titleId}>Batalkan proses ini?</strong>
      <p>Proses berhenti dan hasil yang belum jadi dibuang. Proyeknya tetap ada di Riwayat.</p>
      <div>
        <button type="button" className="btn danger solid" disabled={busy} onClick={confirmCancel}>{busy ? "Membatalkan…" : "Ya, batalkan"}</button>
        <button ref={keepRef} type="button" className="btn" disabled={busy} onClick={close}>Lanjutkan proses</button>
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
    </div>
  );
}
