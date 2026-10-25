"use client";

// Fokus klip (docs/plans/2026-09-25-fokus-klip.md §3) inside the "Arahkan" chip: focus terms as
// removable chips (a comma or Enter makes a chip, a pasted list one chip per line) plus a free
// note for the AI. Empty means no focus: nothing is sent. Chips the transcript can never say
// literally get a hint. The page keeps the state, so closing the popover loses nothing.
import { useEffect, useRef } from "react";
import { useTranslations } from "use-intl";

import {
  FOCUS_LIMITS,
  addFocusTerms,
  focusTermMatchable,
  focusTermsHint,
  normalizeFocusText,
  pastedFocusTerms,
} from "../../lib/selection-v3-view.mjs";
import styles from "./focus.module.css";

export default function FocusField({ terms, draft, note, error, aiMode, onTermsChange, onDraftChange, onNoteChange, onErrorChange }) {
  const t = useTranslations("dashboard");
  const inputRef = useRef(null);
  const removeButtons = useRef([]);
  const refocusIndex = useRef(null);
  const noteLength = Array.from(normalizeFocusText(note)).length;
  const full = terms.length >= FOCUS_LIMITS.terms;
  const hint = focusTermsHint(terms, aiMode);

  // After a chip is removed, keyboard focus moves to the next chip's button, else the input.
  useEffect(() => {
    removeButtons.current.length = terms.length;
    if (refocusIndex.current === null) return;
    const index = Math.min(refocusIndex.current, terms.length - 1);
    refocusIndex.current = null;
    (index >= 0 ? removeButtons.current[index] : inputRef.current)?.focus();
  }, [terms]);

  function apply(result, rest = "") {
    onTermsChange(result.terms);
    onDraftChange([result.pending, rest].filter(Boolean).join(", "));
    onErrorChange(result.error);
  }

  function changeDraft(value) {
    const cut = Math.max(value.lastIndexOf(","), value.lastIndexOf("\n"));
    if (cut < 0) {
      onDraftChange(value);
      if (error) onErrorChange("");
      return;
    }
    apply(addFocusTerms(terms, value.slice(0, cut)), value.slice(cut + 1).trimStart());
  }

  function commitDraft() {
    if (normalizeFocusText(draft)) apply(addFocusTerms(terms, draft));
  }

  // Closing the popover removes the input while it has focus, and a removed input gets no blur:
  // the text still typed becomes a chip when the field goes away.
  const commitOnClose = useRef(commitDraft);
  commitOnClose.current = commitDraft;
  useEffect(() => () => commitOnClose.current(), []);

  // A single-line input turns pasted line breaks into spaces: read the paste itself.
  function pasteList(event) {
    const input = event.currentTarget;
    const text = pastedFocusTerms(draft, event.clipboardData?.getData("text"), input.selectionStart, input.selectionEnd);
    if (text === null) return;
    event.preventDefault();
    apply(addFocusTerms(terms, text));
  }

  function remove(index) {
    refocusIndex.current = index;
    onTermsChange(terms.filter((_, position) => position !== index));
    onErrorChange("");
  }

  const placeholder = full ? t("focus.full", { max: FOCUS_LIMITS.terms }) : terms.length ? t("focus.more") : t("focus.example");

  return (
    <div className={styles.focus} role="group" aria-labelledby="focus-terms-label">
      <div className={styles.head}>
        <label id="focus-terms-label" className={styles.label} htmlFor="focus-terms-input">{t("focus.terms")}</label>
        <span className={styles.count} aria-hidden="true">{terms.length}/{FOCUS_LIMITS.terms}</span>
      </div>
      <div className={styles.box}>
        {terms.length > 0 && (
          <ul className={styles.chips} aria-label={t("focus.list")}>
            {terms.map((term, index) => (
              <li key={term} className={focusTermMatchable(term) ? undefined : styles.unmatchable}>
                <span>{term}</span>
                <button type="button" ref={(node) => { removeButtons.current[index] = node; }} aria-label={t("focus.remove", { term })} onClick={() => remove(index)}>×</button>
              </li>
            ))}
          </ul>
        )}
        <input
          id="focus-terms-input"
          ref={inputRef}
          className={styles.input}
          type="text"
          autoComplete="off"
          enterKeyHint="enter"
          value={draft}
          placeholder={placeholder}
          aria-describedby={hint ? "focus-terms-help focus-terms-hint" : "focus-terms-help"}
          aria-invalid={error ? "true" : undefined}
          onChange={(event) => changeDraft(event.target.value)}
          onPaste={pasteList}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            commitDraft();
          }}
          onBlur={commitDraft}
        />
      </div>
      <span id="focus-terms-help" className={styles.help}>{t("focus.help")}</span>
      {hint && <span id="focus-terms-hint" className={styles.hint}>{hint}</span>}
      {error && <span className={styles.error} role="alert">{error}</span>}
      <label className={styles.noteLabel} htmlFor="focus-note">{t("focus.note")}</label>
      <textarea id="focus-note" className={styles.note} rows={2} value={note} placeholder={t("focus.noteExample")} aria-describedby="focus-note-count" onChange={(event) => onNoteChange(event.target.value)} />
      <span id="focus-note-count" className={`${styles.help} ${styles.noteMeta}`}>
        <span>{aiMode === "off" ? t("focus.noteOff") : ""}</span>
        <span className={noteLength > FOCUS_LIMITS.note ? styles.over : undefined}>{noteLength}/{FOCUS_LIMITS.note}</span>
      </span>
    </div>
  );
}
