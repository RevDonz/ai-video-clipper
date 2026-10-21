"use client";

// Pengaturan "Transkripsi": the opt-in switch that sends a video's audio to Groq, and the Groq key
// when Pengaturan AI has none for api.groq.com. Loaded on its own, like "Cookies YouTube": the AI
// form failing must not hide it. Every change saves at once; the server never sends a key back.
import { useEffect, useRef, useState } from "react";

import {
  GROQ_KEY_URL,
  transcriptionCopy,
  transcriptionErrorMessage,
  transcriptionNotice,
  transcriptionSavedMessage,
  transcriptionState,
} from "../../lib/transcription-settings-view.mjs";

const ENDPOINT = "/api/settings/transcription";
const COPY = transcriptionCopy();
const LOAD_FAILED = "Pengaturan transkripsi tidak bisa dimuat.";

async function send(method, body) {
  const response = await fetch(ENDPOINT, {
    method,
    cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, payload };
}

export default function TranscriptionCard() {
  const [phase, setPhase] = useState("loading");
  const [state, setState] = useState(() => transcriptionState(null));
  const [busy, setBusy] = useState(null);
  const [pending, setPending] = useState(null);
  const [keyValue, setKeyValue] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [message, setMessage] = useState(null);
  const alive = useRef(true);

  async function load() {
    setPhase("loading");
    setMessage(null);
    try {
      const answer = await send("GET");
      if (!alive.current) return;
      if (answer.ok && answer.payload) {
        setState(transcriptionState(answer.payload));
        setPhase("ready");
      } else {
        setMessage({ tone: "error", text: answer.status === 401 ? transcriptionErrorMessage({ status: 401 }) : LOAD_FAILED });
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

  async function save(kind, enabled, apiKey, done) {
    if (busy !== null) return;
    setMessage(null);
    setBusy(kind);
    if (kind === "toggle") setPending(enabled);
    try {
      const answer = await send("PUT", { enabled, apiKey });
      if (!alive.current) return;
      if (answer.ok && answer.payload) {
        const next = transcriptionState(answer.payload);
        setState(next);
        setKeyValue("");
        setReplacing(false);
        setMessage({ tone: "ok", text: done ?? transcriptionSavedMessage(next) });
      } else {
        setMessage({ tone: "error", text: transcriptionErrorMessage({ status: answer.status, code: answer.payload?.code, error: answer.payload?.error }) });
      }
    } catch {
      if (alive.current) setMessage({ tone: "error", text: transcriptionErrorMessage({ status: 0 }) });
    } finally {
      if (alive.current) {
        setBusy(null);
        setPending(null);
      }
    }
  }

  const onToggle = (event) => void save("toggle", event.target.checked, { action: "keep" });
  const onSaveKey = (event) => {
    event.preventDefault();
    const value = keyValue.trim();
    if (value) void save("key", state.enabled, { action: "replace", value }, "API key tersimpan.");
  };
  const onRemoveKey = () => void save("remove", state.enabled, { action: "clear" }, "API key dihapus.");

  const notice = phase === "ready" ? transcriptionNotice(state) : null;
  const unreadable = state.key === "unreadable" && state.ownKey;
  const showSaved = state.ownKey && !replacing;

  return (
    <section className="panel settingsCard transcriptionCard" aria-labelledby="transcription-title" aria-busy={busy !== null || phase === "loading"}>
      <div className="settingsCardHead">
        <h2 id="transcription-title">Transkripsi</h2>
        <p>{COPY.where}</p>
      </div>

      {phase === "loading" && <p className="systemState" role="status">Memuat pengaturan transkripsi…</p>}
      {phase === "error" && (
        <div className="systemState error" role="alert">
          <p>{message?.text}</p>
          <button type="button" className="btn" onClick={() => void load()}>Coba lagi</button>
        </div>
      )}

      {phase === "ready" && (
        <>
          <label className="settingsToggle">
            <input type="checkbox" checked={pending ?? state.enabled} disabled={busy !== null} onChange={onToggle} aria-describedby="transcription-privacy" />
            <span>
              <strong>{COPY.toggle}</strong>
              <small id="transcription-privacy">{COPY.privacy}</small>
            </span>
          </label>

          <div className="transcriptionKey">
            {state.llmKey ? (
              <div className="transcriptionKeySource">
                <p>{COPY.llmKey}</p>
                {state.ownKey && (
                  <button type="button" className="btn" onClick={onRemoveKey} disabled={busy !== null}>
                    {busy === "remove" ? "Menghapus…" : "Hapus key di sini"}
                  </button>
                )}
              </div>
            ) : showSaved ? (
              <div className="settingsField">
                <span id="transcription-key-label">{COPY.keyLabel}</span>
                <div className={`keyState ${unreadable ? "error" : "ok"}`} role="group" aria-labelledby="transcription-key-label">
                  <span>{unreadable ? "Tidak bisa dibuka" : COPY.keySaved}</span>
                  <button type="button" className="btn" onClick={() => setReplacing(true)} disabled={busy !== null || !state.secretConfigured}>
                    {unreadable ? "Isi ulang" : "Ganti"}
                  </button>
                  <button type="button" className="btn" onClick={onRemoveKey} disabled={busy !== null}>
                    {busy === "remove" ? "Menghapus…" : "Hapus"}
                  </button>
                </div>
              </div>
            ) : (
              <form className="settingsField" onSubmit={onSaveKey}>
                <label htmlFor="transcription-key">{COPY.keyLabel}</label>
                <div className="inlineRow">
                  <input
                    id="transcription-key"
                    type="password"
                    value={keyValue}
                    placeholder={state.ownKey ? "Tempel API key baru" : "Tempel API key"}
                    autoComplete="new-password"
                    spellCheck={false}
                    autoCapitalize="off"
                    disabled={!state.secretConfigured || busy !== null}
                    aria-describedby="transcription-key-help"
                    onChange={(event) => setKeyValue(event.target.value)}
                  />
                  <button type="submit" className="btn" disabled={!keyValue.trim() || busy !== null}>
                    {busy === "key" ? "Menyimpan…" : "Simpan key Groq"}
                  </button>
                  {state.ownKey && (
                    <button type="button" className="btn" onClick={() => { setReplacing(false); setKeyValue(""); }} disabled={busy !== null}>Batal</button>
                  )}
                </div>
                <small id="transcription-key-help">
                  {COPY.keyHelp}{" "}
                  <a href={GROQ_KEY_URL} target="_blank" rel="noopener noreferrer">Ambil API key ↗</a>
                </small>
              </form>
            )}
          </div>

          {notice && <p className={`notice ${notice.tone} settingsNotice`} role={notice.tone === "error" ? "alert" : undefined}>{notice.text}</p>}
          {message && (message.tone === "error"
            ? <p className="notice error settingsNotice" role="alert">{message.text}</p>
            : <p className="transcriptionStatus ok" role="status">{message.text}</p>)}
        </>
      )}
    </section>
  );
}
