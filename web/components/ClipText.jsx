"use client";

import { useEffect, useId, useRef, useState } from "react";

import {
  CLIP_TEXT_COPY as COPY,
  clipTextDraft,
  clipTextForm,
  rewriteClipText,
  saveClipText,
} from "../lib/clip-text.mjs";
import { useTranslations } from "use-intl";

import styles from "./ClipText.module.css";

// The caption box's words in the UI language (project.text.*), by the CLIP_TEXT_COPY entry; one
// literal key each. The routes' own messages show as they come.
function useTextWords() {
  const t = useTranslations("project");
  const words = {
    edit: t("text.edit"), editLabel: t("text.editLabel"), rewrite: t("text.rewrite"), rewriting: t("text.rewriting"),
    pending: t("text.pending"), suggestion: t("text.suggestion"), use: t("text.use"), discard: t("text.discard"),
    titleLabel: t("text.titleLabel"), descriptionLabel: t("text.descriptionLabel"), descriptionHint: t("text.descriptionHint"),
    save: t("text.save"), saving: t("text.saving"), cancel: t("text.cancel"), saved: t("text.saved"), failed: t("text.failed"),
    help: t("text.help"), settings: t("text.settings"),
  };
  return words;
}

const SAVED_NOTE_MS = 2600;
const IDLE = Object.freeze({ state: "idle" });

