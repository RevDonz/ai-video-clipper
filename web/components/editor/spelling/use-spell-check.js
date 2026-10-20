"use client";

// Cek ejaan's controller and view state for the review (SpellingReview.jsx), shared by the
// transcript panel (Mode Lengkap) and the Teks caption card (Mode Cepat). The controller is kept
// per clip and API client (model.mjs `spellingFor`), so a view switch or a closed review never
// asks again; the first check runs when a review opens. Accepting runs the rows' commands under
// one merge key (one Urungkan); "Putar" plays the words from the preview.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { createContext } from "../../../lib/editor/doc-model.mjs";
import { useEditorApi } from "../suggestions/use-hook-suggestions.js";
import { actionKey, runCommands } from "../transcript/actions.mjs";
import { auditionRange } from "../transcript/cleanup-model.mjs";
import { COPY, planAccept, spellingFor, spellingRows } from "./model.mjs";

const IDLE = Object.freeze({ phase: "idle", suggestions: [], truncated: false, code: null, message: null, retryAfterMs: null, skipped: [] });
const NO_ROWS = Object.freeze({ rows: [], applied: 0, stale: 0, skipped: 0 });
const noop = () => () => {};

/**
 * `{ view, rows, applied, stale, skipped, readOnly, message, playing, accept(row), acceptAll(),
 * skip(row), restoreSkipped(), again(), play(row) }` for the clip in `state`; `model` is the
 * transcript model of the current document (the panel or card already builds one).
 */
export function useSpellCheck({ state, dispatch, api, player, model, open }) {
  const doc = state?.doc ?? null;
  const words = state?.words ?? null;
  const clipId = state?.clipId ?? doc?.clip_id ?? null;
  const client = useEditorApi(api, state?.jobId ?? doc?.base?.job_id, clipId);
  const controller = useMemo(() => spellingFor(client, clipId), [client, clipId]);
  const subscribe = useCallback((listener) => (controller ? controller.subscribe(listener) : noop()), [controller]);
  const snapshot = useCallback(() => (controller ? controller.getState() : IDLE), [controller]);
  const view = useSyncExternalStore(subscribe, snapshot, () => IDLE);
  const [message, setMessage] = useState(null);
  const [playing, setPlaying] = useState(null);
  const playTimer = useRef(null);

  useEffect(() => {
    if (open && controller && doc) controller.ensure(doc);
  }, [open, controller, doc]);

  // The command context: the seed fixes fps, output size and window; without a seed in the state
  // the first document carries the same values.
  const firstDoc = useRef(doc);
  if (!firstDoc.current && doc) firstDoc.current = doc;
  const seed = state?.seed ?? firstDoc.current;
  const ctx = useMemo(() => (words && seed ? createContext({ words, seed }) : null), [words, seed]);

  const summary = useMemo(() => (view.phase === "done" && model
    ? spellingRows({ suggestions: view.suggestions, model, skipped: view.skipped }) : NO_ROWS),
  [view.phase, view.suggestions, view.skipped, model]);

  const readOnly = state?.status !== "ready";
  const apply = (rows) => {
    if (readOnly || !rows.length || !ctx || !doc) return false;
    const plan = planAccept({ rows, doc, ctx, mergeKey: actionKey("spelling") });
    if (!plan.commands.length) {
      setMessage(plan.skipped[0]?.message ?? null);
      return false;
    }
    const result = runCommands(dispatch, plan.commands);
    if (!result.ok) {
      setMessage(result.message);
      return false;
    }
    const note = plan.skipped.length ? ` · ${COPY.skipped(plan.skipped.length)} (${plan.skipped[0].message.replace(/\.$/, "")})` : "";
    setMessage(COPY.accepted(plan.accepted, note));
    return true;
  };

  const stopPlaying = useCallback(() => {
    clearTimeout(playTimer.current);
    playTimer.current = null;
    setPlaying(null);
  }, []);
  useEffect(() => () => clearTimeout(playTimer.current), []);

  const play = (row) => {
    if (playing === row.id) {
      player?.pause?.();
      stopPlaying();
      return;
    }
    const span = model ? auditionRange({ s: row.s, e: row.e }, model) : null;
    if (!span || !player?.seek) {
      setMessage(COPY.missing);
      return;
    }
    clearTimeout(playTimer.current);
    setPlaying(row.id);
    Promise.resolve(player.seek(span.from)).then(() => player.play?.()).catch(() => stopPlaying());
    const [num, den] = model.fps;
    playTimer.current = setTimeout(() => {
      player.pause?.();
      stopPlaying();
    }, Math.round(((span.to - span.from) * den * 1000) / num));
  };

  return {
    view,
    ...summary,
    readOnly,
    message,
    playing,
    accept: (row) => apply([row]),
    acceptAll: () => apply(summary.rows),
    skip: (row) => {
      setMessage(null);
      controller?.skip(row.id);
    },
    restoreSkipped: () => controller?.restoreSkipped(),
    again: () => {
      setMessage(null);
      if (doc) controller?.check(doc);
    },
    play,
  };
}
