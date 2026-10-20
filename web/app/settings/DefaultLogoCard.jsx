"use client";

// Pengaturan "Logo bawaan" (plan 2026-10-20 A6): upload one logo, see it, replace or remove it.
// Loaded on its own, like "Tentang sistem": the AI form failing must not hide it.
import { useEffect, useRef, useState } from "react";

import {
  DEFAULT_LOGO_ACCEPT,
  defaultLogoCopy,
  defaultLogoState,
  defaultLogoUploadError,
  logoSize,
} from "../../lib/default-logo-view.mjs";
import { uploadDefaultLogo } from "../../lib/editor/upload-client.mjs";

const SESSION_TEXT = "Sesi login berakhir. Muat ulang halaman untuk masuk lagi.";

export default function DefaultLogoCard() {
  const [phase, setPhase] = useState("loading");
  const [state, setState] = useState(() => defaultLogoState(null));
  const [progress, setProgress] = useState(null);
  const [removing, setRemoving] = useState(false);
  const [message, setMessage] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [thumbFailed, setThumbFailed] = useState(null);
  const inputRef = useRef(null);
  const running = useRef(null);
  const alive = useRef(true);

  async function load() {
    setPhase("loading");
    try {
      const response = await fetch("/api/settings/logo", { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!alive.current) return;
      if (response.ok && payload) {
        setState(defaultLogoState(payload));
        setPhase("ready");
      } else {
        setMessage({ tone: "error", text: response.status === 401 ? SESSION_TEXT : "Logo bawaan tidak bisa dimuat." });
        setPhase("error");
      }
    } catch {
      if (!alive.current) return;
      setMessage({ tone: "error", text: "Logo bawaan tidak bisa dimuat." });
      setPhase("error");
    }
  }

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      running.current?.abort();
    };
  }, []);

  const busy = progress !== null || removing;
  const canUpload = phase === "ready" && state.enabled && !busy;
  const copy = defaultLogoCopy({ autoClips: state.autoClips });
  const logo = state.logo;

  async function start(file) {
    if (!file || !canUpload) return;
    setMessage(null);
    const controller = new AbortController();
    running.current = controller;
    setProgress({ name: file.name, fraction: 0, processing: false });
    try {
      const dto = await uploadDefaultLogo(file, {
        signal: controller.signal,
        onProgress: (fraction, info) => {
          if (alive.current) setProgress({ name: file.name, fraction, processing: info?.phase === "processing" });
        },
      });
      if (!alive.current) return;
      setState((current) => defaultLogoState({ ...current, logo: dto }));
      setMessage({ tone: "ok", text: "Logo bawaan tersimpan." });
    } catch (error) {
      if (!alive.current) return;
      const mapped = defaultLogoUploadError(error);
      setMessage({ tone: mapped.cancelled ? "info" : "error", text: mapped.message });
    } finally {
      if (running.current === controller) running.current = null;
      if (alive.current) setProgress(null);
    }
  }

  async function remove() {
    if (busy || !logo) return;
    setMessage(null);
    setRemoving(true);
    try {
      const response = await fetch("/api/settings/logo", { method: "DELETE", cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!alive.current) return;
      if (response.ok && payload) {
        setState(defaultLogoState(payload));
        setMessage({ tone: "ok", text: "Logo bawaan dihapus. Klip yang sudah dibuat tetap memakai logonya." });
      } else {
        setMessage({ tone: "error", text: response.status === 401 ? SESSION_TEXT : "Logo bawaan gagal dihapus. Coba lagi." });
      }
    } catch {
      if (alive.current) setMessage({ tone: "error", text: "Koneksi terputus. Coba lagi." });
    } finally {
      if (alive.current) setRemoving(false);
    }
  }

  const choose = () => inputRef.current?.click();
  const onFiles = (files) => {
    const file = files?.[0];
    if (inputRef.current) inputRef.current.value = "";
    if (file) void start(file);
  };
  const onDragOver = (event) => {
    if (!canUpload || !event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault();
    setDragOver(true);
  };
  const onDrop = (event) => {
    if (!canUpload) return;
    event.preventDefault();
    setDragOver(false);
    onFiles(event.dataTransfer?.files);
  };

  const percent = progress ? Math.round(progress.fraction * 100) : 0;
  const thumbOk = logo && thumbFailed !== logo.url;

  return (
    <section className="panel settingsCard logoCard" aria-labelledby="default-logo-title" aria-busy={busy || phase === "loading"}
      onDragOver={onDragOver} onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
      <div className="settingsCardHead">
        <h2 id="default-logo-title">Logo bawaan</h2>
        <p>{copy.where}</p>
      </div>

      {phase === "loading" && <p className="systemState" role="status">Memuat logo bawaan…</p>}
      {phase === "error" && (
        <div className="systemState error" role="alert">
          <p>{message?.text}</p>
          <button type="button" className="btn" onClick={() => { setMessage(null); void load(); }}>Coba lagi</button>
        </div>
      )}

      {phase === "ready" && (
        <>
          <div className="logoBody" data-over={dragOver ? "true" : "false"}>
            <div className={logo ? "logoThumb" : "logoThumb empty"}>
              {thumbOk && <img key={logo.url} src={logo.url} alt="Pratinjau logo bawaan" draggable={false} onError={() => setThumbFailed(logo.url)} />}
            </div>
            <div className="logoText">
              {logo ? (
                <>
                  <strong className="logoName">{logo.name ?? "Logo bawaan"}</strong>
                  <span className="logoMeta">{logoSize(logo)}</span>
                </>
              ) : (
                <>
                  <strong className="logoName">Belum ada logo</strong>
                  <span className="logoMeta">{copy.hint}</span>
                </>
              )}
              <div className="logoActions">
                <button type="button" className="btn" onClick={choose} disabled={!canUpload}>
                  {logo ? "Ganti logo" : "Pilih logo"}
                </button>
                {logo && (
                  <button type="button" className="btn danger" onClick={remove} disabled={busy}>
                    {removing ? "Menghapus…" : "Hapus"}
                  </button>
                )}
                <input ref={inputRef} type="file" accept={DEFAULT_LOGO_ACCEPT} hidden tabIndex={-1} aria-hidden="true"
                  onChange={(event) => onFiles(event.target.files)} />
              </div>
            </div>
          </div>

          {progress && (
            <div className="logoProgress">
              <div className="logoProgressHead">
                <span className="logoProgressName">{progress.processing ? "Memproses gambar…" : `Mengunggah ${progress.name}`}</span>
                {!progress.processing && <span>{`${percent}%`}</span>}
              </div>
              <div className="logoTrack" role="progressbar" aria-label="Unggahan logo bawaan" aria-valuemin={0} aria-valuemax={100}
                aria-valuenow={percent} aria-valuetext={progress.processing ? "Memproses gambar" : `${percent}%`}>
                <div className="logoBar" style={{ width: `${percent}%` }} />
              </div>
              <button type="button" className="btn ghost" onClick={() => running.current?.abort()}>Batalkan unggahan</button>
            </div>
          )}

          {message && (message.tone === "error"
            ? <p className="notice error settingsNotice" role="alert">{message.text}</p>
            : <p className={`logoStatus ${message.tone}`} role="status">{message.text}</p>)}

          {!state.enabled && <p className="notice settingsNotice">Unggah logo belum diaktifkan di server ini.</p>}

          <ul className="logoFacts">
            <li>{copy.reach}</li>
            <li>{copy.perClip}</li>
          </ul>
        </>
      )}
    </section>
  );
}
