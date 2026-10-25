"use client";

// Pengaturan → Tampilan → Watermark (CONTRACTS §5.43): one line of text with its place, size and
// opacity, written into the clips of every new job. A draft card of the save bar; Hapus removes
// the stored text at once (the bar's Batalkan could not bring it back).
import { Button, Description, Input, Label, ListBox, Select, TextField } from "@heroui/react";
import { useEffect, useId, useRef, useState } from "react";
import { useFormatter, useLocale, useTranslations } from "use-intl";

import { WATERMARK_MAX, watermarkPoints } from "../../components/editor/panels/watermark-model.mjs";
import { apiErrorMessage } from "../../lib/api-error.mjs";
import {
  defaultWatermarkCopy,
  defaultWatermarkForm,
  defaultWatermarkPayload,
  defaultWatermarkState,
  watermarkDirty,
} from "../../lib/default-watermark-view.mjs";
import { WATERMARK_OPACITY_RANGE, WATERMARK_POSITIONS, WATERMARK_SIZE_RANGE } from "../../lib/editor/doc-model.mjs";
import { CardLoadError, CardLoading, CardNotice } from "./CardState.jsx";
import { cardDomId, useSaveAll, useSettingsCard } from "./SettingsSave.jsx";
import { useViewText } from "./view-text.jsx";

const ENDPOINT = "/api/settings/watermark";
const CARD = "watermark";

