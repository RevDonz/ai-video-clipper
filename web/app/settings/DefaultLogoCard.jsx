"use client";

// Pengaturan → Tampilan → Logo (plan 2026-10-20 A6): upload one logo, see it, replace or remove it.
// An upload saves the moment a file is picked (05-ui-dashboard.md §6.10), so this card is not part
// of the save bar. Loaded on its own: another card failing must not hide it.
import { Button, ProgressBar } from "@heroui/react";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";

import { DEFAULT_LOGO_ACCEPT, defaultLogoCopy, defaultLogoState, defaultLogoUploadError, logoSize } from "../../lib/default-logo-view.mjs";
import { uploadDefaultLogo } from "../../lib/editor/upload-client.mjs";
import { CardLoadError, CardLoading, CardNotice } from "./CardState.jsx";
import { useViewText } from "./view-text.jsx";

export default function DefaultLogoCard() {
  const t = useTranslations("settings");
  const text = useViewText();
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
        setMessage({ tone: "error", text: response.status === 401 ? t("common.error.session") : t("appearance.logoLoadFailed") });
        setPhase("error");
      }
    } catch {
      if (!alive.current) return;
      setMessage({ tone: "error", text: t("appearance.logoLoadFailed") });
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
      setMessage({ tone: "ok", text: t("appearance.logoSaved") });
    } catch (error) {
      if (!alive.current) return;
      const mapped = defaultLogoUploadError(error);
      setMessage({ tone: mapped.cancelled ? "info" : "error", text: mapped.key ? text(mapped) : mapped.message });
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
        setMessage({ tone: "ok", text: t("appearance.logoRemoved") });
      } else {
        setMessage({ tone: "error", text: response.status === 401 ? t("common.error.session") : t("appearance.logoRemoveFailed") });
      }
    } catch {
      if (alive.current) setMessage({ tone: "error", text: t("common.error.offline") });
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
    <section className="settingsCard" aria-labelledby="default-logo-title" aria-busy={busy || phase === "loading"}
      onDragOver={onDragOver} onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
      <h2 id="default-logo-title" className="settingsCardTitle">{t("appearance.logo")}</h2>

      {phase === "loading" && <CardLoading label={t("common.loading")} />}
      {phase === "error" && <CardLoadError message={message?.text} onRetry={() => { setMessage(null); void load(); }} />}

      {phase === "ready" && (
        <div className="settingsStack">
          <div className="settingsMedia" data-over={dragOver ? "true" : "false"}>
            <div className="settingsThumb" data-empty={logo ? undefined : "true"}>
              {thumbOk && <img key={logo.url} src={logo.url} alt={t("appearance.logoPreview")} draggable={false} onError={() => setThumbFailed(logo.url)} />}
            </div>
            <div className="settingsMediaText">
              <strong>{logo ? logo.name ?? t("appearance.logo") : t("appearance.logoEmpty")}</strong>
              <span className="settingsMuted">{logo ? text(logoSize(logo)) : text(copy.hint)}</span>
              <div className="settingsRow">
                <Button variant="secondary" onPress={choose} isDisabled={!canUpload}>
                  {logo ? t("appearance.logoReplace") : t("appearance.logoChoose")}
                </Button>
                {logo && (
                  <Button variant="danger" onPress={remove} isDisabled={busy}>
                    {removing ? t("common.removing") : t("common.remove")}
                  </Button>
                )}
                <input ref={inputRef} type="file" accept={DEFAULT_LOGO_ACCEPT} hidden tabIndex={-1} aria-hidden="true"
                  onChange={(event) => onFiles(event.target.files)} />
              </div>
            </div>
          </div>

          {progress && (
            <div className="settingsProgress">
              <ProgressBar
                aria-label={t("appearance.logoProgress")}
                value={percent}
                valueLabel={progress.processing ? t("appearance.logoProcessing") : `${percent}%`}
                isIndeterminate={progress.processing}
              >
                <span className="settingsMuted settingsProgressName">{t("appearance.logoUploading", { name: progress.name })}</span>
                <ProgressBar.Output />
                <ProgressBar.Track>
                  <ProgressBar.Fill />
                </ProgressBar.Track>
              </ProgressBar>
              <Button variant="ghost" onPress={() => running.current?.abort()}>{t("appearance.logoCancelUpload")}</Button>
            </div>
          )}

          {message && (message.tone === "error"
            ? <CardNotice tone="error">{message.text}</CardNotice>
            : <p className="settingsStatus" data-tone={message.tone} role="status">{message.text}</p>)}

          {!state.enabled && <CardNotice tone="warning">{t("appearance.logoDisabled")}</CardNotice>}

          <ul className="settingsFacts">
            <li>{text(copy.reach)}</li>
            <li>{text(copy.perClip)}</li>
          </ul>
        </div>
      )}
    </section>
  );
}
