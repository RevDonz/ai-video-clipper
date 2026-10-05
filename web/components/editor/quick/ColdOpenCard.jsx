"use client";

// Mode Cepat's Cold open card (docs/plans/2026-10-02-editor-mode-cepat.md §1.4 Cold open): the
// current line and its length with "Putar" and "Ganti kalimat" (or "Belum ada cold open." and
// "Pilih kalimat"), the suggestion list those open, the Transisi section exactly as in Mode
// Lengkap, and "Hapus cold open". The suggestions and the Transisi section are the panel's own
// components (ColdOpenSuggestions, TransitionSection), so both views read the same. The
// candidates are asked for when the card opens; word nudges stay in Mode Lengkap.
// Props: the card bundle of cards.mjs.
import { useId, useMemo, useState } from "react";

import ColdOpenSuggestions from "../panels/ColdOpenSuggestions.jsx";
import TransitionSection from "../panels/TransitionSection.jsx";
import { useAudition } from "../panels/use-audition.js";
import { runCommands } from "../transcript/actions.mjs";
import { buildTranscriptModel, coldOpenInfo, formatDuration } from "../transcript/model.mjs";
import PillButton from "../ui/PillButton.jsx";
import styles from "./quick.module.css";

function ColdOpenBody({ state, dispatch, player, api }) {
  const { doc, words } = state;
  const locked = state.status !== "ready";
  const model = useMemo(() => buildTranscriptModel(words, doc), [words, doc]);
  const info = coldOpenInfo(model);
  const audition = useAudition(player, model.fps);
  const [listOpen, setListOpen] = useState(false);
  const [message, setMessage] = useState(null);
  const [status, setStatus] = useState(null);
  const listId = useId();
  const playing = audition.playing === "coldopen";

  const remove = () => {
    const result = runCommands(dispatch, [{ type: "SetColdOpen", args: null, mergeKey: null }]);
    setMessage(result.ok ? null : result.message);
    setStatus(result.ok ? "Cold open dihapus." : null);
  };

  return (
    <div className={styles.body} data-quick-body="coldopen">
      {message ? <p className={styles.message} role="alert">{message}</p> : null}
      {/* The new quote is the visible answer; this line says it to screen readers. */}
      <p className={styles.srOnly} role="status" data-coldopen-status="">{status ?? ""}</p>
      {info ? (
        <div className={styles.quote}>
          <p className={styles.quoteText} data-coldopen-line="">“{info.text}”</p>
          <p className={styles.quoteMeta}>
            <span data-coldopen-length="">{formatDuration(info.frames, model.fps)}</span> · diputar paling awal
          </p>
        </div>
      ) : (
        <p className={styles.note} data-coldopen-empty="">Belum ada cold open.</p>
      )}
      <div className={styles.row}>
        {info ? (
          <PillButton className={styles.grow} disabled={!player?.seek} aria-pressed={playing}
            aria-label={playing ? "Hentikan cold open" : "Putar cold open"}
            onClick={() => (playing ? audition.stop() : audition.start("coldopen", { f0: 0, f1: info.frames }))}>
            {playing ? "Hentikan" : "Putar"}
          </PillButton>
        ) : null}
        <PillButton className={styles.grow} aria-expanded={listOpen} aria-controls={listId}
          onClick={() => setListOpen((open) => !open)}>
          {info ? "Ganti kalimat" : "Pilih kalimat"}
        </PillButton>
      </div>
      <div id={listId} hidden={!listOpen}>
        <ColdOpenSuggestions state={state} dispatch={dispatch} player={player} api={api} model={model} readOnly={locked} touch
          onResult={(result) => { setMessage(result.error ?? null); setStatus(result.status ?? null); }} />
      </div>
      <TransitionSection doc={doc} dispatch={dispatch} player={player} readOnly={locked} touch
        onResult={(error) => { setMessage(error); setStatus(null); }} />
      {info ? (
        <PillButton variant="quiet" className={styles.start} disabled={locked} onClick={remove}>Hapus cold open</PillButton>
      ) : null}
    </div>
  );
}

export default function ColdOpenCard({ state, dispatch, player, api = null }) {
  if (!state?.doc || !state?.words) return <p className={styles.note} role="status">Membuka cold open…</p>;
  return <ColdOpenBody state={state} dispatch={dispatch} player={player} api={api} />;
}
