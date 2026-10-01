"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import AppHeader from "../../components/AppHeader.jsx";
import {
  AI_STATUS_UNREADABLE,
  aiStatusView,
  clipMetaText,
  focusAiMode,
  jobActivityText,
  jobFailureView,
  jobFinished,
  jobFormProblems,
  jobPercentText,
  jobSourceLabel,
  jobStageText,
  JOB_STATUS_LABELS,
  storageMessage,
  submitErrorMessage,
} from "../../lib/dashboard-view.mjs";
import {
  createStorageStatusRecovery,
  recoverFailedJobSelection,
  storageStatusView,
} from "../../lib/dashboard-storage-status.mjs";
import {
  FOCUS_LIMITS,
  addFocusTerms,
  clipCaptionText,
  clipPosterUrl,
  focusFormFields,
  focusTermMatchable,
  focusTermsHint,
  normalizeFocusText,
  pastedFocusTerms,
} from "../../lib/selection-v3-view.mjs";
import styles from "./dashboard.module.css";
import focusStyles from "./focus.module.css";

const layouts = [
  { id: "fit-blur", name: "Utuh + latar blur", description: "Video landscape tetap utuh, sisa layar diisi versi blur." },
  { id: "face-track", name: "Ikuti pembicara", description: "Layar penuh, crop mengikuti wajah terbesar." },
  { id: "center-crop", name: "Crop tengah", description: "Untuk video yang subjeknya selalu di tengah." },
];

const captionStyles = [
  { id: "karaoke", name: "Karaoke", description: "Kata yang sedang diucapkan menyala." },
  { id: "classic", name: "Klasik", description: "Beberapa kata per baris, tanpa sorotan." },
];

// Fields in the order the page checks them; the first invalid one gets focus.
const FIELD_IDS = { youtubeUrl: "youtube-url", video: "video-file", limit: "clip-limit", minDuration: "min-duration", maxDuration: "max-duration" };

function FieldError({ id, message }) {
  return message ? <p id={id} className={styles.fieldError}>{message}</p> : null;
}

/**
 * Fokus klip (docs/plans/2026-09-25-fokus-klip.md §3): focus terms as removable chips (a comma
 * or Enter makes a chip, a pasted list one chip per line) plus a free note for the AI. Empty
 * means no focus: nothing is sent. Chips the transcript can never say literally get a hint.
 */