// The caption block of one clip in the project page's detail panel: the caption as it reads
// (`view`, with the page's "Salin caption" as `copy`), "Ubah" to edit the title and description
// in place, and "Tulis ulang" for a suggestion from the AI to use or throw away. Nothing changes
// on the server until "Simpan". Keyed by the clip: an unsaved draft and an open suggestion wait
// in `drafts` while another clip is shown.
export default function ClipText({ jobId, clip, editable, drafts, onSaved, view, copy }) {
  const words = useTextWords();
  // What the live region says comes from COPY; shown in the UI language.
  const shownStatus = (text) => (text === COPY.saved ? words.saved : text === COPY.pending ? words.pending
    : text.startsWith(`${COPY.suggestion}: `) ? `${words.suggestion}: ${text.slice(COPY.suggestion.length + 2)}` : text);
  const kept = useRef(drafts?.get(clip.index) ?? null);
  const [editing, setEditing] = useState(Boolean(kept.current?.draft));
  const [draft, setDraft] = useState(() => kept.current?.draft ?? clipTextDraft(clip));
  const [save, setSave] = useState({ state: "idle", field: null, message: "" });
  const [rewrite, setRewrite] = useState(() => (kept.current?.suggestion ? { state: "suggestion", suggestion: kept.current.suggestion } : IDLE));
  // What the live region says; `shown` false keeps it for screen readers only (the suggestion card
  // already shows what it announces).
  const [status, setStatus] = useState({ text: "", shown: true });
  const latest = useRef({ editing, draft, rewrite });
  const rewrites = useRef(new Set());
  const focusNext = useRef(null);
  const statusTimer = useRef(null);
  const editButton = useRef(null);
  const rewriteButton = useRef(null);
  const titleInput = useRef(null);
  const ids = useId();
  latest.current = { editing, draft, rewrite };

  const form = clipTextForm(draft, clip);
  const busy = rewrite.state === "pending";
  const saving = save.state === "saving";

  useEffect(() => {
    drafts?.delete(clip.index);
    const running = rewrites.current;
    return () => {
      for (const controller of running) controller.abort();
      if (statusTimer.current !== null) clearTimeout(statusTimer.current);
      const { editing: open, draft: text, rewrite: offer } = latest.current;
      const suggestion = offer.state === "suggestion" ? offer.suggestion : null;
      if (open || suggestion) drafts?.set(clip.index, { draft: open ? text : null, suggestion });
    };
  }, []);

  useEffect(() => {
    const target = focusNext.current;
    focusNext.current = null;
    if (target === "title") titleInput.current?.focus();
    if (target === "edit") editButton.current?.focus();
    if (target === "rewrite") rewriteButton.current?.focus();
  });

  const say = (text, shown = true) => {
    if (statusTimer.current !== null) clearTimeout(statusTimer.current);
    statusTimer.current = null;
    setStatus({ text, shown });
  };
  const sayForAWhile = (text) => {
    say(text);
    statusTimer.current = setTimeout(() => {
      statusTimer.current = null;
      setStatus({ text: "", shown: true });
    }, SAVED_NOTE_MS);
  };

  // Typing clears what the server said about the last "Simpan".
  const change = (name, value) => {
    setDraft((current) => ({ ...current, [name]: value }));
    if (save.state === "error") setSave({ state: "idle", field: null, message: "" });
  };

  const openEditor = (text = clipTextDraft(clip)) => {
    setDraft(text);
    setSave({ state: "idle", field: null, message: "" });
    setEditing(true);
    focusNext.current = "title";
  };

  const closeEditor = () => {
    setEditing(false);
    setSave({ state: "idle", field: null, message: "" });
    focusNext.current = "edit";
  };

  const submit = async (event) => {
    event.preventDefault();
    if (saving || !form.canSave) return;
    setSave({ state: "saving", field: null, message: "" });
    // A save is not aborted when another clip is shown: the page still takes the saved clip.
    let result;
    try {
      result = await saveClipText(jobId, clip.index, draft);
    } catch {
      setSave({ state: "error", field: null, message: "Teks belum tersimpan. Coba lagi." });
      return;
    }
    if (result.type === "redirect") {
      window.location.assign(result.location);
      return;
    }
    if (result.type === "error") {
      setSave({ state: "error", field: result.field, message: result.message });
      return;
    }
    setSave({ state: "idle", field: null, message: "" });
    setEditing(false);
    drafts?.delete(clip.index);
    focusNext.current = "edit";
    sayForAWhile(COPY.saved);
    onSaved(result.clip);
  };

  const askRewrite = async () => {
    if (busy) return;
    setRewrite({ state: "pending" });
    say(COPY.pending);
    // Showing another clip aborts the wait; the answer would belong to a clip no longer shown.
    const controller = new AbortController();
    rewrites.current.add(controller);
    let result;
    try {
      result = await rewriteClipText(jobId, clip.index, { signal: controller.signal });
    } catch {
      return;
    } finally {
      rewrites.current.delete(controller);
    }
    if (result.type === "redirect") {
      window.location.assign(result.location);
      return;
    }
    if (result.type === "error") {
      setRewrite({ state: "error", error: result });
      say("");
      return;
    }
    setRewrite({ state: "suggestion", suggestion: result.suggestion });
    say(`${COPY.suggestion}: ${result.suggestion.title}`, false);
  };

  const takeSuggestion = () => {
    const { suggestion } = rewrite;
    setRewrite(IDLE);
    say("");
    openEditor({ title: suggestion.title, description: suggestion.description });
  };

  const discardSuggestion = () => {
    setRewrite(IDLE);
    say("");
    focusNext.current = "rewrite";
  };

  const rewriteButtonEl = editable && (
    <button type="button" ref={rewriteButton} className="btn ghost" aria-disabled={busy || undefined} onClick={askRewrite}>
      {busy ? words.rewriting : words.rewrite}
    </button>
  );

  const titleProblem = form.titleProblem || (save.field === "title" ? save.message : null);
  const descriptionProblem = form.descriptionProblem || (save.field === "description" ? save.message : null);
  const formProblem = save.state === "error" && !save.field ? save.message : null;
  const field = {
    title: `${ids}-title`, titleCount: `${ids}-title-count`, titleProblem: `${ids}-title-problem`,
    description: `${ids}-description`, descriptionCount: `${ids}-description-count`, descriptionHint: `${ids}-description-hint`,
    descriptionProblem: `${ids}-description-problem`,
  };

  return (
    <>
      {editing && editable ? (
        <form className={styles.form} onSubmit={submit} noValidate>
          <div className={styles.field}>
            <div className={styles.fieldHead}>
              <label htmlFor={field.title}>{words.titleLabel}</label>
              <span id={field.titleCount} className={styles.count} data-over={form.titleOver || undefined}>
                {form.titleCount}
              </span>
            </div>
            <input
              id={field.title}
              ref={titleInput}
              className={styles.input}
              value={draft.title}
              onChange={(event) => change("title", event.target.value)}
              autoComplete="off"
              enterKeyHint="done"
              aria-invalid={titleProblem ? "true" : undefined}
              aria-describedby={[field.titleCount, titleProblem && field.titleProblem].filter(Boolean).join(" ")}
            />
            {titleProblem && <p id={field.titleProblem} className={styles.problem}>{titleProblem}</p>}
          </div>
          <div className={styles.field}>
            <div className={styles.fieldHead}>
              <label htmlFor={field.description}>{words.descriptionLabel}</label>
              <span id={field.descriptionCount} className={styles.count} data-over={form.descriptionOver || undefined}>
                {form.descriptionCount}
              </span>
            </div>
            <textarea
              id={field.description}
              className={styles.textarea}
              value={draft.description}
              rows={7}
              onChange={(event) => change("description", event.target.value)}
              aria-invalid={descriptionProblem ? "true" : undefined}
              aria-describedby={[field.descriptionCount, field.descriptionHint, descriptionProblem && field.descriptionProblem].filter(Boolean).join(" ")}
            />
            <p id={field.descriptionHint} className={styles.hint}>{words.descriptionHint}</p>
            {descriptionProblem && <p id={field.descriptionProblem} className={styles.problem}>{descriptionProblem}</p>}
          </div>
          {formProblem && <p className={`notice error ${styles.formProblem}`} role="alert">{formProblem}</p>}
          <div className={styles.actions}>
            <button type="submit" className="btn primary" aria-disabled={saving || !form.canSave || undefined}>
              {saving ? words.saving : words.save}
            </button>
            <button type="button" className="btn ghost" onClick={closeEditor}>{words.cancel}</button>
            {rewriteButtonEl}
          </div>
        </form>
      ) : (
        <>
          {view}
          <div className={styles.actions}>
            {copy}
            {editable && (
              <button type="button" ref={editButton} className="btn ghost" aria-label={words.editLabel} onClick={() => openEditor()}>
                {words.edit}
              </button>
            )}
            {rewriteButtonEl}
          </div>
        </>
      )}

      <p className={styles.status} role="status" aria-live="polite">
        {busy && <span className={`pulse ${styles.pending}`} aria-hidden="true" />}
        {status.shown ? shownStatus(status.text) : <span className="visuallyHidden">{shownStatus(status.text)}</span>}
      </p>

      {rewrite.state === "suggestion" && (
        <section className={styles.suggestion} aria-labelledby={`${ids}-suggestion`}>
          <h5 id={`${ids}-suggestion`} className={styles.suggestionLabel}>{words.suggestion}</h5>
          <p className={styles.suggestionTitle}>{rewrite.suggestion.title}</p>
          {rewrite.suggestion.description && <p className={styles.suggestionBody}>{rewrite.suggestion.description}</p>}
          <div className={styles.actions}>
            <button type="button" className="btn" onClick={takeSuggestion}>{words.use}</button>
            <button type="button" className="btn ghost" onClick={discardSuggestion}>{words.discard}</button>
          </div>
        </section>
      )}

      {rewrite.state === "error" && (
        <div className={`notice warning ${styles.failure}`} role="alert">
          <strong>{rewrite.error.title === COPY.failed ? words.failed : rewrite.error.title}</strong>
          <span>{rewrite.error.message}</span>
          {(rewrite.error.help || rewrite.error.settings) && (
            <span className={styles.links}>
              {rewrite.error.help && <a href={rewrite.error.help}>{words.help}</a>}
              {rewrite.error.settings && <a href={rewrite.error.settings}>{words.settings}</a>}
            </span>
          )}
        </div>
      )}
    </>
  );
}