async function send(method, body) {
  const response = await fetch(ENDPOINT, {
    method,
    cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, payload };
}

export default function DefaultWatermarkCard() {
  const t = useTranslations("settings");
  const format = useFormatter();
  const tRoot = useTranslations();
  const locale = useLocale();
  const text = useViewText();
  const saveAll = useSaveAll();
  const [phase, setPhase] = useState("loading");
  const [state, setState] = useState(() => defaultWatermarkState(null));
  const [form, setForm] = useState(() => defaultWatermarkForm(null));
  const [removing, setRemoving] = useState(false);
  const [message, setMessage] = useState(null);
  const alive = useRef(true);
  const id = useId();

  const placeName = (place) => ({
    top_left: t("appearance.place.top_left"),
    top_center: t("appearance.place.top_center"),
    top_right: t("appearance.place.top_right"),
    middle_left: t("appearance.place.middle_left"),
    middle_center: t("appearance.place.middle_center"),
    middle_right: t("appearance.place.middle_right"),
    bottom_left: t("appearance.place.bottom_left"),
    bottom_center: t("appearance.place.bottom_center"),
    bottom_right: t("appearance.place.bottom_right"),
  })[place] ?? place;
  const percent = (pm) => format.number(pm / 1000, { style: "percent", maximumFractionDigits: 1 });

  async function load() {
    setPhase("loading");
    setMessage(null);
    try {
      const answer = await send("GET");
      if (!alive.current) return;
      if (answer.ok && answer.payload) {
        const next = defaultWatermarkState(answer.payload);
        setState(next);
        setForm(defaultWatermarkForm(next.watermark));
        setPhase("ready");
      } else {
        setMessage({ tone: "error", text: answer.status === 401 ? t("common.error.session") : t("appearance.watermarkLoadFailed") });
        setPhase("error");
      }
    } catch {
      if (!alive.current) return;
      setMessage({ tone: "error", text: t("appearance.watermarkLoadFailed") });
      setPhase("error");
    }
  }

  useEffect(() => {
    alive.current = true;
    void load();
    return () => { alive.current = false; };
  }, []);

  const copy = defaultWatermarkCopy({ autoClips: state.autoClips });
  const saved = state.watermark;
  const dirty = phase === "ready" && watermarkDirty(form, saved);
  const points = watermarkPoints(form.text.trim());
  const edit = (patch) => {
    setForm((current) => ({ ...current, ...patch }));
    setMessage(null);
  };

  async function save() {
    const result = defaultWatermarkPayload(form);
    if (result.error) {
      setMessage({ tone: "error", text: text(result.error) });
      return { ok: false };
    }
    setMessage(null);
    try {
      const answer = await send("PUT", result.payload);
      if (!alive.current) return { ok: false };
      if (answer.ok && answer.payload) {
        const next = defaultWatermarkState(answer.payload);
        setState(next);
        setForm(defaultWatermarkForm(next.watermark));
        setMessage({ tone: "ok", text: t("appearance.watermarkSaved") });
        return { ok: true };
      }
      const failed = answer.status === 401 ? t("common.error.session") : apiErrorMessage(tRoot, answer.payload, answer.status, { locale, fallback: t("appearance.watermarkSaveFailed") });
      setMessage({ tone: "error", text: failed });
    } catch {
      if (alive.current) setMessage({ tone: "error", text: t("common.error.offline") });
    }
    return { ok: false };
  }

  useSettingsCard(CARD, "tampilan", { dirty, save, discard: () => { setForm(defaultWatermarkForm(saved)); setMessage(null); } });

  async function remove() {
    if (removing || !saved) return;
    setRemoving(true);
    setMessage(null);
    try {
      const answer = await send("DELETE");
      if (!alive.current) return;
      if (answer.ok && answer.payload) {
        setState(defaultWatermarkState(answer.payload));
        setForm(defaultWatermarkForm(null));
        setMessage({ tone: "ok", text: t("appearance.watermarkRemoved") });
      } else {
        setMessage({ tone: "error", text: answer.status === 401 ? t("common.error.session") : t("appearance.watermarkRemoveFailed") });
      }
    } catch {
      if (alive.current) setMessage({ tone: "error", text: t("common.error.offline") });
    } finally {
      if (alive.current) setRemoving(false);
    }
  }

  const onSubmit = (event) => {
    event.preventDefault();
    if (dirty) void saveAll();
  };

  return (
    <section id={cardDomId(CARD)} tabIndex={-1} className="settingsCard" aria-labelledby={`${id}-title`} aria-busy={removing || phase === "loading"}>
      <h2 id={`${id}-title`} className="settingsCardTitle">{t("appearance.watermark")}</h2>

      {phase === "loading" && <CardLoading label={t("common.loading")} />}
      {phase === "error" && <CardLoadError message={message?.text} onRetry={() => void load()} />}

      {phase === "ready" && (
        <form className="settingsStack" onSubmit={onSubmit} noValidate>
          <div className="settingsGrid">
            <TextField value={form.text} onChange={(value) => edit({ text: value })} maxLength={WATERMARK_MAX} className="settingsTextField settingsWide">
              <Label>{t("appearance.watermarkText")}</Label>
              <Input placeholder={t("appearance.watermarkPlaceholder")} autoComplete="off" spellCheck={false} />
              <Description>{t("appearance.watermarkCount", { count: points, max: WATERMARK_MAX })}</Description>
            </TextField>
            <Select value={form.pos} onChange={(value) => value && edit({ pos: String(value) })} className="settingsSelect">
              <Label>{t("appearance.watermarkPos")}</Label>
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Description>{t("appearance.watermarkPosHelp")}</Description>
              <Select.Popover>
                <ListBox>
                  {WATERMARK_POSITIONS.map((place) => (
                    <ListBox.Item key={place} id={place} textValue={placeName(place)}>
                      {placeName(place)}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
            <div className="settingsField">
              <span id={`${id}-size`} className="settingsLabel">{t("appearance.watermarkSize", { value: percent(form.size_pm) })}</span>
              <input className="settingsRange" type="range" min={WATERMARK_SIZE_RANGE[0]} max={WATERMARK_SIZE_RANGE[1]} step={50} value={form.size_pm}
                aria-labelledby={`${id}-size`} aria-valuetext={percent(form.size_pm)}
                onChange={(event) => edit({ size_pm: Number(event.target.value) })} />
            </div>
            <div className="settingsField">
              <span id={`${id}-opacity`} className="settingsLabel">{t("appearance.watermarkOpacity", { value: percent(form.opacity_pm) })}</span>
              <input className="settingsRange" type="range" min={WATERMARK_OPACITY_RANGE[0]} max={WATERMARK_OPACITY_RANGE[1]} step={10} value={form.opacity_pm}
                aria-labelledby={`${id}-opacity`} aria-valuetext={percent(form.opacity_pm)}
                onChange={(event) => edit({ opacity_pm: Number(event.target.value) })} />
            </div>
          </div>
          {saved && (
            <div className="settingsRow">
              <Button variant="danger" onPress={remove} isDisabled={removing}>
                {removing ? t("common.removing") : t("common.remove")}
              </Button>
            </div>
          )}

          {message && (message.tone === "error"
            ? <CardNotice tone="error">{message.text}</CardNotice>
            : <p className="settingsStatus" data-tone="ok" role="status">{message.text}</p>)}

          <ul className="settingsFacts">
            <li>{text(copy.reach)}</li>
            <li>{text(copy.perClip)}</li>
          </ul>
        </form>
      )}
    </section>
  );
}