function FocusField({ terms, draft, note, error, aiMode, onTermsChange, onDraftChange, onNoteChange, onErrorChange }) {
  const inputRef = useRef(null);
  const removeButtons = useRef([]);
  const refocusIndex = useRef(null);
  const noteLength = Array.from(normalizeFocusText(note)).length;
  const full = terms.length >= FOCUS_LIMITS.terms;
  const hint = focusTermsHint(terms, aiMode);

  // After a chip is removed, keyboard focus moves to the next chip's button, else the input.
  useEffect(() => {
    removeButtons.current.length = terms.length;
    if (refocusIndex.current === null) return;
    const index = Math.min(refocusIndex.current, terms.length - 1);
    refocusIndex.current = null;
    (index >= 0 ? removeButtons.current[index] : inputRef.current)?.focus();
  }, [terms]);

  function apply(result, rest = "") {
    onTermsChange(result.terms);
    onDraftChange([result.pending, rest].filter(Boolean).join(", "));
    onErrorChange(result.error);
  }

  function changeDraft(value) {
    const cut = Math.max(value.lastIndexOf(","), value.lastIndexOf("\n"));
    if (cut < 0) {
      onDraftChange(value);
      if (error) onErrorChange("");
      return;
    }
    apply(addFocusTerms(terms, value.slice(0, cut)), value.slice(cut + 1).trimStart());
  }

  function commitDraft() {
    if (normalizeFocusText(draft)) apply(addFocusTerms(terms, draft));
  }

  // A single-line input turns pasted line breaks into spaces: read the paste itself.
  function pasteList(event) {
    const input = event.currentTarget;
    const text = pastedFocusTerms(draft, event.clipboardData?.getData("text"), input.selectionStart, input.selectionEnd);
    if (text === null) return;
    event.preventDefault();
    apply(addFocusTerms(terms, text));
  }

  function remove(index) {
    refocusIndex.current = index;
    onTermsChange(terms.filter((_, position) => position !== index));
    onErrorChange("");
  }

  return (
    <div className={focusStyles.focus} role="group" aria-label="Fokus klip">
      <div className={focusStyles.head}>
        <label className={focusStyles.label} htmlFor="focus-terms-input">Cari momen tentang… (opsional)</label>
        <span className={focusStyles.count} aria-hidden="true">{terms.length}/{FOCUS_LIMITS.terms}</span>
      </div>
      <div className={focusStyles.box}>
        {terms.length > 0 && (
          <ul className={focusStyles.chips} aria-label="Kata kunci fokus">
            {terms.map((term, index) => (
              <li key={term} className={focusTermMatchable(term) ? undefined : focusStyles.unmatchable}>
                <span>{term}</span>
                <button type="button" ref={(node) => { removeButtons.current[index] = node; }} aria-label={`Hapus kata kunci ${term}`} onClick={() => remove(index)}>×</button>
              </li>
            ))}
          </ul>
        )}
        <input
          id="focus-terms-input"
          ref={inputRef}
          className={focusStyles.input}
          type="text"
          autoComplete="off"
          enterKeyHint="enter"
          value={draft}
          placeholder={full ? `Maksimal ${FOCUS_LIMITS.terms} kata kunci` : terms.length ? "Tambah kata kunci…" : "contoh: prank, tips kerja"}
          aria-describedby={hint ? "focus-terms-help focus-terms-hint" : "focus-terms-help"}
          aria-invalid={error ? "true" : undefined}
          onChange={(event) => changeDraft(event.target.value)}
          onPaste={pasteList}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            commitDraft();
          }}
          onBlur={commitDraft}
        />
      </div>
      <p id="focus-terms-help" className={focusStyles.help}>Klip yang membahasnya didahulukan; sisa slot diisi momen terbaik lain berlabel “Di luar fokus”. Pisahkan dengan koma atau Enter, maksimal {FOCUS_LIMITS.terms}.</p>
      {hint && <p id="focus-terms-hint" className={focusStyles.hint}>{hint}</p>}
      {error && <p className={focusStyles.error} role="alert">{error}</p>}
      <label className={focusStyles.noteLabel} htmlFor="focus-note">Catatan untuk AI (opsional)</label>
      <textarea id="focus-note" className={focusStyles.note} rows={2} value={note} placeholder="contoh: momen prank yang bikin ketawa" aria-describedby="focus-note-help" onChange={(event) => onNoteChange(event.target.value)} />
      <p id="focus-note-help" className={`${focusStyles.help} ${focusStyles.noteMeta}`}>
        <span>{aiMode === "off" ? "Tanpa AI, hanya momen yang menyebut kata kuncinya langsung yang dikenali; catatan tidak dipakai." : "Jelaskan momen yang dicari dengan kalimat biasa."}</span>
        <span className={noteLength > FOCUS_LIMITS.note ? focusStyles.over : undefined}>{noteLength}/{FOCUS_LIMITS.note}</span>
      </p>
    </div>
  );
}

function ClipCard({ clip, copied, onCopy }) {
  return (
    <article className={styles.clip}>
      <video controls preload="metadata" src={clip.videoUrl} poster={clipPosterUrl(clip)} />
      <div className={styles.clipBody}>
        <small>{clipMetaText(clip)}</small>
        {clip.title && <h3>{clip.title}</h3>}
        {clip.hookText && <p className={styles.hook}><span>Hook</span>{clip.hookText}</p>}
        {clip.description && <p className={styles.description}>{clip.description}</p>}
        <div className={styles.clipActions}>
          {clip.downloadUrl && <a className="btn" href={clip.downloadUrl} download>Unduh MP4</a>}
          <button type="button" className="btn" onClick={onCopy}>{copied === "ok" ? "Tersalin" : "Salin caption"}</button>
        </div>
        {copied === "failed" && <p className={styles.fieldError}>Tidak bisa menyalin di browser ini. Salin dari halaman proyek.</p>}
      </div>
    </article>
  );
}

