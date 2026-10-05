"use client";

// Mode Cepat's Hook card (docs/plans/2026-10-02-editor-mode-cepat.md §1.4 Hook): the "Tampilkan hook"
// switch, the text at the start of the clip with its counter and fit badge, and the suggestions
// (CompactSuggestions). The rules are hook-model.mjs, shared with the Teks panel, so both views
// send the same command for the same edit. Duration and position stay in Mode Lengkap. The
// suggestions ask the server only once this card opens (R1). Props: the card bundle of cards.mjs.
import { useEffect, useId, useRef, useState } from "react";

import {
  HOOK_FIT_TEXT,
  HOOK_MAX,
  cleanHookText,
  hookEnableText,
  hookEnabledCommand,
  hookFit,
  hookItemOf,
  hookMissingGlyphs,
  hookPoints,
  hookTextCommand,
} from "../panels/hook-model.mjs";
import CompactSuggestions from "../suggestions/CompactSuggestions.jsx";
import { runCommands } from "../transcript/actions.mjs";
import Switch from "../ui/Switch.jsx";
import styles from "./quick.module.css";

function HookBody({ state, dispatch, api }) {
  const doc = state.doc;
  const locked = state.status !== "ready";
  const hook = hookItemOf(doc);
  const [draft, setDraft] = useState(hook?.payload.text ?? hookItemOf(state.seed)?.payload.text ?? "");
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [message, setMessage] = useState(null);
  const uid = useId();

  // Undo, redo, a suggestion or the other view changes the text: show it unless it is the draft.
  const hookText = hook?.payload.text ?? null;
  useEffect(() => {
    if (hookText !== null && cleanHookText(draftRef.current) !== hookText) setDraft(hookText);
  }, [hookText]);

  const send = (command) => {
    const result = runCommands(dispatch, [command]);
    setMessage(result.ok ? null : result.message);
  };
  const onInput = (value) => {
    setDraft(value);
    const command = hookTextCommand(doc, value);
    if (command) send(command);
  };

  const draftText = cleanHookText(draft);
  const count = hookPoints(draftText);
  const fit = hookFit({ doc, plan: state.plan, pending: state.pending });
  const enableText = hookEnableText(draftText, state.seed);
  const glyphs = hookMissingGlyphs(state.plan, doc);

  return (
    <div className={styles.body} data-quick-body="hook">
      {message ? <p className={styles.message} role="alert">{message}</p> : null}
      <Switch label="Tampilkan hook" checked={hook !== null} disabled={locked || (hook === null && !enableText)}
        title={hook === null && !enableText ? "Tulis teks hook dulu" : undefined}
        onChange={(on) => send(hookEnabledCommand(on, enableText))} />
      <div className={styles.field}>
        <label htmlFor={`${uid}-text`} className={styles.label}>Teks di awal klip</label>
        <input id={`${uid}-text`} type="text" className={styles.textInput} value={draft} maxLength={HOOK_MAX}
          spellCheck={false} autoComplete="off" disabled={locked || hook === null} aria-describedby={`${uid}-meta`}
          onChange={(event) => onInput(event.target.value)} />
        <div id={`${uid}-meta`} className={styles.meta}>
          <span data-hook-counter="" className={count > HOOK_MAX ? styles.over : undefined}>{count}/{HOOK_MAX}</span>
          {fit ? <span className={styles.badge} data-fit={fit} data-hook-fit="" role="status">{HOOK_FIT_TEXT[fit]}</span> : null}
        </div>
        {fit === "overflow" ? <p className={styles.note}>Hook tidak muat 3 baris; ujungnya akan diganti “…”. Persingkat teksnya.</p> : null}
        {glyphs.length ? (
          <p className={styles.warning} data-hook-glyphs="">
            Font hook tidak punya {glyphs.join(", ")}; karakter ini tidak akan tampil di video.
          </p>
        ) : null}
      </div>
      <CompactSuggestions state={state} dispatch={dispatch} api={api} />
    </div>
  );
}

export default function HookCard({ state, dispatch, api = null }) {
  if (!state?.doc) return <p className={styles.note} role="status">Membuka hook…</p>;
  return <HookBody state={state} dispatch={dispatch} api={api} />;
}
