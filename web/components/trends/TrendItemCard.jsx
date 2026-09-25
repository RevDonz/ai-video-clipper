"use client";

import { useEffect, useId, useRef, useState } from "react";

import {
  TREND_STATUS_LABELS,
  draftFromTrendItem,
  expiryDateBounds,
  expiryView,
  platformLabels,
  sourceLabel,
  trendItemStatus,
  trendKindLabel,
  trendPatchPayload,
} from "../../lib/trend-view.mjs";
import { EditableTrendFields } from "./TrendFields.jsx";

/**
 * One trend item: read view with a quick on/off switch, inline edit, and an
 * in-page delete confirmation. `onUpdate(patch)` and `onDelete()` resolve to
 * the API client's result ({ ok, error, field }).
 */
export default function TrendItemCard({ item, now, onUpdate, onDelete }) {
  const [mode, setMode] = useState("view"); // view | edit | confirm
  const [draft, setDraft] = useState(() => draftFromTrendItem(item));
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState(null);
  const [pendingEnabled, setPendingEnabled] = useState(null); // optimistic switch state while saving
  const editButton = useRef(null);
  const deleteButton = useRef(null);
  const firstField = useRef(null);
  const cancelDelete = useRef(null);
  const returnFocus = useRef(null);
  const idPrefix = `trend${useId()}`;
  const titleId = `${idPrefix}-heading`;

  const status = trendItemStatus(item, now);
  const expiry = expiryView(item, now);
  const platforms = platformLabels(item.platforms);
  const switchOn = pendingEnabled ?? item.enabled;

  useEffect(() => {
    if (mode === "edit") firstField.current?.querySelector("input, textarea, select")?.focus();
    else if (mode === "confirm") cancelDelete.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current.current?.focus();
      returnFocus.current = null;
    }
  }, [mode]);

  function startEdit() {
    setDraft(draftFromTrendItem(item));
    setErrors({});
    setMessage(null);
    setMode("edit");
  }

  function close(focusTarget) {
    returnFocus.current = focusTarget;
    setMode("view");
  }

  function change(patch) {
    setDraft((current) => ({ ...current, ...patch }));
    setErrors((current) => {
      const next = { ...current };
      for (const key of Object.keys(patch)) {
        delete next[{ keywordsText: "keywords", hashtagsText: "hashtags", expiresDate: "expiresAt" }[key] || key];
      }
      delete next.general;
      return next;
    });
  }

  async function save(event) {
    event.preventDefault();
    const { payload, errors: found, changed } = trendPatchPayload(item, draft, Date.now());
    if (Object.keys(found).length) {
      setErrors(found);
      return;
    }
    if (!changed) {
      close(editButton);
      return;
    }
    setBusy("save");
    const result = await onUpdate(payload);
    setBusy("");
    if (result.ok) {
      setMessage({ tone: "ok", text: "Perubahan tersimpan." });
      close(editButton);
    } else {
      setErrors(result.field ? { [result.field]: result.error } : { general: result.error });
    }
  }

  // The switch shows the new state at once and reverts if saving fails. It is
  // never disabled, so keyboard focus stays on it; repeat toggles wait.
  async function toggleEnabled(event) {
    if (busy) return;
    const enabled = event.target.checked;
    setBusy("toggle");
    setPendingEnabled(enabled);
    setMessage(null);
    const result = await onUpdate({ enabled });
    setBusy("");
    setPendingEnabled(null);
    setMessage(result.ok
      ? { tone: "ok", text: enabled ? "Diaktifkan: dipakai job berikutnya." : "Dinonaktifkan: tidak dipakai job berikutnya." }
      : { tone: "error", text: result.error });
  }

  async function remove() {
    setBusy("delete");
    const result = await onDelete();
    // On success the card unmounts; the page moves focus and announces it.
    if (!result.ok) {
      setBusy("");
      setMessage({ tone: "error", text: result.error });
      close(deleteButton);
    }
  }

  const classes = ["trItem", status !== "active" ? status : "", item.sensitivity === "sensitive" ? "sensitive" : ""].filter(Boolean).join(" ");

  return (
    <article className={classes} aria-labelledby={titleId}>
      <div className="trItemTags">
        <span className={`trKind ${item.kind}`}>{trendKindLabel(item.kind)}</span>
        {item.sensitivity === "sensitive" && <span className="trBadge sensitive">Sensitif</span>}
        {status !== "active" && <span className={`trBadge ${status}`}>{TREND_STATUS_LABELS[status]}</span>}
        {item.score !== null && <span className="trScore" title="Momentum menurut agen (0–100)">Skor {item.score}</span>}
      </div>
      <h4 id={titleId}>{item.title}</h4>

      {mode !== "edit" && (
        <>
          {item.summary && <p className="trSummary">{item.summary}</p>}
          <p className="trMeta">
            <span className={`trExpiry ${expiry.tone}`} title={expiry.absolute || undefined}>{expiry.text}</span>
            {platforms.length > 0 && <span>{platforms.join(", ")}</span>}
            <span>{sourceLabel(item.source)}</span>
          </p>
          {(item.keywords.length > 0 || item.hashtags.length > 0) && (
            <ul className="trTerms" aria-label="Kata kunci dan hashtag">
              {item.keywords.map((keyword) => <li key={`k-${keyword}`}>{keyword}</li>)}
              {item.hashtags.map((tag) => <li key={`h-${tag}`} className="tag">{tag}</li>)}
            </ul>
          )}
          {item.examples.length > 0 && (
            <ul className="trExamples" aria-label="Contoh video">
              {item.examples.map((example) => (
                <li key={example.url}>
                  <a href={example.url} target="_blank" rel="noopener noreferrer nofollow">{example.host} ↗</a>
                  {example.note && <span>{example.note}</span>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {mode === "edit" && (
        <form className="trEditForm" onSubmit={save} noValidate aria-label={`Ubah tren ${item.title}`}>
          <div className="trFields" ref={firstField}>
            <EditableTrendFields
              idPrefix={idPrefix}
              draft={draft}
              errors={errors}
              bounds={expiryDateBounds(now)}
              onChange={change}
              expiryHelp={`Maksimal 60 hari dari hari ini.${status === "expired" ? " Pilih tanggal baru untuk menghidupkan lagi." : ""}`}
            />
            <label className="trSwitch wide">
              <input type="checkbox" role="switch" checked={draft.enabled} onChange={(event) => change({ enabled: event.target.checked })} />
              <span>{draft.enabled ? "Aktif — dipakai job berikutnya" : "Nonaktif — tidak dipakai"}</span>
            </label>
          </div>
          {item.source !== "manual" && (
            <p className="trFootnote">Item dari agen: bagian yang kamu ubah di sini tetap dipakai walau agen mengirim ulang item ini.</p>
          )}
          {errors.general && <p className="trAlert error" role="alert">{errors.general}</p>}
          {Object.keys(errors).length > 0 && !errors.general && <p className="trAlert error" role="alert">Periksa isian yang ditandai.</p>}
          <div className="trActions">
            <button type="submit" className="trPrimary" disabled={busy === "save"}>{busy === "save" ? "Menyimpan…" : "Simpan"}</button>
            <button type="button" className="trSecondary" onClick={() => close(editButton)} disabled={busy === "save"}>Batal</button>
          </div>
        </form>
      )}

      {mode === "view" && (
        <div className="trActions">
          <label className="trSwitch">
            <input type="checkbox" role="switch" checked={switchOn} onChange={toggleEnabled} aria-busy={busy === "toggle" || undefined} aria-describedby={`${idPrefix}-status`} />
            <span>{switchOn ? "Aktif" : "Nonaktif"}</span>
          </label>
          <button type="button" className="trSecondary" ref={editButton} onClick={startEdit} disabled={busy === "delete"}>Ubah</button>
          <button type="button" className="trSecondary danger" ref={deleteButton} onClick={() => { setMessage(null); setMode("confirm"); }} disabled={busy === "delete"}>Hapus</button>
        </div>
      )}

      {mode === "confirm" && (
        <div
          className="trConfirm"
          role="group"
          aria-labelledby={`${idPrefix}-confirm`}
          onKeyDown={(event) => { if (event.key === "Escape" && busy !== "delete") close(deleteButton); }}
        >
          <strong id={`${idPrefix}-confirm`}>Hapus “{item.title}”?</strong>
          <p>Item hilang dari konteks tren dan tidak dipakai job berikutnya. {item.source !== "manual" ? "Agen bisa mengirimnya lagi pada jadwal berikutnya; untuk menahannya, nonaktifkan saja." : "Tindakan ini tidak dapat dibatalkan."}</p>
          <div>
            <button type="button" className="confirmDelete" onClick={remove} disabled={busy === "delete"}>{busy === "delete" ? "Menghapus…" : "Ya, hapus"}</button>
            <button type="button" ref={cancelDelete} onClick={() => close(deleteButton)} disabled={busy === "delete"}>Batal</button>
          </div>
        </div>
      )}

      <p id={`${idPrefix}-status`} className={`trItemStatus ${message?.tone || ""}`} role={message?.tone === "error" ? "alert" : "status"} aria-live="polite">
        {message?.text || ""}
      </p>
    </article>
  );
}