export default function DashboardPage() {
  const [sourceType, setSourceType] = useState("youtube");
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [video, setVideo] = useState(null);
  const [renderMode, setRenderMode] = useState("fit-blur");
  const [limit, setLimit] = useState("3");
  const [minDuration, setMinDuration] = useState("20");
  const [maxDuration, setMaxDuration] = useState("60");
  const [coldOpen, setColdOpen] = useState(true);
  const [hookOverlay, setHookOverlay] = useState(true);
  const [captionStyle, setCaptionStyle] = useState("karaoke");
  const [focusTerms, setFocusTerms] = useState([]);
  const [focusDraft, setFocusDraft] = useState("");
  const [focusNote, setFocusNote] = useState("");
  const [focusError, setFocusError] = useState("");
  const [problems, setProblems] = useState({});
  const [aiStatus, setAiStatus] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [jobsState, setJobsState] = useState("loading");
  const [activeId, setActiveId] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState(null);
  const [copied, setCopied] = useState(null);
  const [storageView, setStorageView] = useState(null);
  const storageRecovery = useRef(null);
  const resultsRef = useRef(null);
  const copiedTimer = useRef(null);
  const mounted = useRef(false);
  const jobsRefreshGeneration = useRef(0);

  const activeJob = useMemo(() => jobs.find((job) => job.id === activeId), [jobs, activeId]);
  const storage = storageView || storageStatusView(null);
  const storageBlocked = storage.submitBlocked;
  const ai = aiStatusView(aiStatus);
  const aiMode = focusAiMode(aiStatus);
  const failure = jobFailureView(activeJob);

  async function refreshJobs(selectedId = null, signal = undefined) {
    jobsRefreshGeneration.current += 1;
    const generation = jobsRefreshGeneration.current;
    try {
      const response = await fetch("/api/jobs", { cache: "no-store", signal });
      if (signal?.aborted || generation !== jobsRefreshGeneration.current) return;
      if (!response.ok) {
        setJobsState((current) => (current === "ready" ? current : "error"));
        return;
      }
      const payload = await response.json();
      if (signal?.aborted || generation !== jobsRefreshGeneration.current) return;
      setJobs(payload.jobs || []);
      setJobsState("ready");
      setActiveId((current) => selectedId || current || payload.jobs?.[0]?.id || null);
    } catch (error) {
      if (signal?.aborted || generation !== jobsRefreshGeneration.current) return;
      setJobsState((current) => (current === "ready" ? current : "error"));
      if (selectedId) throw error;
    }
  }

  async function refreshStorageStatus() {
    await storageRecovery.current?.retry();
  }

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void refreshJobs(null, controller.signal).catch(() => {});
    void (async () => {
      // Informative only: the worker decides at run time which AI (if any) picks the moments.
      let next = AI_STATUS_UNREADABLE;
      try {
        const response = await fetch("/api/llm/status", { cache: "no-store", signal: controller.signal });
        const payload = await response.json();
        if (payload?.llm && typeof payload.llm === "object" && typeof payload.llm.state === "string") next = payload.llm;
      } catch {
        // Fall through to "unreadable" unless the page is gone.
      }
      if (!controller.signal.aborted) setAiStatus(next);
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
    if (!activeId || jobFinished(activeJob)) return undefined;
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
    setMessage(null);
    const found = jobFormProblems({ sourceType, youtubeUrl, video, limit, minDuration, maxDuration });
    setProblems(found);
    const firstInvalid = Object.keys(FIELD_IDS).find((name) => found[name]);
    if (firstInvalid) {
      document.getElementById(FIELD_IDS[firstInvalid])?.focus();
      return;
    }
    const focus = focusFormFields({ terms: focusTerms, pending: focusDraft, note: focusNote });
    setFocusTerms(focus.terms);
    setFocusDraft(focus.pending);
    if (!focus.fields) {
      setFocusError(focus.error);
      document.getElementById("focus-terms-input")?.focus();
      return;
    }
    setSubmitting(true);
    try {
      const data = new FormData();
      data.set("renderMode", renderMode);
      data.set("limit", String(limit).trim());
      data.set("minDuration", String(minDuration).trim());
      data.set("maxDuration", String(maxDuration).trim());
      data.set("coldOpen", String(coldOpen));
      data.set("hookOverlay", String(hookOverlay));
      data.set("captionStyle", captionStyle);
      for (const [name, value] of Object.entries(focus.fields)) data.set(name, value);
      if (sourceType === "youtube") data.set("youtubeUrl", youtubeUrl.trim());
      else data.set("video", video);
      const response = await fetch("/api/jobs", { method: "POST", body: data });
      const payload = (await response.json().catch(() => null)) || {};
      if (!response.ok) {
        if (payload.jobId) {
          await recoverFailedJobSelection(payload.jobId, {
            select: setActiveId,
            refreshJobs,
          });
        }
        if ([507, 503].includes(response.status)) await refreshStorageStatus();
        setMessage({ tone: "error", text: submitErrorMessage(payload) });
        return;
      }
      setJobs((current) => [payload.job, ...current]);
      setJobsState("ready");
      setActiveId(payload.job.id);
      setMessage({ tone: "ok", text: "Job dibuat. Progresnya tampil di panel Hasil." });
      // On one column the Hasil panel sits below the form: bring the new job into view.
      if (window.matchMedia("(max-width: 900px)").matches) {
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        resultsRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
      }
    } catch {
      setMessage({ tone: "error", text: "Server tidak terjangkau. Periksa koneksi lalu coba lagi." });
    } finally {
      setSubmitting(false);
    }
  }

  async function copyCaption(clip) {
    const key = `${activeJob.id}-${clip.index}`;
    let result = "ok";
    try {
      await navigator.clipboard.writeText(clipCaptionText(clip));
    } catch {
      result = "failed";
    }
    if (!mounted.current) return;
    setCopied({ key, result, index: clip.index });
    if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => {
      copiedTimer.current = null;
      setCopied(null);
    }, result === "ok" ? 1800 : 6000);
  }

  function clearProblem(name) {
    if (problems[name]) setProblems(({ [name]: _removed, ...rest }) => rest);
  }

  const describedBy = (name, extra) => [extra, problems[name] ? `${FIELD_IDS[name]}-error` : null].filter(Boolean).join(" ") || undefined;

  return (
    <main>
      <AppHeader current="/dashboard" />

      <div className={`shell ${styles.head}`}>
        <h1>Buat klip</h1>
        <p>Satu video panjang jadi klip 9:16 dengan subtitle, teks hook, dan caption.</p>
      </div>

      {storageView && storage.warning && (
        <div className={`shell ${styles.banner} ${storage.unavailable ? styles.bannerWarning : styles.bannerDanger}`} role="alert">
          <div>
            <strong>{storageBlocked ? "Job baru dihentikan sementara" : "Status penyimpanan belum tersedia"}</strong>
            <span>{storageMessage(storage.admission.code)}</span>
          </div>
          <button type="button" className="btn" onClick={refreshStorageStatus}>Periksa lagi</button>
        </div>
      )}

      <div className={`shell ${styles.workspace}`}>
        <form className={`panel ${styles.form}`} onSubmit={submit} noValidate aria-label="Buat klip">
          <section className={styles.section} aria-labelledby="source-title">
            <h2 id="source-title" className={styles.sectionTitle}>Sumber video</h2>
            <div className={`segmented ${styles.segmented}`}>
              <button type="button" aria-pressed={sourceType === "youtube"} onClick={() => setSourceType("youtube")}>Link YouTube</button>
              <button type="button" aria-pressed={sourceType === "upload"} onClick={() => setSourceType("upload")}>Unggah file</button>
            </div>
            {sourceType === "youtube" ? (
              <div className={styles.field}>
                <label htmlFor="youtube-url">Link video</label>
                <input
                  id="youtube-url"
                  className={styles.input}
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  placeholder="https://youtu.be/…"
                  value={youtubeUrl}
                  aria-invalid={problems.youtubeUrl ? "true" : undefined}
                  aria-describedby={describedBy("youtubeUrl")}
                  onChange={(event) => { setYoutubeUrl(event.target.value); clearProblem("youtubeUrl"); }}
                />
                <FieldError id="youtube-url-error" message={problems.youtubeUrl} />
              </div>
            ) : (
              <div className={styles.field}>
                <label className={`${styles.drop} ${problems.video ? styles.dropInvalid : ""}`}>
                  <input
                    id="video-file"
                    type="file"
                    accept="video/mp4,video/quicktime,video/webm,.mkv,.m4v"
                    aria-invalid={problems.video ? "true" : undefined}
                    aria-describedby={describedBy("video", "video-file-help")}
                    onChange={(event) => { setVideo(event.target.files?.[0] || null); clearProblem("video"); }}
                  />
                  <strong>{video ? video.name : "Pilih file video"}</strong>
                  <small id="video-file-help">MP4, MOV, MKV atau WEBM. Batas ukuran mengikuti server.</small>
                </label>
                <FieldError id="video-file-error" message={problems.video} />
              </div>
            )}
          </section>

          <section className={styles.section} aria-labelledby="clips-title">
            <h2 id="clips-title" className={styles.sectionTitle}>Klip</h2>
            <div className={styles.numbers}>
              <div className={`${styles.field} ${styles.limitField}`}>
                <label htmlFor="clip-limit">Jumlah klip</label>
                <input id="clip-limit" className={styles.input} type="number" inputMode="numeric" min="1" max="10" step="1" value={limit} aria-invalid={problems.limit ? "true" : undefined} aria-describedby={describedBy("limit")} onChange={(event) => { setLimit(event.target.value); clearProblem("limit"); }} />
                <FieldError id="clip-limit-error" message={problems.limit} />
              </div>
              <div className={styles.field}>
                <label htmlFor="min-duration">Durasi minimum</label>
                <div className={styles.unit}>
                  <input id="min-duration" className={styles.input} type="number" inputMode="decimal" min="5" max="180" value={minDuration} aria-invalid={problems.minDuration ? "true" : undefined} aria-describedby={describedBy("minDuration", "duration-unit")} onChange={(event) => { setMinDuration(event.target.value); clearProblem("minDuration"); clearProblem("maxDuration"); }} />
                  <span aria-hidden="true">detik</span>
                </div>
                <FieldError id="min-duration-error" message={problems.minDuration} />
              </div>
              <div className={styles.field}>
                <label htmlFor="max-duration">Durasi maksimum</label>
                <div className={styles.unit}>
                  <input id="max-duration" className={styles.input} type="number" inputMode="decimal" min="5" max="180" value={maxDuration} aria-invalid={problems.maxDuration ? "true" : undefined} aria-describedby={describedBy("maxDuration", "duration-unit")} onChange={(event) => { setMaxDuration(event.target.value); clearProblem("maxDuration"); }} />
                  <span aria-hidden="true">detik</span>
                </div>
                <FieldError id="max-duration-error" message={problems.maxDuration} />
              </div>
            </div>
            <p id="duration-unit" className="visuallyHidden">Dalam detik.</p>
          </section>

          <fieldset className={styles.section}>
            <legend className={styles.sectionTitle}>Layout</legend>
            <div className={styles.choices}>
              {layouts.map((layout) => (
                <label key={layout.id} className={`${styles.choice} ${renderMode === layout.id ? styles.selected : ""}`}>
                  <input type="radio" name="renderMode" value={layout.id} checked={renderMode === layout.id} onChange={() => setRenderMode(layout.id)} />
                  <span className={`${styles.frame} ${styles[layout.id]}`} aria-hidden="true"><i /></span>
                  <span className={styles.choiceText}><strong>{layout.name}</strong><small>{layout.description}</small></span>
                </label>
              ))}
            </div>
          </fieldset>

          <section className={styles.section} aria-labelledby="look-title">
            <h2 id="look-title" className={styles.sectionTitle}>Tampilan klip</h2>
            <fieldset className={styles.group}>
              <legend className={styles.groupTitle}>Gaya subtitle</legend>
              <div className={`${styles.choices} ${styles.pair}`}>
                {captionStyles.map((style) => (
                  <label key={style.id} className={`${styles.choice} ${styles.compact} ${captionStyle === style.id ? styles.selected : ""}`}>
                    <input type="radio" name="captionStyle" value={style.id} checked={captionStyle === style.id} onChange={() => setCaptionStyle(style.id)} />
                    <span className={styles.choiceText}><strong>{style.name}</strong><small>{style.description}</small></span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className={styles.toggles}>
              <label className={styles.toggle}>
                <input type="checkbox" checked={coldOpen} onChange={(event) => setColdOpen(event.target.checked)} />
                <span className={styles.choiceText}><strong>Buka dengan kalimat terkuat</strong><small>Kalimat hook diputar dulu beberapa detik, lalu klip mulai dari awal.</small></span>
              </label>
              <label className={styles.toggle}>
                <input type="checkbox" checked={hookOverlay} onChange={(event) => setHookOverlay(event.target.checked)} />
                <span className={styles.choiceText}><strong>Teks hook di 4 detik pertama</strong><small>Kalimat pemancing singkat di bagian atas layar.</small></span>
              </label>
            </div>
          </section>

          <section className={styles.section} aria-labelledby="moments-title">
            <h2 id="moments-title" className={styles.sectionTitle}>Momen</h2>
            <p className={`${styles.aiStatus} ${styles[ai.tone] || ""}`} role="status">
              <i aria-hidden="true" />
              <span>{ai.text}</span>
              <a href="/settings">Atur AI</a>
            </p>
            <FocusField
              terms={focusTerms}
              draft={focusDraft}
              note={focusNote}
              error={focusError}
              aiMode={aiMode}
              onTermsChange={setFocusTerms}
              onDraftChange={setFocusDraft}
              onNoteChange={setFocusNote}
              onErrorChange={setFocusError}
            />
          </section>

          <div className={styles.submitRow}>
            <button type="submit" className={styles.submit} disabled={submitting || storageBlocked}>{submitting ? "Membuat job…" : "Buat klip"}</button>
            {message && <p className={`${styles.message} ${message.tone === "error" ? styles.messageError : ""}`} role={message.tone === "error" ? "alert" : "status"}>{message.text}</p>}
          </div>
        </form>

        <aside ref={resultsRef} className={`panel ${styles.results}`} aria-labelledby="results-title">
          <div className={styles.resultsHead}>
            <h2 id="results-title">Hasil</h2>
            <a href="/projects">Semua riwayat</a>
          </div>

          {jobsState === "loading" && !activeJob && (
            <div className={styles.state} role="status"><strong>Memuat job terakhir…</strong></div>
          )}
          {jobsState === "error" && !activeJob && (
            <div className={styles.state} role="alert">
              <strong>Job terakhir tidak bisa dimuat.</strong>
              <p>Periksa koneksi ke server, lalu muat ulang.</p>
              <button type="button" className="btn" onClick={() => { setJobsState("loading"); void refreshJobs().catch(() => {}); }}>Muat ulang</button>
            </div>
          )}
          {jobsState === "ready" && !activeJob && (
            <div className={styles.state}>
              <strong>Belum ada job</strong>
              <p>Isi form lalu tekan Buat klip. Progres dan klipnya muncul di sini.</p>
            </div>
          )}

          {activeJob && (
            <div className={styles.job}>
              <div className={`${styles.jobState} ${styles[activeJob.status] || ""}`}>
                <div>
                  <small title={jobSourceLabel(activeJob)}>{jobSourceLabel(activeJob)}</small>
                  <strong>{jobStageText(activeJob)}</strong>
                </div>
                {jobPercentText(activeJob) && <b>{jobPercentText(activeJob)}</b>}
              </div>
              <div className={`${styles.progress} ${jobFinished(activeJob) ? styles.progressDone : ""} ${activeJob.status === "failed" ? styles.progressFailed : ""}`} role="progressbar" aria-label="Progres job" aria-valuemin="0" aria-valuemax="100" aria-valuenow={activeJob.progress || 0}><i style={{ width: `${activeJob.progress || 0}%` }} /></div>
              {!jobFinished(activeJob) && (
                <p className={`${styles.activity} ${activeJob.status === "queued" ? styles.queued : ""}`} role="status" aria-live="polite"><i aria-hidden="true" /><span>{jobActivityText(activeJob)}</span></p>
              )}
              {failure && (
                <div className={styles.failure} role="alert">
                  <strong>{failure.text}</strong>
                  {failure.detail && (
                    <details>
                      <summary>Detail teknis</summary>
                      <p>{failure.detail}</p>
                    </details>
                  )}
                </div>
              )}
              <div className={styles.clips}>
                {activeJob.clips?.map((clip) => (
                  <ClipCard key={clip.index} clip={clip} copied={copied?.key === `${activeJob.id}-${clip.index}` ? copied.result : null} onCopy={() => copyCaption(clip)} />
                ))}
              </div>
              {!activeJob.clips?.length && !failure && (
                <p className={styles.waiting}>Klip muncul di sini setelah selesai dirender.</p>
              )}
              <a className={styles.projectLink} href={`/projects/${activeJob.id}`}>Buka proyek</a>
              <p className="visuallyHidden" role="status">{copied?.result === "ok" ? `Caption klip ${copied.index} tersalin.` : ""}</p>
            </div>
          )}

          {jobs.length > 1 && (
            <section className={styles.history} aria-labelledby="history-title">
              <h3 id="history-title">Job terakhir</h3>
              <ul>
                {jobs.slice(0, 8).map((job) => (
                  <li key={job.id}>
                    <button type="button" aria-pressed={job.id === activeId} onClick={() => setActiveId(job.id)}>
                      <span>{jobSourceLabel(job)}</span>
                      <b className={styles[`status_${job.status}`]}>{JOB_STATUS_LABELS[job.status] || "Memproses"}</b>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </main>
  );
}
