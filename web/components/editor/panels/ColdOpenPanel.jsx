"use client";

// The cold-open panel (plan §11.2 T2.7, §11.3 T3.7, §3.4, §7.2): on/off, the current line and
// its length, one word more or less on each edge (NudgeColdOpen), "Jadikan cold open" from the
// transcript selection (shared through transcript/selection.mjs), disabled with its reason
// outside 0.5–8 s or when it would only repeat the opening, and the suggestions
// (ColdOpenSuggestions.jsx). The Transisi section (TransitionSection.jsx) sets the effect at the
// join of the cold open and the clip (SetJoinStyle, SetJoinSfx;
// docs/plans/2026-10-02-transisi-cold-open.md §7.1) and plays one second on each side of it.
// Mode Cepat's Cold open card renders the same two parts.
// Props: { state, dispatch, player } (panels/index.mjs), and `api` when the shell passes it.
import { useMemo, useState, useSyncExternalStore } from "react";

import { runCommands } from "../transcript/actions.mjs";
import { buildTranscriptModel, coldOpenCheck, coldOpenInfo, formatDuration, midSf } from "../transcript/model.mjs";
import { clampSelection, selectionRange, selectionStoreFor } from "../transcript/selection.mjs";
import Switch from "../ui/Switch.jsx";
import ColdOpenSuggestions from "./ColdOpenSuggestions.jsx";
import css from "./ColdOpenPanel.module.css";
import styles from "./panels.module.css";
import TransitionSection from "./TransitionSection.jsx";

const NUDGES = [
  { key: "inEarlier", label: "Tambah kata sebelum", edge: "in", words: -1 },
  { key: "inLater", label: "Buang kata pertama", edge: "in", words: 1 },
  { key: "outEarlier", label: "Buang kata terakhir", edge: "out", words: -1 },
  { key: "outLater", label: "Tambah kata sesudah", edge: "out", words: 1 },
];

// The seed's cold open as words, to turn a removed cold open back on.
function seedColdOpenWords(seed, words) {
  const segment = seed?.main?.segments?.find((entry) => entry.role === "cold_open");
  if (!segment) return null;
  const fps = seed.output.fps;
  let first = -1;
  let last = -1;
  words.words.forEach((word, index) => {
    const mid = midSf(word, fps);
    if (segment.in_sf <= mid && mid < segment.out_sf) {
      if (first < 0) first = index;
      last = index;
    }
  });
  return first < 0 ? null : [first, last];
}

