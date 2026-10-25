"use client";

// Baris (rombak 06 §6, §10 #24): one field per caption line of the plan, in the transcript of the
// one-layout editor and in Mode Cepat's Teks caption card (docs/plans/2026-10-02-editor-mode-cepat.md
// §2), which renders this view. Enter, blur and Tab commit a line as word edits (dry run first,
// one merge key, so one Urungkan undoes it); Esc restores it. A word deleted here is only hidden
// from the caption, its sound stays, and its line keeps a "Disembunyikan" mark while it holds
// such words (retyping one brings it back). A draft keeps the line and document it was typed
// against and is diffed against them, so lines that regroup while the viewer types never change
// a word the field did not show; a field that leaves the page commits its draft as a blur would.
// When the lines regroup, focus follows the focused line's words (§2.5). The line under the
// playhead is marked by the frame bus, outside React.
//
// Props: { state, dispatch, player, frameBus, readOnly, variant: "transcript" | "card", tools
// (beside the help line), review (under it), onShowWords (the empty state's button) }.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "use-intl";

import { captionRows, commitLine, focusAfterRegroup, rowAtFrame } from "../../../lib/editor/caption-lines.mjs";
import { createContext } from "../../../lib/editor/doc-model.mjs";
import { formatClock, frameToMs } from "../shell-model.mjs";
import PillButton from "../ui/PillButton.jsx";
import { actionKey, runCommands } from "./actions.mjs";
import styles from "./lines-view.module.css";
import { buildTranscriptModel } from "./model.mjs";
import { hiddenInRow } from "./transcript-view.mjs";

const MAX_LENGTH = 160;

const inputIdOf = (key) => `caption-line-${key.replace(/[^\w-]/g, "-")}`;

function without(map, key) {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
}

function withEntry(map, key, value) {
  if (map.get(key) === value) return map;
  return new Map(map).set(key, value);
}

