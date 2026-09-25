"use client";

// The export dialog (plan Appendix C.5): (1) the revision and the "Perlu dicek" items, each
// acknowledged; (2) the output line, and the R10 line for unchanged content; (3) Antre → Merender
// (n%) → Memverifikasi → Selesai, with cancel until the end; (4) downloads, the read-only title,
// description and hashtags with copy buttons, and the audio notes; (5) earlier exports; (6) on a
// failure, the Indonesian explanation and "Coba lagi". No size or quality choice in Essentials.
// The state machine lives in export-flow.mjs; EditorApp owns it, so closing the dialog never
// stops a render.
import { useEffect, useMemo, useRef, useState } from "react";

import styles from "./shell.module.css";
import { canStartExport, exportStepView } from "./export-flow.mjs";
import { safeApiHref } from "./shell-model.mjs";

const ACTIVE = new Set(["saving", "submitting", "running"]);
const AUDIO_NOTES = new Set(["peak_reduced", "loudness_clamped"]);

const FAILURE_HELP = {
  verification_failed: "File tidak dipublikasikan karena tidak lolos pemeriksaan (format, jumlah frame, atau audio). Coba lagi; bila gagal lagi, simpan kode ini untuk laporan: verification_failed.",
  render_timeout: "Render berhenti karena melebihi batas waktu. Coba lagi saat server tidak sibuk.",
  render_stalled: "Render tidak memberi kemajuan selama 20 detik dan dihentikan. Coba lagi.",
};

function formatTime(ms) {
  if (!Number.isFinite(ms)) return "";
  return new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
}

function CopyField({ label, value, copyLabel }) {
  const [copied, setCopied] = useState("");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied("Tersalin");
    } catch {
      setCopied("Gagal menyalin; pilih teks secara manual");
    }
  };
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <span className={styles.packValue}>{value || "—"}</span>
        <button type="button" className={`${styles.button} ${styles.quiet}`} onClick={copy} disabled={!value}>{copyLabel}</button>
        <span className={styles.visuallyHidden} role="status" aria-live="polite">{copied}</span>
      </dd>
    </div>
  );
}

