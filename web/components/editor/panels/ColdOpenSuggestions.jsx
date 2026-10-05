"use client";

// The cold-open suggestions (plan §7.2, §11.3 T3.7): the selection's cold open, the hook sentence
// and the strongest sentences of the clip (GET coldopen-suggestions), each with "Putar" (plays it
// where the clip shows it, then stops) and "Pakai" (one SetColdOpen, undoable). Rendered by the
// Cold open panel and by Mode Cepat's Cold open card ("Ganti kalimat", "Pilih kalimat"), so both
// views offer the same list. `touch` gives the controls the card's 44 px targets.
// Props: { state, dispatch, player, api, model, readOnly, onResult, touch }; `model` is
// buildTranscriptModel(words, doc).
import { useCallback, useEffect, useId, useMemo, useState } from "react";

import { runCommands } from "../transcript/actions.mjs";
import css from "./ColdOpenPanel.module.css";
import { candidateViews, readCandidates, resolveEditorApi } from "./coldopen-suggestions.mjs";
import styles from "./panels.module.css";
import { useAudition } from "./use-audition.js";

// Suggestions of a clip's revision 0, kept while the page lives (they only change with the seed),
// so a card closing, a panel switch or a view switch never asks again.
const suggestionCache = new Map();

function useSuggestions({ api, state }) {
  const clipKey = `${state.clipId ?? state.doc?.clip_id}:${state.doc?.base?.words?.sha256 ?? ""}`;
  const [entry, setEntry] = useState(() => suggestionCache.get(clipKey) ?? { key: clipKey, status: "loading", candidates: [] });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const cached = suggestionCache.get(clipKey);
    if (cached?.status === "ready" && attempt === 0) {
      setEntry(cached);
      return undefined;
    }
    let alive = true;
    setEntry({ key: clipKey, status: "loading", candidates: [] });
    // One tick later, so the shell's own effects (its API hook) have run.
    const timer = setTimeout(() => {
      const client = resolveEditorApi({ api, state });
      if (!client) {
        setEntry({ key: clipKey, status: "error", candidates: [] });
        return;
      }
      Promise.resolve(client.coldOpenSuggestions())
        .then((json) => {
          const next = { key: clipKey, status: "ready", candidates: readCandidates(json) };
          suggestionCache.set(clipKey, next);
          if (alive) setEntry(next);
        })
        .catch(() => { if (alive) setEntry({ key: clipKey, status: "error", candidates: [] }); });
    }, 0);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // `state` changes with every command; only the clip, its words and a retry refetch.
  }, [clipKey, attempt, api]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { ...entry, retry };
}

export default function ColdOpenSuggestions({ state, dispatch, player, api, model, readOnly, onResult, touch = false }) {
  const suggestions = useSuggestions({ api, state });
  const views = useMemo(() => candidateViews({ candidates: suggestions.candidates, model }), [suggestions.candidates, model]);
  const audition = useAudition(player, model.fps);
  const titleId = useId();

  const apply = (view) => {
    audition.stop();
    const result = runCommands(dispatch, [view.command]);
    onResult?.(result.ok ? { status: `Cold open diganti: saran ${view.number}.` } : { error: result.message });
  };

  let body;
  if (suggestions.status === "loading") {
    body = <p className={styles.note} role="status">Mencari saran cold open…</p>;
  } else if (suggestions.status === "error") {
    body = (
      <div className={css.row}>
        <p className={styles.note} role="status">Saran belum bisa dimuat.</p>
        <button type="button" className={styles.button} onClick={suggestions.retry}>Coba lagi</button>
      </div>
    );
  } else if (!views.length) {
    body = (
      <p className={styles.note} role="status">
        Belum ada kalimat di klip ini yang cocok jadi cold open (0,5–8 dtk). Pilih sendiri dari Transkrip.
      </p>
    );
  } else {
    body = (
      <ol className={css.list}>
        {views.map((view) => {
          const listening = audition.playing === view.id;
          const blocked = readOnly ? "Klip ini sedang dalam mode baca-saja" : view.blockReason;
          return (
            <li key={view.id} className={`${css.item} ${view.current ? css.current : ""}`} data-coldopen-suggestion={view.id}
              data-source={view.source ?? ""} data-current={view.current ? "true" : "false"} data-usable={view.ok ? "true" : "false"}
              data-number={view.number} data-audition={view.audition ? `${view.audition.f0}-${view.audition.f1}` : ""}>
              <div className={css.head}>
                <span className={css.label}>{view.label}</span>
                {view.current ? <span className={css.badge}>Sedang dipakai</span> : null}
                <span className={css.length}>{view.duration}</span>
              </div>
              <p className={css.text} data-suggestion-text="">“{view.text}”</p>
              {view.reason ? <p className={css.why} data-suggestion-why="">{view.reason}</p> : null}
              <div className={css.row}>
                <button type="button" className={styles.button} disabled={!view.audition}
                  aria-label={listening ? `Hentikan saran ${view.number}` : `Putar saran ${view.number}`}
                  aria-pressed={listening} title={view.audition ? undefined : view.auditionReason}
                  onClick={() => (listening ? audition.stop() : audition.start(view.id, view.audition))}>
                  {listening ? "Hentikan" : "Putar"}
                </button>
                <button type="button" className={`${styles.button} ${css.use}`} disabled={readOnly || !view.ok}
                  aria-label={`Pakai saran ${view.number} sebagai cold open`} onClick={() => apply(view)}>
                  Pakai
                </button>
              </div>
              {!view.current && blocked ? <p className={css.blocked} data-suggestion-reason="">{blocked}</p> : null}
              {!view.audition ? <p className={css.blocked}>{view.auditionReason}</p> : null}
            </li>
          );
        })}
      </ol>
    );
  }

  return (
    <div className={styles.section} aria-labelledby={titleId} data-coldopen-suggestions="" data-touch={touch ? "" : undefined}>
      <h3 className={styles.subtitle} id={titleId}>Saran cold open</h3>
      <p className={styles.note}>Dari cold open awal, kalimat hook, dan kalimat terkuat di klip ini. Putar dulu, lalu pakai yang paling menarik.</p>
      <div data-suggestions-state={suggestions.status === "ready" && !views.length ? "empty" : suggestions.status}
        aria-busy={suggestions.status === "loading"}>
        {body}
      </div>
    </div>
  );
}
