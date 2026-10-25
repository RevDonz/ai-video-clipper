"use client";

// Pengaturan → YouTube → cookies.txt: upload one file, see how many cookies were kept, replace or
// remove it. The upload saves the moment a file is picked, so this card is not part of the save
// bar. The file goes to the server as is; the browser never reads it and the server never sends a
// cookie back.
import { Button } from "@heroui/react";
import { useEffect, useRef, useState } from "react";
import { useFormatter, useTranslations } from "use-intl";

import {
  COOKIES_ACCEPT,
  MAX_COOKIES_UPLOAD_BYTES,
  cookiesCountText,
  cookiesErrorMessage,
  cookiesSavedMessage,
  cookiesUploadedText,
  youtubeCookiesState,
} from "../../lib/youtube-cookies-view.mjs";
import { CardLoadError, CardLoading, CardNotice } from "./CardState.jsx";
import { useViewText } from "./view-text.jsx";

const ENDPOINT = "/api/settings/youtube-cookies";

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
  const t = useTranslations("settings");
  const format = useFormatter();
  const text = useViewText();
  const [phase, setPhase] = useState("loading");
  const [state, setState] = useState(() => youtubeCookiesState(null));
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef(null);
  const alive = useRef(true);

  // "42 cookie YouTube tersimpan. Dibuang: 120 dari situs lain, 1 kedaluwarsa."
  const savedText = (answer) => {
    const { saved, dropped } = cookiesSavedMessage(answer);
    if (!dropped.length) return text(saved);
    return `${text(saved)} ${t("youtube.droppedList", { list: format.list(dropped.map(text), { type: "unit" }) })}`;
  };

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
        setMessage({ tone: "error", text: answer.status === 401 ? text(cookiesErrorMessage({ status: 401 })) : t("youtube.loadFailed") });
        setPhase("error");
      }
    } catch {
      if (!alive.current) return;
      setMessage({ tone: "error", text: t("youtube.loadFailed") });
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
      setMessage({ tone: "error", text: text(cookiesErrorMessage({ code: file.size === 0 ? "cookies_empty" : "cookies_too_large" })) });
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
        setMessage({ tone: "ok", text: savedText(answer.payload) });
      } else {
        setMessage({ tone: "error", text: text(cookiesErrorMessage({ status: answer.status, code: answer.payload?.code })) });
      }
    } catch {
      if (alive.current) setMessage({ tone: "error", text: text(cookiesErrorMessage({ status: 0 })) });
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
        setMessage({ tone: "ok", text: t("youtube.removed") });
      } else {
        setMessage({ tone: "error", text: answer.status === 401 ? text(cookiesErrorMessage({ status: 401 })) : t("youtube.removeFailed") });
      }
    } catch {
      if (alive.current) setMessage({ tone: "error", text: text(cookiesErrorMessage({ status: 0 })) });
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
    <section className="settingsCard" aria-labelledby="youtube-cookies-title" aria-busy={busy !== null || phase === "loading"}
      onDragOver={onDragOver} onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
      <h2 id="youtube-cookies-title" className="settingsCardTitle">{t("youtube.cookies")}</h2>

      {phase === "loading" && <CardLoading label={t("common.loading")} />}
      {phase === "error" && <CardLoadError message={message?.text} onRetry={() => void load()} />}

      {phase === "ready" && (
        <div className="settingsStack">
          <div className="settingsMedia" data-over={dragOver ? "true" : "false"}>
            <div className="settingsMediaText">
              <strong>{cookies ? text(cookiesCountText(cookies)) : t("youtube.empty")}</strong>
              <span className="settingsMuted">{cookies ? text(uploaded) : t("youtube.hint")}</span>
            </div>
            <div className="settingsRow">
              <Button variant="secondary" onPress={choose} isDisabled={!canUpload}>
                {busy === "upload" ? t("youtube.checking") : cookies ? t("youtube.replace") : t("youtube.choose")}
              </Button>
              {(cookies || state.problem) && (
                <Button variant="danger" onPress={remove} isDisabled={busy !== null}>
                  {busy === "remove" ? t("common.removing") : t("common.remove")}
                </Button>
              )}
              <input ref={inputRef} type="file" accept={COOKIES_ACCEPT} hidden tabIndex={-1} aria-hidden="true"
                onChange={(event) => onFiles(event.target.files)} />
            </div>
          </div>

          {!state.secretConfigured && <CardNotice tone="error">{t("youtube.secretMissing")}</CardNotice>}
          {unreadable && <CardNotice tone="error">{t("youtube.unreadable")}</CardNotice>}
          {cookies && !cookies.signedIn && !state.problem && <CardNotice tone="warning">{t("youtube.notSignedIn")}</CardNotice>}

          {message && (message.tone === "error"
            ? <CardNotice tone="error">{message.text}</CardNotice>
            : <p className="settingsStatus" data-tone={message.tone} role="status">{message.text}</p>)}

          <ul className="settingsFacts">
            <li>{t("youtube.facts.separate")}</li>
            <li>{t("youtube.facts.encrypted")}</li>
            <li>{t("youtube.facts.expire")}</li>
          </ul>
        </div>
      )}
    </section>
  );
}
