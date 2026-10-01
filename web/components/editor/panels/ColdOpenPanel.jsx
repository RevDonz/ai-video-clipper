"use client";

// The cold-open panel (plan §11.2 T2.7, §11.3 T3.7, §3.4, §7.2): on/off, the current line and
// its length, one word more or less on each edge (NudgeColdOpen), "Jadikan cold open" from the
// transcript selection (shared through transcript/selection.mjs), disabled with its reason
// outside 0.5–8 s or when it would only repeat the opening, and the suggestions: the selection's
// cold open, the hook sentence and the strongest sentences of the clip (GET
// coldopen-suggestions), each with "Putar" (plays it where the clip shows it, then stops) and
// "Pakai" (one SetColdOpen, undoable).
// Props: { state, dispatch, player } (panels/index.mjs), and `api` when the shell passes it.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { runCommands } from "../transcript/actions.mjs";
import { buildTranscriptModel, coldOpenCheck, coldOpenInfo, formatDuration, midSf } from "../transcript/model.mjs";
import { clampSelection, selectionRange, selectionStoreFor } from "../transcript/selection.mjs";
import css from "./ColdOpenPanel.module.css";
import { candidateViews, readCandidates, resolveEditorApi } from "./coldopen-suggestions.mjs";
import styles from "./panels.module.css";

const NUDGES = [
  { key: "inEarlier", label: "Tambah kata sebelum", edge: "in", words: -1 },
  { key: "inLater", label: "Buang kata pertama", edge: "in", words: 1 },
  { key: "outEarlier", label: "Buang kata terakhir", edge: "out", words: -1 },
  { key: "outLater", label: "Tambah kata sesudah", edge: "out", words: 1 },
];

// Suggestions of a clip's revision 0, kept while the page lives (they only change with the seed).
const suggestionCache = new Map();

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

/** Plays `[f0, f1)` from the player, then pauses at its end; one audition at a time. */
function useAudition(player, fps) {
  const [playing, setPlaying] = useState(null);
  const stopRef = useRef(() => {});
  const stop = useCallback(() => {
    stopRef.current();
    stopRef.current = () => {};
    setPlaying(null);
  }, []);
  useEffect(() => stop, [stop]);
  const start = useCallback(async (id, { f0, f1 }) => {
    stop();
    if (!player?.seek) return;
    setPlaying(id);
    await player.seek(f0);
    await player.play?.();
    const grace = Math.max(1, Math.round(fps[0] / fps[1]));
    let done = false;
    const finish = (pause) => {
      if (done) return;
      done = true;
      if (pause) player.pause?.();
      stopRef.current();
      stopRef.current = () => {};
      setPlaying((current) => (current === id ? null : current));
    };
    if (typeof player.subscribeFrame === "function") {
      const unsubscribe = player.subscribeFrame((frame) => {
        if (frame >= f1 - 1 && frame <= f1 + grace) finish(true);
        else if (frame < f0 - 1 || frame > f1 + grace) finish(false); // the user moved elsewhere
      });
      stopRef.current = unsubscribe;
    } else {
      const timer = setTimeout(() => finish(true), ((f1 - f0) * 1000 * fps[1]) / fps[0] + 100);
      stopRef.current = () => clearTimeout(timer);
    }
  }, [player, fps, stop]);
  return { playing, start, stop };
}

function Suggestions({ state, dispatch, player, api, model, readOnly, onResult }) {
  const suggestions = useSuggestions({ api, state });
  const views = useMemo(() => candidateViews({ candidates: suggestions.candidates, model }), [suggestions.candidates, model]);
  const audition = useAudition(player, model.fps);

  const apply = (view) => {
    audition.stop();
    const result = runCommands(dispatch, [view.command]);
    onResult(result.ok ? { status: `Cold open diganti: saran ${view.number}.` } : { error: result.message });
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
    <div className={styles.section} aria-labelledby="coldopen-suggestions-title">
      <h3 className={styles.subtitle} id="coldopen-suggestions-title">Saran cold open</h3>
      <p className={styles.note}>Dari cold open awal, kalimat hook, dan kalimat terkuat di klip ini. Putar dulu, lalu pakai yang paling menarik.</p>
      <div data-suggestions-state={suggestions.status === "ready" && !views.length ? "empty" : suggestions.status}
        aria-busy={suggestions.status === "loading"}>
        {body}
      </div>
    </div>
  );
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
          <label className={styles.switch} title={!info && !enableFrom ? "Pilih kalimat di Transkrip dulu" : undefined}>
            <input type="checkbox" role="switch" className={styles.switchInput} checked={info !== null}
              disabled={readOnly || (info === null && !enableFrom)} onChange={(event) => toggle(event.target.checked)} />
            <span className={styles.switchTrack} aria-hidden="true" />
            <span>Cold open aktif</span>
          </label>
        </div>
        <p className={styles.note}>
          Potongan singkat (0,5–8 dtk) yang diputar lebih dulu, lalu klip mulai dari awal. Sambungannya potong
          langsung dengan fade audio 30 ms.
        </p>
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

      <Suggestions state={state} dispatch={dispatch} player={player} api={api} model={model} readOnly={readOnly}
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
