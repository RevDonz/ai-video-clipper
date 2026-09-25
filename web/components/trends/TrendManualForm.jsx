"use client";

import { useRef, useState } from "react";

import {
  TREND_KINDS,
  TREND_KIND_LABELS,
  TREND_LIMITS,
  TREND_PLATFORMS,
  TREND_PLATFORM_LABELS,
  emptyTrendDraft,
  expiryDateBounds,
  trendCreatePayload,
} from "../../lib/trend-view.mjs";
import { EditableTrendFields, Field, describedBy } from "./TrendFields.jsx";

const ERROR_KEY = { keywordsText: "keywords", hashtagsText: "hashtags", expiresDate: "expiresAt" };

/** "Tambah tren manual": POST /api/context/trends with source "manual" (set by the server). */
export default function TrendManualForm({ now, onCreate }) {
  const [draft, setDraft] = useState(emptyTrendDraft);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const form = useRef(null);

  function change(patch) {
    setDraft((current) => ({ ...current, ...patch }));
    setErrors((current) => {
      const next = { ...current };
      for (const key of Object.keys(patch)) delete next[ERROR_KEY[key] || key];
      delete next.general;
      return next;
    });
    setNotice(null);
  }

  function togglePlatform(platform, checked) {
    change({ platforms: checked ? [...draft.platforms, platform] : draft.platforms.filter((entry) => entry !== platform) });
  }

  function focusFirstError() {
    requestAnimationFrame(() => form.current?.querySelector("[aria-invalid=true]")?.focus());
  }

  async function submit(event) {
    event.preventDefault();
    const { payload, errors: found } = trendCreatePayload(draft, Date.now());
    if (Object.keys(found).length) {
      setErrors(found);
      setNotice({ tone: "error", text: `Periksa ${Object.keys(found).length} isian yang ditandai.` });
      focusFirstError();
      return;
    }
    setBusy(true);
    setNotice(null);
    const result = await onCreate(payload);
    setBusy(false);
    if (result.ok) {
      setDraft(emptyTrendDraft());
      setErrors({});
      setNotice({ tone: "ok", text: `“${payload.title}” ditambahkan.` });
      form.current?.querySelector("select, input")?.focus();
    } else {
      setErrors(result.field ? { [result.field]: result.error } : { general: result.error });
      setNotice({ tone: "error", text: result.error });
      if (result.field) focusFirstError();
    }
  }

  const bounds = expiryDateBounds(now);
  const scoreHelp = "0–100, seberapa ramai. Kosong = 50.";
  return (
    <form ref={form} className="trManualForm" onSubmit={submit} noValidate aria-label="Tambah tren manual">
      <div className="trFields">
        <Field id="manual-kind" label="Jenis" error={errors.kind}>
          <select
            id="manual-kind"
            value={draft.kind}
            aria-invalid={errors.kind ? true : undefined}
            aria-describedby={describedBy("manual-kind", null, errors.kind)}
            onChange={(event) => change({ kind: event.target.value })}
          >
            {TREND_KINDS.map((kind) => <option key={kind} value={kind}>{TREND_KIND_LABELS[kind]}</option>)}
          </select>
        </Field>
        <Field id="manual-score" label="Skor (opsional)" help={scoreHelp} error={errors.score}>
          <input
            id="manual-score"
            type="number"
            inputMode="numeric"
            min={TREND_LIMITS.scoreMin}
            max={TREND_LIMITS.scoreMax}
            step={1}
            value={draft.score}
            placeholder="50"
            aria-invalid={errors.score ? true : undefined}
            aria-describedby={describedBy("manual-score", scoreHelp, errors.score)}
            onChange={(event) => change({ score: event.target.value })}
          />
        </Field>
        <EditableTrendFields
          idPrefix="manual"
          draft={draft}
          errors={errors}
          bounds={bounds}
          onChange={change}
          expiryHelp={`Kosong = otomatis ${TREND_LIMITS.defaultExpiryDays} hari. Maksimal ${TREND_LIMITS.maxExpiryDays} hari.`}
        />
        <fieldset className="trPlatforms wide" aria-describedby={errors.platforms ? "manual-platforms-error" : undefined}>
          <legend>Platform (opsional)</legend>
          <div>
            {TREND_PLATFORMS.map((platform) => (
              <label key={platform} className={draft.platforms.includes(platform) ? "checked" : ""}>
                <input type="checkbox" checked={draft.platforms.includes(platform)} onChange={(event) => togglePlatform(platform, event.target.checked)} />
                <span>{TREND_PLATFORM_LABELS[platform]}</span>
              </label>
            ))}
          </div>
          {errors.platforms && <small className="trFieldError" id="manual-platforms-error">{errors.platforms}</small>}
        </fieldset>
      </div>
      <div className="trFormFooter">
        <button type="submit" className="trPrimary" disabled={busy}>{busy ? "Menyimpan…" : "Tambah tren"}</button>
        <p className={`trFormNotice ${notice?.tone || "muted"}`} role={notice?.tone === "error" ? "alert" : "status"} aria-live="polite">
          {notice?.text || "Sumber item ini dicatat sebagai “Manual”."}
        </p>
      </div>
    </form>
  );
}
