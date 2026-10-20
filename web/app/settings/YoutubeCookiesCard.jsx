"use client";

// Pengaturan "Cookies YouTube": upload one cookies.txt, see how many cookies were kept, replace or
// remove it. Loaded on its own, like "Logo bawaan": the AI form failing must not hide it. The file
// goes to the server as is; the browser never reads it and the server never sends a cookie back.
import { useEffect, useRef, useState } from "react";

import {
  COOKIES_ACCEPT,
  MAX_COOKIES_UPLOAD_BYTES,
  cookiesCountText,
  cookiesErrorMessage,
  cookiesSavedMessage,
  cookiesUploadedText,
  youtubeCookiesCopy,
  youtubeCookiesState,
} from "../../lib/youtube-cookies-view.mjs";

const ENDPOINT = "/api/settings/youtube-cookies";
const COPY = youtubeCookiesCopy();
const LOAD_FAILED = "Cookies YouTube tidak bisa dimuat.";

async function send(method, file) {
  const response = await fetch(ENDPOINT, {
    method,
    cache: "no-store",
    headers: file ? { "Content-Type": "text/plain" } : undefined,
    body: file,
  });
  const payload = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, payload };
}

export default function YoutubeCookiesCard() {
  const [phase, setPhase] = useState("loading");
  const [state, setState] = useState(() => youtubeCookiesState(null));
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef(null);
  const alive = useRef(true);

  async function load() {
    setPhase("loading");
    setMessage(null);
    try {
      const answer = await send("GET");
      if (!alive.current) return;
      if (answer.ok && answer.payload) {
        setState(youtubeCookiesState(answer.payload));
        setPhase("ready");
      } else {
        setMessage({ tone: "error", text: answer.status === 401 ? cookiesErrorMessage({ status: 401 }) : LOAD_FAILED });
        setPhase("error");
      }
    } catch {
      if (!alive.current) return;
      setMessage({ tone: "error", text: LOAD_FAILED });
      setPhase("error");
    }
  }

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, []);

  const cookies = state.cookies;
  const canUpload = phase === "ready" && state.secretConfigured && busy === null;

  async function upload(file) {
    if (!file || !canUpload) return;
    if (file.size === 0 || file.size > MAX_COOKIES_UPLOAD_BYTES) {
      setMessage({ tone: "error", text: cookiesErrorMessage({ code: file.size === 0 ? "cookies_empty" : "cookies_too_large" }) });
      return;
    }
    setMessage(null);
    setBusy("upload");
    try {
      const answer = await send("POST", file);
      if (!alive.current) return;
      const next = youtubeCookiesState(answer.payload);
      if (answer.ok && next.cookies) {
        setState(next);
        setMessage({ tone: "ok", text: cookiesSavedMessage(answer.payload) });
      } else {
        setMessage({ tone: "error", text: cookiesErrorMessage({ status: answer.status, code: answer.payload?.code }) });
      }
    } catch {
      if (alive.current) setMessage({ tone: "error", text: cookiesErrorMessage({ status: 0 }) });
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  async function remove() {
    if (busy !== null) return;
    setMessage(null);
    setBusy("remove");
    try {
      const answer = await send("DELETE");
      if (!alive.current) return;
      if (answer.ok && answer.payload) {
        setState(youtubeCookiesState(answer.payload));
        setMessage({ tone: "ok", text: "Cookies dihapus. Unduhan berikutnya berjalan tanpa cookies." });
      } else {
        setMessage({ tone: "error", text: answer.status === 401 ? cookiesErrorMessage({ status: 401 }) : "Cookies gagal dihapus. Coba lagi." });
      }
    } catch {
      if (alive.current) setMessage({ tone: "error", text: cookiesErrorMessage({ status: 0 }) });
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  const choose = () => inputRef.current?.click();
  const onFiles = (files) => {
    const file = files?.[0];
    if (inputRef.current) inputRef.current.value = "";
    if (file) void upload(file);
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

  const unreadable = state.secretConfigured && (state.problem === "unreadable" || state.problem === "corrupt");
  const uploaded = cookies ? cookiesUploadedText(cookies) : null;

  return (
    <section className="panel settingsCard cookiesCard" aria-labelledby="youtube-cookies-title" aria-busy={busy !== null || phase === "loading"}
      onDragOver={onDragOver} onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
      <div className="settingsCardHead">
        <h2 id="youtube-cookies-title">Cookies YouTube</h2>
        <p>{COPY.where}</p>
      </div>

      {phase === "loading" && <p className="systemState" role="status">Memuat cookies YouTube…</p>}
      {phase === "error" && (
        <div className="systemState error" role="alert">
          <p>{message?.text}</p>
          <button type="button" className="btn" onClick={() => void load()}>Coba lagi</button>
        </div>
      )}

      {phase === "ready" && (
        <>
          <div className="cookiesBody" data-over={dragOver ? "true" : "false"}>
            <div className="cookiesText">
              <strong className="cookiesCount">{cookies ? cookiesCountText(cookies) : "Belum ada cookies"}</strong>
              <span className="cookiesMeta">{cookies ? uploaded : COPY.hint}</span>
            </div>
            <div className="cookiesActions">
              <button type="button" className="btn" onClick={choose} disabled={!canUpload}>
                {busy === "upload" ? "Memeriksa…" : cookies ? "Ganti file" : "Pilih file"}
              </button>
              {(cookies || state.problem) && (
                <button type="button" className="btn danger" onClick={remove} disabled={busy !== null}>
                  {busy === "remove" ? "Menghapus…" : "Hapus"}
                </button>
              )}
              <input ref={inputRef} type="file" accept={COOKIES_ACCEPT} hidden tabIndex={-1} aria-hidden="true"
                onChange={(event) => onFiles(event.target.files)} />
            </div>
          </div>

          {!state.secretConfigured && <p className="notice error settingsNotice" role="alert">{COPY.secretMissing}</p>}
          {unreadable && <p className="notice error settingsNotice" role="alert">{COPY.unreadable}</p>}
          {cookies && !cookies.signedIn && !state.problem && <p className="notice warning settingsNotice">{COPY.notSignedIn}</p>}

          {message && (message.tone === "error"
            ? <p className="notice error settingsNotice" role="alert">{message.text}</p>
            : <p className={`cookiesStatus ${message.tone}`} role="status">{message.text}</p>)}

          <ul className="cookiesFacts">
            {COPY.facts.map((fact) => <li key={fact}>{fact}</li>)}
          </ul>
        </>
      )}
    </section>
  );
}