export default function LinesView({
  state, dispatch, player, frameBus, readOnly = false, variant = "transcript", tools = null, review = null, onShowWords = null,
}) {
  const t = useTranslations("editor.transcript.lines");
  const doc = state?.doc ?? null;
  const words = Array.isArray(state?.words?.words) ? state.words : null;
  const plan = state?.plan ?? null;
  const seedDoc = state?.seed ?? null;
  const captionsOn = doc?.captions?.enabled !== false;
  const ready = Boolean(doc && words && plan);
  const upper = doc?.captions?.overrides?.case === "upper";
  const fps = plan?.fps ?? doc?.output?.fps ?? null;

  const model = useMemo(() => (doc && words ? buildTranscriptModel(words, doc) : null), [words, doc]);
  const rows = useMemo(() => (ready && captionsOn ? captionRows({ plan, doc, words, model }) : []),
    [ready, captionsOn, plan, doc, words, model]);
  // The command context: the seed fixes fps, output size and window; a state without a seed
  // carries the same values in its first document, so the context is not rebuilt per edit.
  const firstDoc = useRef(doc);
  if (!firstDoc.current && doc) firstDoc.current = doc;
  const ctx = useMemo(() => {
    const seed = seedDoc ?? firstDoc.current;
    return words && seed ? createContext({ words, seed }) : null;
  }, [words, seedDoc]);

  const [drafts, setDrafts] = useState(() => new Map());
  const [errors, setErrors] = useState(() => new Map());
  const [status, setStatus] = useState("");
  const listRef = useRef(null);
  const statusRef = useRef(null);
  const focusedKey = useRef(null);
  const previousRows = useRef(rows);
  const pointerInside = useRef(false);
  const committed = useRef(new WeakSet());

  const forget = (key) => {
    setDrafts((current) => without(current, key));
    setErrors((current) => without(current, key));
  };

  // A draft is diffed against the line and document of its first keystroke (`base`); the dry run
  // runs on the document as it is now. → null once committed, else the refusal's message.
  const send = (row, draft, base) => {
    const result = commitLine({ row, draft, doc, words, upper, ctx, mergeKey: actionKey("captionLine"), base });
    if (!result.ok) return result.message;
    if (result.commands.length) {
      // The dry run passed, so the store refuses only after a concurrent change; the commands it
      // took share the merge key, so one Urungkan removes them.
      const run = runCommands(dispatch, result.commands);
      if (!run.ok) return run.message;
      setStatus(result.hidesRow ? t("rowHidden") : "");
    }
    return null;
  };

  const commit = (row, draft) => {
    if (readOnly || !ctx || !doc) return;
    const message = send(row, draft, drafts.get(row.key) ?? null);
    if (message) {
      setErrors((current) => withEntry(current, row.key, message));
      return;
    }
    forget(row.key);
  };

  const onFocus = (row) => {
    focusedKey.current = row.key;
    if (player && player.state?.()?.playing !== true) player.seek?.(row.f0);
  };

  // Tab or a click on another line: that line is the focused one from here, even if the commit's
  // new plan regroups it away before it receives focus.
  const onBlur = (event, row) => {
    commit(row, event.currentTarget.value);
    if (!event.currentTarget.isConnected || focusedKey.current !== row.key) return;
    const next = event.relatedTarget;
    focusedKey.current = next && listRef.current?.contains(next) ? next.getAttribute("data-line-input") : null;
  };

  const onKeyDown = (event, row) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      commit(row, event.currentTarget.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      forget(row.key);
    }
  };

  // §2.5: when the focused line's key is gone, focus the line that now holds its words, else the
  // next or previous line of its segment, else the status line. A vanished line's field lost its
  // focus without a blur event (React fires none for a removed element), so its draft commits here,
  // as a blur would, against the line it was typed against: no draft is lost.
  useLayoutEffect(() => {
    const before = previousRows.current;
    previousRows.current = rows;
    const keys = new Set(rows.map((row) => row.key));
    const orphans = [...drafts.values()].filter((entry) => !keys.has(entry.row.key) && !committed.current.has(entry));
    const stale = (map) => [...map.keys()].some((key) => !keys.has(key));
    if (stale(drafts) || stale(errors)) {
      const keep = (map) => new Map([...map].filter(([key]) => keys.has(key)));
      setDrafts(keep);
      setErrors(keep);
    }
    if (!readOnly && ctx && doc) {
      for (const entry of orphans) {
        committed.current.add(entry);
        const message = send(entry.row, entry.text, entry);
        if (message) setStatus(message);
      }
    }
    const focused = focusedKey.current;
    if (!focused || keys.has(focused)) return;
    const target = focusAfterRegroup(before, rows, focused);
    focusedKey.current = null;
    const element = target ? document.getElementById(inputIdOf(target)) : statusRef.current;
    element?.focus();
  }, [rows]); // drafts and errors are only pruned here; new rows are what this answers to

  // The line under the playhead gets the --text edge, and scrolls into view while nobody is
  // typing in or pointing at the lines.
  useEffect(() => {
    const list = listRef.current;
    if (!frameBus || !list) return undefined;
    let markedKey = null;
    let marked = null;
    const unsubscribe = frameBus.subscribe((frame) => {
      const rowKey = rowAtFrame(rows, frame)?.key ?? null;
      if (rowKey === markedKey) return;
      markedKey = rowKey;
      marked?.removeAttribute("data-current");
      marked = rowKey ? list.querySelector(`[data-line-key="${CSS.escape(rowKey)}"]`) : null;
      if (!marked) return;
      marked.setAttribute("data-current", "true");
      const active = document.activeElement;
      const typing = active?.tagName === "INPUT" && list.contains(active);
      if (!typing && !pointerInside.current && !list.closest("[inert]")) marked.scrollIntoView({ block: "nearest" });
    });
    return () => {
      unsubscribe();
      marked?.removeAttribute("data-current");
    };
  }, [frameBus, rows]);

  const card = variant === "card";
  let body;
  if (doc && !captionsOn) {
    body = <p className={styles.note}>{card ? t("captionsOffCard") : t("captionsOff")}</p>;
  } else if (!ready) {
    body = state?.previewError && !plan
      ? <p className={styles.note} role="alert">{t("loadError")}</p>
      : <p className={styles.note} role="status">{t("loading")}</p>;
  } else if (!rows.length) {
    body = (
      <div className={styles.empty}>
        <p className={styles.note}>{t("empty")}</p>
        <PillButton onClick={() => onShowWords?.()} disabled={typeof onShowWords !== "function"}>
          {card ? t("openTranscript") : t("toWords")}
        </PillButton>
      </div>
    );
  } else {
    body = (
      <>
        <div className={styles.tools}>
          <p className={styles.help}>{t("help")}</p>
          {tools}
        </div>
        {review}
        <ol className={styles.rows} ref={listRef}>
          {rows.map((row) => {
            const id = inputIdOf(row.key);
            const error = errors.get(row.key) ?? null;
            const draft = drafts.get(row.key)?.text;
            const hidden = card ? 0 : hiddenInRow(row);
            const described = [error ? `${id}-error` : null, hidden ? `${id}-hidden` : null].filter(Boolean).join(" ");
            return (
              <li key={row.key} className={styles.item}>
                <div className={styles.row} data-line-key={row.key} data-invalid={error ? "true" : undefined}>
                  <label htmlFor={id} className={styles.time}>
                    <span>{fps ? formatClock(frameToMs(row.f0, fps)) : ""}</span>
                    {row.cold ? <span className={styles.cold}>{" "}{t("coldOpen")}</span> : null}
                  </label>
                  <input id={id} className={styles.input} type="text" value={draft ?? row.text} maxLength={MAX_LENGTH} data-line-input={row.key}
                    spellCheck={false} autoComplete="off" autoCapitalize="off" enterKeyHint="done" readOnly={readOnly}
                    data-upper={upper ? "" : undefined} aria-invalid={error ? "true" : undefined}
                    aria-describedby={described || undefined}
                    onChange={(event) => {
                      const { value } = event.currentTarget;
                      // The first keystroke fixes what the draft was typed against.
                      setDrafts((current) => {
                        const typed = current.get(row.key);
                        return new Map(current).set(row.key, typed ? { ...typed, text: value } : { text: value, row, doc });
                      });
                    }}
                    onFocus={() => onFocus(row)} onBlur={(event) => onBlur(event, row)} onKeyDown={(event) => onKeyDown(event, row)} />
                  {hidden ? (
                    <span className={styles.hiddenMark} data-line-hidden="" aria-hidden="true">{t("hidden")}</span>
                  ) : null}
                </div>
                {hidden ? <span id={`${id}-hidden`} className={styles.srOnly}>{t("hiddenDetail", { count: hidden })}</span> : null}
                {error ? <p id={`${id}-error`} className={styles.error} role="alert">{error}</p> : null}
              </li>
            );
          })}
        </ol>
      </>
    );
  }

  return (
    <div className={styles.lines} data-caption-lines="" data-variant={variant}
      onPointerEnter={() => { pointerInside.current = true; }} onPointerLeave={() => { pointerInside.current = false; }}>
      {body}
      <p className={styles.status} ref={statusRef} tabIndex={-1} role="status">{status}</p>
    </div>
  );
}