function ColdOpenBody({ state, dispatch, player, api }) {
  const { doc, words } = state;
  const readOnly = state.status !== "ready";
  const model = useMemo(() => buildTranscriptModel(words, doc), [words, doc]);
  const info = coldOpenInfo(model);
  const store = selectionStoreFor(doc.clip_id);
  const rawSelection = useSyncExternalStore(store.subscribe, store.get, store.get);
  const range = selectionRange(clampSelection(rawSelection, model.states.length));
  const candidate = coldOpenCheck(model, range?.[0] ?? -1, range?.[1] ?? -1);
  const seedWords = useMemo(() => seedColdOpenWords(state.seed, words), [state.seed, words]);
  const [message, setMessage] = useState(null);
  const [status, setStatus] = useState(null);

  const run = (commands) => {
    const result = runCommands(dispatch, commands);
    setMessage(result.ok ? null : result.message);
    setStatus(null);
    return result.ok;
  };
  const makeFrom = ([first, last]) => ({ type: "SetColdOpen",
    args: { firstWord: words.words[first].id, lastWord: words.words[last].id }, mergeKey: null });
  const enableFrom = candidate.ok ? range : seedWords;
  const toggle = (on) => {
    if (!on) run([{ type: "SetColdOpen", args: null, mergeKey: null }]);
    else if (enableFrom) run([makeFrom(enableFrom)]);
  };
  const play = async () => {
    if (!player?.seek) return;
    await player.seek(0);
    await player.play?.();
  };
  const selectionText = range
    ? model.states.slice(range[0], range[1] + 1).map((entry) => entry.text).join(" ")
    : "";

  return (
    <section data-panel="coldopen" className={styles.panel} aria-busy={false}>
      {message ? <p className={styles.message} role="alert">{message}</p> : null}
      {status ? <p className={css.status} role="status">{status}</p> : null}
      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <h3 className={styles.title}>Cold open</h3>
          <Switch label="Cold open aktif" checked={info !== null} disabled={readOnly || (info === null && !enableFrom)}
            title={!info && !enableFrom ? "Pilih kalimat di Transkrip dulu" : undefined} onChange={toggle} />
        </div>
        <p className={styles.note}>Potongan singkat (0,5–8 dtk) yang diputar lebih dulu, lalu klip mulai dari awal.</p>
        {info ? (
          <div className={styles.card}>
            <p className={styles.line} data-coldopen-line="">“{info.text}”</p>
            <p className={styles.cardMeta}>
              <span data-coldopen-length="">{formatDuration(info.frames, model.fps)}</span>
              <span>diputar di awal video</span>
            </p>
            <div className={styles.nudges} role="group" aria-label="Geser tepi cold open">
              {NUDGES.map((nudge) => {
                const entry = info.nudges[nudge.key];
                return (
                  <button key={nudge.key} type="button" className={styles.button} disabled={readOnly || !entry.ok}
                    title={entry.ok ? undefined : entry.reason}
                    onClick={() => run([{ type: "NudgeColdOpen", args: { edge: nudge.edge, words: nudge.words }, mergeKey: `co:${nudge.edge}` }])}>
                    {nudge.label}
                  </button>
                );
              })}
            </div>
            <div className={styles.row}>
              <button type="button" className={styles.button} disabled={!player?.seek} onClick={play}>Putar cold open</button>
              <button type="button" className={styles.button} disabled={readOnly}
                onClick={() => run([{ type: "SetColdOpen", args: null, mergeKey: null }])}>Hapus cold open</button>
            </div>
          </div>
        ) : (
          <p className={styles.empty}>Belum ada cold open di klip ini.</p>
        )}
      </div>

      <TransitionSection doc={doc} dispatch={dispatch} player={player} readOnly={readOnly}
        onResult={(error) => { setMessage(error); setStatus(null); }} />

      <ColdOpenSuggestions state={state} dispatch={dispatch} player={player} api={api} model={model} readOnly={readOnly}
        onResult={(result) => { setMessage(result.error ?? null); setStatus(result.status ?? null); }} />

      <div className={styles.section}>
        <h3 className={styles.subtitle}>Dari pilihan di Transkrip</h3>
        {range ? (
          <p className={styles.quote}>
            “{selectionText.length > 140 ? `${selectionText.slice(0, 140)}…` : selectionText}”
            {candidate.frames ? ` · ${formatDuration(candidate.frames, model.fps)}` : ""}
          </p>
        ) : null}
        <button type="button" className={`${styles.button} ${styles.primary}`} disabled={readOnly || !candidate.ok}
          onClick={() => run([makeFrom(range)])}>
          Jadikan cold open dari pilihan
        </button>
        <p className={candidate.ok ? styles.note : styles.reason} data-coldopen-reason="">
          {candidate.ok ? "Siap: pilihan ini akan menggantikan cold open sekarang (Ctrl+Shift+H di Transkrip)." : candidate.reason}
        </p>
      </div>
    </section>
  );
}

export default function ColdOpenPanel({ state, dispatch, player, api = null }) {
  if (!state?.doc || !state?.words) {
    return (
      <section data-panel="coldopen" className={styles.panel} aria-busy="true">
        <p className={styles.note}>Membuka panel Cold open…</p>
      </section>
    );
  }
  return <ColdOpenBody state={state} dispatch={dispatch} player={player} api={api} />;
}
