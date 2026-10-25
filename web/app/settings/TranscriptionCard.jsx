"use client";

// Pengaturan → Transkripsi: the opt-in switch that sends a video's audio to Groq, and the Groq key
// when Pengaturan AI has none for api.groq.com. A draft card of the one save bar: the switch and
// the key change nothing until Simpan (or Enter in the key field). The server never sends a key back.
import { Button, Description, Input, Label, Switch, TextField } from "@heroui/react";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";

import {
  GROQ_KEY_URL,
  transcriptionErrorMessage,
  transcriptionNotice,
  transcriptionSavedMessage,
  transcriptionState,
} from "../../lib/transcription-settings-view.mjs";
import { CardLoadError, CardLoading, CardNotice } from "./CardState.jsx";
import { cardDomId, useSaveAll, useSettingsCard } from "./SettingsSave.jsx";
import { useViewText } from "./view-text.jsx";

const ENDPOINT = "/api/settings/transcription";
const CARD = "transcription";
const KEEP = Object.freeze({ enabled: null, keyAction: "keep", keyValue: "" });

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
  const t = useTranslations("settings");
  const text = useViewText();
  const saveAll = useSaveAll();
  const [phase, setPhase] = useState("loading");
  const [state, setState] = useState(() => transcriptionState(null));
  // `enabled: null` keeps the stored switch; keyAction "replace" opens the field, "clear" removes on save.
  const [draft, setDraft] = useState(KEEP);
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
        setDraft(KEEP);
        setPhase("ready");
      } else {
        setMessage({ tone: "error", text: answer.status === 401 ? transcriptionErrorMessage({ status: 401 }) : { key: "transcription.loadFailed" } });
        setPhase("error");
      }
    } catch {
      if (!alive.current) return;
      setMessage({ tone: "error", text: { key: "transcription.loadFailed" } });
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

  const enabled = draft.enabled ?? state.enabled;
  const keyValue = draft.keyValue.trim();
  const dirty = phase === "ready" && (enabled !== state.enabled || draft.keyAction === "clear" || (draft.keyAction === "replace" && keyValue !== ""));

  async function save() {
    const apiKey = draft.keyAction === "clear" ? { action: "clear" } : draft.keyAction === "replace" && keyValue ? { action: "replace", value: keyValue } : { action: "keep" };
    setMessage(null);
    try {
      const answer = await send("PUT", { enabled, apiKey });
      if (!alive.current) return { ok: false };
      if (answer.ok && answer.payload) {
        const next = transcriptionState(answer.payload);
        setState(next);
        setDraft(KEEP);
        const done = apiKey.action === "replace" ? { key: "transcription.keyStored" } : apiKey.action === "clear" ? { key: "transcription.keyRemoved" } : transcriptionSavedMessage(next);
        setMessage({ tone: "ok", text: done });
        return { ok: true };
      }
      setMessage({ tone: "error", text: transcriptionErrorMessage({ status: answer.status, code: answer.payload?.code, error: answer.payload?.error }) });
    } catch {
      if (alive.current) setMessage({ tone: "error", text: transcriptionErrorMessage({ status: 0 }) });
    }
    return { ok: false };
  }

  useSettingsCard(CARD, "transkripsi", { dirty, save, discard: () => { setDraft(KEEP); setMessage(null); } });

  const edit = (patch) => {
    setDraft((current) => ({ ...current, ...patch }));
    setMessage(null);
  };
  const onSubmit = (event) => {
    event.preventDefault();
    if (dirty) void saveAll();
  };

  const notice = phase === "ready" ? transcriptionNotice(state) : null;
  const unreadable = state.key === "unreadable" && state.ownKey;
  const showSaved = state.ownKey && draft.keyAction !== "replace";
  const keyText = (value) => (
    value === "clear" ? t("common.keyRemovedOnSave") : unreadable ? t("common.keyUnreadable") : t("transcription.keySaved")
  );
  const viewMessage = (key) => (key === "transcription.keyStored" ? t("transcription.keyStored") : key === "transcription.keyRemoved" ? t("transcription.keyRemoved") : key === "transcription.loadFailed" ? t("transcription.loadFailed") : null);
  const messageText = message ? viewMessage(message.text?.key) ?? text(message.text) : "";

  return (
    <section id={cardDomId(CARD)} tabIndex={-1} className="settingsCard" aria-label={t("tab.transcription")} aria-busy={phase === "loading"}>
      {phase === "loading" && <CardLoading label={t("common.loading")} />}
      {phase === "error" && <CardLoadError message={messageText} onRetry={() => void load()} />}

      {phase === "ready" && (
        <form className="settingsStack" onSubmit={onSubmit} noValidate>
          <Switch isSelected={enabled} onChange={(value) => edit({ enabled: value })} className="settingsSwitch">
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
              {t("transcription.groq")}
            </Switch.Content>
            <Description>{t("transcription.privacy")}</Description>
          </Switch>

          {state.llmKey ? (
            <div className="settingsRow">
              <span className="settingsMuted">{t("transcription.llmKey")}</span>
              {state.ownKey && draft.keyAction !== "clear" && (
                <Button variant="secondary" onPress={() => edit({ keyAction: "clear", keyValue: "" })}>{t("transcription.removeHere")}</Button>
              )}
              {draft.keyAction === "clear" && (
                <>
                  <span className="settingsMuted">{t("common.keyRemovedOnSave")}</span>
                  <Button variant="secondary" onPress={() => edit({ keyAction: "keep" })}>{t("common.cancel")}</Button>
                </>
              )}
            </div>
          ) : showSaved ? (
            <div className="settingsField">
              <span id="transcription-key-label" className="settingsLabel">{t("transcription.key")}</span>
              <div className="settingsKeyState" data-tone={draft.keyAction === "clear" ? "warning" : unreadable ? "error" : "ok"} role="group" aria-labelledby="transcription-key-label">
                <span>{keyText(draft.keyAction)}</span>
                {draft.keyAction === "clear" ? (
                  <Button variant="secondary" onPress={() => edit({ keyAction: "keep" })}>{t("common.cancel")}</Button>
                ) : (
                  <>
                    <Button variant="secondary" onPress={() => edit({ keyAction: "replace", keyValue: "" })} isDisabled={!state.secretConfigured}>
                      {unreadable ? t("common.refill") : t("common.replace")}
                    </Button>
                    <Button variant="danger" onPress={() => edit({ keyAction: "clear", keyValue: "" })}>{t("common.remove")}</Button>
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="settingsField">
              <TextField
                type="password"
                value={draft.keyValue}
                onChange={(value) => edit({ keyAction: "replace", keyValue: value })}
                isDisabled={!state.secretConfigured}
                className="settingsTextField"
              >
                <Label>{t("transcription.key")}</Label>
                <div className="settingsRow">
                  <Input placeholder={state.ownKey ? t("common.pasteNewKey") : t("common.pasteKey")} autoComplete="new-password" spellCheck={false} autoCapitalize="off" />
                  {state.ownKey && (
                    <Button variant="secondary" onPress={() => edit({ keyAction: "keep", keyValue: "" })}>{t("common.cancel")}</Button>
                  )}
                </div>
                <Description>
                  {t("transcription.keyHelp")}{" "}
                  <a className="settingsLink" href={GROQ_KEY_URL} target="_blank" rel="noopener noreferrer">{t("common.getKey")}</a>
                </Description>
              </TextField>
            </div>
          )}

          {notice && <CardNotice tone={notice.tone}>{text(notice)}</CardNotice>}
          {message && (message.tone === "error"
            ? <CardNotice tone="error">{messageText}</CardNotice>
            : <p className="settingsStatus" data-tone="ok" role="status">{messageText}</p>)}
        </form>
      )}
    </section>
  );
}