export default function ExportDialog({
  open, onClose, flow, onStart, onCancel, onRetry, checks, revision, dirty, unchanged, output, packaging, earlier, readOnly,
}) {
  const dialogRef = useRef(null);
  const [acked, setAcked] = useState(() => new Set());
  const checkKeys = checks.map((check) => check.key).join("\n");

  useEffect(() => { setAcked(new Set()); }, [checkKeys]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const phase = flow?.phase ?? "idle";
  const active = ACTIVE.has(phase);
  const steps = useMemo(() => exportStepView(flow?.render ?? null, flow?.lastRunning ?? null), [flow?.render, flow?.lastRunning]);
  const warnings = checks.filter((check) => check.severity !== "error");
  const blocking = checks.filter((check) => check.severity === "error");
  const ready = canStartExport(checks, acked) && !readOnly;
  const notes = warnings.filter((check) => AUDIO_NOTES.has(check.code.split(":")[0]));
  const result = phase === "completed" ? flow.render : null;
  const failed = phase === "failed" || phase === "cancelled" || phase === "error";
  const toggle = (key) => setAcked((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby="editor-export-title"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
    >
      {open && (
        <>
          <div className={styles.dialogHeader}>
            <h2 id="editor-export-title">Ekspor klip</h2>
            <button type="button" className={`${styles.button} ${styles.quiet}`} onClick={onClose}>Tutup</button>
          </div>
          <div className={styles.dialogBody}>
            <section className={styles.section} aria-labelledby="export-revision">
              <h3 id="export-revision">Revisi</h3>
              <p className={styles.muted}>
                {`Revisi ${revision ?? 0}`}
                {dirty ? " · perubahan terakhir disimpan dulu sebelum ekspor" : " · tersimpan"}
              </p>
              {blocking.length > 0 && (
                <ul className={styles.checkList}>
                  {blocking.map((check) => (
                    <li key={check.key} className={`${styles.checkItem} ${styles.checkItem_error}`}>
                      <span><strong>Perbaiki dulu: </strong>{check.message}</span>
                    </li>
                  ))}
                </ul>
              )}
              {warnings.length > 0 && phase === "idle" && (
                <>
                  <p className={styles.muted}>Tandai setiap hal di bawah setelah Anda mengeceknya.</p>
                  <ul className={styles.checkList}>
                    {warnings.map((check, index) => (
                      <li key={check.key} className={styles.checkItem}>
                        <label htmlFor={`export-ack-${index}`}>
                          <input id={`export-ack-${index}`} type="checkbox" checked={acked.has(check.key)} onChange={() => toggle(check.key)} />
                          <span>{check.message}</span>
                        </label>
                        {check.timeText !== null && <span className={styles.checkTime}>{check.timeText}</span>}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {warnings.length > 0 && phase !== "idle" && (
                <p className={styles.muted}>{`Semua ${warnings.length} hal sudah dicek.`}</p>
              )}
            </section>

            <section className={styles.section} aria-labelledby="export-output">
              <h3 id="export-output">Hasil</h3>
              <p className={styles.muted}>{`${output?.w ?? 720}×${output?.h ?? 1280}, kualitas sama dengan klip otomatis`}</p>
              {unchanged && <p className={styles.note}>Tanpa perubahan: file klip otomatis dipakai langsung</p>}
            </section>

            <section className={styles.section} aria-labelledby="export-progress">
              <h3 id="export-progress">Progres</h3>
              <ol className={styles.steps} aria-label="Tahap ekspor">
                {steps.steps.map((step) => (
                  <li key={step.id} className={styles.step} data-step-status={step.status} aria-current={step.status === "current" || step.status === "stopped" ? "step" : undefined}>
                    {step.text}
                  </li>
                ))}
              </ol>
              {phase === "saving" && <p className={styles.muted} role="status">Menyimpan perubahan dulu…</p>}
              {phase === "submitting" && <p className={styles.muted} role="status">Mengirim ke antrean render…</p>}
              {flow?.cancelling && <p className={styles.muted} role="status">Membatalkan…</p>}
              {failed && (
                <div className={styles.alert} role="alert">
                  <p style={{ margin: 0 }}>{flow.errorText}</p>
                  {FAILURE_HELP[flow.errorCode] && <p style={{ margin: "6px 0 0", fontWeight: 500 }}>{FAILURE_HELP[flow.errorCode]}</p>}
                </div>
              )}
            </section>

            {result && (
              <section className={styles.section} aria-labelledby="export-result">
                <h3 id="export-result">Unduhan</h3>
                <div className={styles.downloads}>
                  {safeApiHref(result.resultUrl) && (
                    <a className={`${styles.button} ${styles.primary} ${styles.downloadLink}`} href={safeApiHref(result.resultUrl)} download>Unduh MP4</a>
                  )}
                  {safeApiHref(result.srtUrl) && (
                    <a className={`${styles.button} ${styles.downloadLink}`} href={safeApiHref(result.srtUrl)} download>Unduh SRT</a>
                  )}
                </div>
                {notes.map((check) => <p key={check.key} className={styles.note}>{`Catatan audio: ${check.message}`}</p>)}
                {packaging && (
                  <dl className={styles.packaging}>
                    <CopyField label="Judul" value={packaging.title ?? ""} copyLabel="Salin judul" />
                    <CopyField label="Deskripsi" value={packaging.description ?? ""} copyLabel="Salin deskripsi" />
                    <CopyField label="Hashtag" value={(packaging.hashtags ?? []).join(" ")} copyLabel="Salin hashtag" />
                  </dl>
                )}
              </section>
            )}

            {earlier.length > 0 && (
              <section className={styles.section} aria-labelledby="export-history">
                <h3 id="export-history">Ekspor sebelumnya</h3>
                <ul className={styles.history} aria-label="Ekspor sebelumnya">
                  {earlier.map((item) => (
                    <li key={item.renderId}>
                      <span>{`Revisi ${item.revision ?? "?"}`}</span>
                      {item.atMs && <span className={styles.checkTime}>{formatTime(item.atMs)}</span>}
                      {item.state === "completed" && safeApiHref(item.resultUrl)
                        ? <a href={safeApiHref(item.resultUrl)} download>{`MP4 revisi ${item.revision ?? "?"}`}</a>
                        : <span className={styles.muted}>{item.state === "failed" ? "gagal" : item.state === "cancelled" ? "dibatalkan" : "diproses"}</span>}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
          <div className={styles.dialogFooter}>
            {active && (
              <button type="button" className={styles.button} onClick={onCancel} disabled={flow?.cancelling}>Batalkan ekspor</button>
            )}
            {failed && <button type="button" className={`${styles.button} ${styles.primary}`} onClick={onRetry}>Coba lagi</button>}
            {phase === "idle" && (
              <button type="button" className={`${styles.button} ${styles.primary}`} onClick={onStart} disabled={!ready}>Mulai ekspor</button>
            )}
          </div>
        </>
      )}
    </dialog>
  );
}
