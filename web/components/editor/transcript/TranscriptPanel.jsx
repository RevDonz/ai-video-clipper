"use client";

// The transcript, the editor's spine (plan Appendix C.2): a custom word list, not
// contenteditable. Sentence units are paragraphs and words are spans; words outside the clip are
// dimmed ("Perpanjang ke sini"), removed words are struck through behind a restore chip, hidden
// words are outlined, keywords take their colour, and the active word follows playback (outside
// React). Selection: click, Shift+click or drag; arrows move, Shift+arrows extend. Actions on a
// selection: Delete/Backspace cut, Enter or double-click edits, Ctrl+Shift+X hides from captions,
// Ctrl+E marks a keyword, I / O trim, Ctrl+Shift+H makes a cold open. Each also has a button.
//
// Props: { state, dispatch, player, api? } (panels/index.mjs). Everything the panel shows comes
// from `state.doc` and `state.words` through `model.mjs`, synchronously, so a command updates the
// transcript before the plan DTO arrives.
//
// "Rapikan" (T3.5, plan §7.3): the header button opens the review of fillers, repeats and long
// gaps (CleanupReview.jsx, cleanup-model.mjs); while it is open the transcript marks the words
// and gaps it proposes. The list comes from `api.cleanup()` (Appendix A.2): with an `api` prop it
// is fetched when the panel opens (so the button can count it); without one the panel builds an
// API client for the clip and asks only when the review is opened.
import { Fragment, memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { createApiClient } from "../../../lib/editor/api-client.mjs";
import { createContext } from "../../../lib/editor/doc-model.mjs";
import { commandsFor, keyAction, runCommands, selectionActions } from "./actions.mjs";
import { followActiveWord } from "./active-word.mjs";
import { auditionRange, badgeMarks, cleanupView, planApply } from "./cleanup-model.mjs";
import CleanupReview from "./CleanupReview.jsx";
import { buildTranscriptModel, coldOpenInfo, formatDuration, seekFrameOf } from "./model.mjs";
import RemovalChip from "./RemovalChip.jsx";
import {
  NO_SELECTION,
  clampSelection,
  extendFocus,
  extendTo,
  isEmpty,
  moveFocus,
  selectOne,
  selectionRange,
  selectionStoreFor,
} from "./selection.mjs";
import styles from "./transcript.module.css";
import WordEditor from "./WordEditor.jsx";
import WordSpan from "./WordSpan.jsx";

const SECONDS = new Intl.NumberFormat("id-ID", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const HELP_ID = "transcript-help";
const GAP_TITLES = Object.freeze({ gap_silent: "Rapikan: jeda hening", gap_voiced: "Rapikan: jeda bersuara (dengarkan dulu)" });

const Paragraph = memo(function Paragraph({ para, selFirst, selLast, editing, onEditDone, onRestore, readOnly, marks }) {
  const items = [];
  let chip = 0;
  const chipsBefore = (index) => {
    while (chip < para.chips.length && para.chips[chip].before <= index) {
      const entry = para.chips[chip];
      items.push(
        <Fragment key={`chip:${entry.removalId}`}>
          <RemovalChip chip={entry} onRestore={onRestore} disabled={readOnly} />{" "}
        </Fragment>,
      );
      chip += 1;
    }
  };
  for (let k = 0; k < para.states.length; k += 1) {
    const state = para.states[k];
    const index = para.start + k;
    chipsBefore(index);
    const gap = marks?.gaps.get(index);
    items.push(
      <Fragment key={state.id}>
        {index === editing
          ? <WordEditor state={state} onDone={onEditDone} />
          : <WordSpan state={state} selected={selFirst <= index && index <= selLast} cleanup={marks?.words.get(index) ?? null} />}{" "}
        {gap ? <><span className={styles.gapMark} data-cleanup-gap={gap} title={GAP_TITLES[gap]} aria-hidden="true">jeda</span>{" "}</> : null}
      </Fragment>,
    );
  }
  chipsBefore(Infinity);
  return (
    <p className={styles.para} data-unit={para.unit ?? ""} data-zone={para.zone} data-cold-para={para.cold ? "" : undefined}>
      {items}
    </p>
  );
});

// Paragraphs wholly outside the clip, except the one next to each edge, are folded away.
function foldedContext(paragraphs) {
  let before = 0;
  while (before < paragraphs.length && paragraphs[before].zone === "before" && !paragraphs[before].cold) before += 1;
  let after = paragraphs.length;
  while (after > before && paragraphs[after - 1].zone === "after" && !paragraphs[after - 1].cold) after -= 1;
  return { before: Math.max(0, before - 1), after: Math.min(paragraphs.length, after + 1) };
}

function spanMs(words, first, last) {
  return words[last].e - words[first].s;
}

// The word on the previous or next visual line nearest the focus word's centre.
function lineTarget(list, index, direction) {
  const from = list?.querySelector(`[data-w="${index}"]`);
  if (!from) return -1;
  const origin = from.getBoundingClientRect();
  const centre = origin.left + origin.width / 2;
  const nodes = list.querySelectorAll("[data-w]");
  let position = Array.prototype.indexOf.call(nodes, from);
  let lineTop = null;
  let best = -1;
  let bestDistance = Infinity;
  for (position += direction; position >= 0 && position < nodes.length; position += direction) {
    const box = nodes[position].getBoundingClientRect();
    if (lineTop === null) {
      if (Math.abs(box.top - origin.top) < origin.height / 2) continue;
      lineTop = box.top;
    } else if (Math.abs(box.top - lineTop) >= origin.height / 2) break;
    const distance = Math.abs(box.left + box.width / 2 - centre);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = Number(nodes[position].dataset.w);
    }
  }
  return best;
}

// The Rapikan list of the clip's current words: `{status, listing, load}`. Fetched once per
// words artifact, when `eager` (an `api` prop was given) or when `wanted` (the review is open).
function useCleanupList({ api, jobId, clipId, wordsKey, eager, wanted }) {
  const client = useMemo(() => {
    if (api?.cleanup) return api;
    try {
      return createApiClient({ jobId, clipId });
    } catch {
      return null;
    }
  }, [api, jobId, clipId]);
  const [entry, setEntry] = useState({ key: null, status: "idle", listing: null });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const key = `${clipId}:${wordsKey}`;
  const load = useCallback(() => {
    if (!client) {
      setEntry({ key, status: "error", listing: null });
      return;
    }
    setEntry({ key, status: "loading", listing: null });
    client.cleanup().then(
      (listing) => { if (alive.current) setEntry({ key, status: "ready", listing }); },
      () => { if (alive.current) setEntry({ key, status: "error", listing: null }); },
    );
  }, [client, key]);
  const current = entry.key === key ? entry : { key, status: "idle", listing: null };
  useEffect(() => {
    if ((eager || wanted) && current.status === "idle") load();
  }, [eager, wanted, current.status, load]);
  return { status: current.status, listing: current.listing, load };
}

function Transcript({ state, dispatch, player, api }) {
  const { doc, words } = state;
  const readOnly = state.status !== "ready";
  const listRef = useRef(null);
  const previous = useRef(null);
  const model = useMemo(() => buildTranscriptModel(words, doc, previous.current), [words, doc]);
  const modelRef = useRef(model);
  useEffect(() => {
    previous.current = model;
    modelRef.current = model;
  }, [model]);

  const selectionStore = selectionStoreFor(doc.clip_id);
  const rawSelection = useSyncExternalStore(selectionStore.subscribe, selectionStore.get, selectionStore.get);
  const count = model.states.length;
  const selection = clampSelection(rawSelection, count);
  const range = selectionRange(selection);
  const actions = useMemo(() => selectionActions(model, selection, { readOnly }), [model, selection, readOnly]);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  const [editing, setEditing] = useState(-1);
  const [message, setMessage] = useState(null);
  const [expanded, setExpanded] = useState({ before: false, after: false });
  const dragging = useRef(false);
  const revealFocus = useRef(false);

  // Callbacks read the latest dispatch through a ref, so they (and the memoised paragraphs) stay
  // stable even when the shell passes a new dispatch function on every render.
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;
  const focusList = useCallback(() => listRef.current?.focus({ preventScroll: true }), []);
  const run = useCallback((commands) => {
    if (!commands?.length) return false;
    const result = runCommands((...args) => dispatchRef.current(...args), commands);
    setMessage(result.ok ? null : result.message);
    return result.ok;
  }, []);

  const perform = useCallback((name) => {
    const current = actionsRef.current;
    const entry = current[name];
    if (!entry) return;
    if (!entry.enabled) {
      if (current.range) setMessage(entry.reason);
      return;
    }
    if (name === "edit") {
      setEditing(entry.index);
      return;
    }
    const ok = run(commandsFor(name, current));
    if (ok && name === "remove") {
      // Continue after the cut, like deleting text.
      const states = modelRef.current.states;
      let next = current.range[1] + 1;
      while (next < states.length && !(states[next].zone === "body" && states[next].removal === null)) next += 1;
      selectionStore.set(next < states.length ? selectOne(next) : NO_SELECTION);
    }
  }, [run, selectionStore]);

  const onRestore = useCallback((removalId) => {
    run([{ type: "RestoreRemoval", args: { removalId }, mergeKey: null }]);
  }, [run]);

  // --- Rapikan ------------------------------------------------------------------------------
  const [reviewOpen, setReviewOpen] = useState(false);
  const [overrides, setOverrides] = useState(() => new Map());
  const [reviewMessage, setReviewMessage] = useState(null);
  const [playing, setPlaying] = useState(null);
  const playTimer = useRef(null);
  const cleanup = useCleanupList({
    api, jobId: state.jobId ?? doc.base?.job_id, clipId: doc.clip_id, wordsKey: doc.base?.words?.sha256 ?? "",
    eager: Boolean(api?.cleanup), wanted: reviewOpen,
  });
  const seedDoc = state.seed ?? null;
  // The command context: the seed fixes fps, output size and window (a document without a seed
  // in the state carries the same values, so it is read once, not on every command).
  const cleanupCtx = useMemo(() => (cleanup.listing ? createContext({ words, seed: seedDoc ?? modelRef.current.doc }) : null),
    [cleanup.listing, words, seedDoc]);
  const deferredDoc = useDeferredValue(doc);
  const view = useMemo(() => (cleanup.listing && cleanupCtx
    ? cleanupView({ listing: cleanup.listing, doc: deferredDoc, words, ctx: cleanupCtx }) : null),
  [cleanup.listing, cleanupCtx, deferredDoc, words]);
  const marks = useMemo(() => (reviewOpen && view ? badgeMarks(view) : null), [reviewOpen, view]);
  const isChecked = useCallback((entry) => entry.checkable
    && (overrides.has(entry.id) ? overrides.get(entry.id) : entry.defaultOn), [overrides]);
  const onToggle = useCallback((id, on) => {
    setOverrides((current) => new Map(current).set(id, on));
  }, []);
  const onGroup = useCallback((kind, on) => {
    setOverrides((current) => {
      const next = new Map(current);
      for (const entry of view?.entries ?? []) if (entry.kind === kind && entry.checkable) next.set(entry.id, on);
      return next;
    });
  }, [view]);
  const onApply = useCallback(() => {
    if (!view || !cleanupCtx) return;
    const checked = new Set(view.entries.filter(isChecked).map((entry) => entry.id));
    const plan = planApply({ view, checked, doc: modelRef.current.doc, ctx: cleanupCtx });
    if (!plan.args.items.length) {
      setReviewMessage(plan.skipped[0]?.message ?? "Tidak ada saran yang dipilih.");
      return;
    }
    const result = runCommands((...args) => dispatchRef.current(...args), [{ type: "ApplyCleanup", args: plan.args, mergeKey: null }]);
    if (!result.ok) {
      setReviewMessage(result.message);
      return;
    }
    const skipped = plan.skipped.length ? ` · ${plan.skipped.length} dilewati (${plan.skipped[0].message.replace(/\.$/, "")})` : "";
    setReviewMessage(`${plan.args.items.length} saran diterapkan${skipped}. Urungkan dengan Ctrl+Z.`);
    setOverrides(new Map());
  }, [view, cleanupCtx, isChecked]);
  const stopAudition = useCallback(() => {
    clearTimeout(playTimer.current);
    playTimer.current = null;
    setPlaying(null);
  }, []);
  useEffect(() => () => clearTimeout(playTimer.current), []);
  const onPlay = useCallback((entry) => {
    if (playing === entry.id) {
      player?.pause?.();
      stopAudition();
      return;
    }
    const span = auditionRange(entry, modelRef.current);
    if (!span || !player?.seek) {
      setReviewMessage("Bagian ini tidak ada di klip sekarang.");
      return;
    }
    clearTimeout(playTimer.current);
    setPlaying(entry.id);
    Promise.resolve(player.seek(span.from)).then(() => player.play?.()).catch(() => stopAudition());
    const [num, den] = modelRef.current.fps;
    playTimer.current = setTimeout(() => {
      player.pause?.();
      stopAudition();
    }, Math.round(((span.to - span.from) * den * 1000) / num));
  }, [playing, player, stopAudition]);
  const onReveal = useCallback((entry) => {
    const first = entry.wordIdx.length ? entry.wordIdx[0] : entry.afterIdx;
    const last = entry.wordIdx.length ? entry.wordIdx.at(-1) : entry.beforeIdx;
    const paragraphs = modelRef.current.paragraphs;
    const folded = foldedContext(paragraphs);
    if (folded.before > 0 && first < paragraphs[folded.before].start) setExpanded((value) => ({ ...value, before: true }));
    if (folded.after < paragraphs.length && last >= paragraphs[folded.after].start) setExpanded((value) => ({ ...value, after: true }));
    revealFocus.current = true;
    selectionStore.set(extendTo(selectOne(first), last));
  }, [selectionStore]);
  const toggleReview = useCallback(() => {
    setReviewOpen((open) => !open);
    setReviewMessage(null);
  }, []);
  const openCount = view ? view.entries.length : null;

  const onEditDone = useCallback((index, text, how) => {
    const states = modelRef.current.states;
    const target = states[index];
    if (text !== null && target) {
      const clean = text.normalize("NFC").trim();
      if (!clean) setMessage("Kata tidak boleh kosong; pakai Delete untuk memotongnya.");
      else if ([...clean].length > 40) setMessage("Kata maksimal 40 karakter.");
      else if (clean !== target.text) run([{ type: "EditWordText", args: { wordId: target.id, text: clean }, mergeKey: `word:${target.id}` }]);
    }
    const next = how === "next" ? index + 1 : how === "prev" ? index - 1 : -1;
    if (next >= 0 && next < states.length) {
      setEditing(next);
      selectionStore.set(selectOne(next));
      return;
    }
    setEditing(-1);
    focusList();
  }, [focusList, run, selectionStore]);

  // The active word, outside React.
  useEffect(() => followActiveWord({ list: listRef.current, player, getModel: () => modelRef.current }), [player]);

  useEffect(() => {
    const stop = () => { dragging.current = false; };
    window.addEventListener("mouseup", stop);
    return () => window.removeEventListener("mouseup", stop);
  }, []);

  const folded = foldedContext(model.paragraphs);
  const showFrom = expanded.before ? 0 : folded.before;
  const showTo = expanded.after ? model.paragraphs.length : folded.after;

  // A keyboard move into folded context unfolds it; the focus word stays in view.
  const focusIndex = isEmpty(selection) ? -1 : selection.focus;
  useEffect(() => {
    if (focusIndex < 0) return;
    const paragraphs = modelRef.current.paragraphs;
    if (!expanded.before && folded.before > 0 && focusIndex < paragraphs[folded.before].start) setExpanded((value) => ({ ...value, before: true }));
    if (!expanded.after && folded.after < paragraphs.length && focusIndex >= paragraphs[folded.after].start) setExpanded((value) => ({ ...value, after: true }));
    if (revealFocus.current) {
      revealFocus.current = false;
      listRef.current?.querySelector(`[data-w="${focusIndex}"]`)?.scrollIntoView({ block: "nearest" });
    }
  }, [focusIndex, expanded, folded.before, folded.after]);

  const wordIndexOf = (target) => {
    const node = target?.closest?.("[data-w]");
    return node && listRef.current?.contains(node) ? Number(node.dataset.w) : -1;
  };

  const onMouseDown = (event) => {
    if (event.button !== 0 || event.target.closest?.("input, button")) return;
    const index = wordIndexOf(event.target);
    if (index < 0) return;
    event.preventDefault();
    focusList();
    selectionStore.set(event.shiftKey ? extendTo(selectionStore.get(), index) : selectOne(index));
    dragging.current = !event.shiftKey;
  };
  const onMouseOver = (event) => {
    if (!dragging.current || !(event.buttons & 1)) return;
    const index = wordIndexOf(event.target);
    if (index >= 0) selectionStore.set(extendTo(selectionStore.get(), index));
  };
  const onClick = (event) => {
    const index = wordIndexOf(event.target);
    if (index < 0 || !player?.seek) return;
    const frame = seekFrameOf(modelRef.current, index);
    if (frame !== null) player.seek(frame);
  };
  const onDoubleClick = (event) => {
    const index = wordIndexOf(event.target);
    if (index >= 0 && !readOnly) setEditing(index);
  };
  const onKeyDown = (event) => {
    if (event.target !== event.currentTarget) return;
    const name = keyAction(event);
    if (!name) return;
    event.preventDefault();
    event.stopPropagation();
    const current = selectionStore.get();
    const move = (next) => {
      revealFocus.current = true;
      selectionStore.set(next);
    };
    switch (name) {
      case "next": return move(moveFocus(current, 1, count));
      case "prev": return move(moveFocus(current, -1, count));
      case "extendNext": return move(extendFocus(current, 1, count));
      case "extendPrev": return move(extendFocus(current, -1, count));
      case "lineDown":
      case "lineUp":
      case "extendLineDown":
      case "extendLineUp": {
        if (isEmpty(current)) return move(moveFocus(current, name.endsWith("Up") ? -1 : 1, count));
        const target = lineTarget(listRef.current, current.focus, name.endsWith("Up") ? -1 : 1);
        if (target < 0) return undefined;
        return move(name.startsWith("extend") ? extendTo(current, target) : selectOne(target));
      }
      case "clear":
        setMessage(null);
        return selectionStore.set(NO_SELECTION);
      default:
        return perform(name);
    }
  };

  const toolbarAction = (name) => () => {
    perform(name);
    focusList();
  };

  const selFirst = range ? range[0] : -1;
  const selLast = range ? range[1] : -1;
  const list = words.words;
  const status = range
    ? `${selLast - selFirst + 1} kata dipilih · ${SECONDS.format(spanMs(list, selFirst, selLast) / 1000)} dtk`
    : "Klik kata untuk memilih; Shift+klik untuk rentang.";
  const coldOpen = coldOpenInfo(model);
  const hiddenBefore = model.paragraphs.slice(0, showFrom);
  const hiddenAfter = model.paragraphs.slice(showTo);
  const contextLabel = (paras, side) => {
    const first = paras[0].start;
    const last = paras.at(-1).end - 1;
    return `Tampilkan ${paras.length} kalimat ${side} (${SECONDS.format(spanMs(list, first, last) / 1000)} dtk)`;
  };
  const tool = (name, label, shortcut, extra = {}) => {
    const entry = actions[name];
    return (
      <button type="button" className={styles.tool} disabled={!entry.enabled}
        title={[shortcut, entry.enabled ? null : entry.reason].filter(Boolean).join(" · ") || undefined}
        onClick={toolbarAction(name)} {...extra}>
        {label}
      </button>
    );
  };

  return (
    <section data-panel="transcript" className={styles.panel} aria-busy={false}>
      <div className={styles.header}>
        <div role="toolbar" aria-label="Aksi kata" className={styles.toolbar}>
          {tool("remove", "Hapus", "Delete")}
          {tool("restore", "Pulihkan", null)}
          {tool("edit", "Edit kata", "Enter")}
          {tool("hide", "Sembunyikan", "Ctrl+Shift+X", { "aria-pressed": actions.hide.enabled ? !actions.hide.on : undefined })}
          {tool("emphasis", "Kata kunci", "Ctrl+E", { "aria-pressed": actions.emphasis.enabled ? !actions.emphasis.on : undefined })}
          {tool("trimStart", "Mulai di sini", "I")}
          {tool("trimEnd", "Akhiri di sini", "O")}
          {tool("extend", "Perpanjang ke sini", null)}
          {tool("coldOpen", "Jadikan cold open", "Ctrl+Shift+H")}
        </div>
        <div className={styles.cleanupBar}>
          <p className={styles.status} role="status" data-transcript-status="">{status}</p>
          <button type="button" className={`${styles.tool} ${styles.cleanupToggle}`} aria-expanded={reviewOpen}
            aria-controls="cleanup-review" data-cleanup-toggle="" onClick={toggleReview}
            title="Kata pengisi, pengulangan dan jeda panjang yang bisa dipotong">
            Rapikan{openCount !== null ? <> <span className={styles.cleanupCount}>{openCount}</span></> : null}
          </button>
        </div>
        {message ? <p className={styles.message} role="alert" data-transcript-message="">{message}</p> : null}
        {coldOpen ? (
          <p className={styles.coldNote}>
            <span className={styles.coldTag}>Cold open</span> “{coldOpen.text}” · {formatDuration(coldOpen.frames, model.fps)}
          </p>
        ) : null}
      </div>
      {reviewOpen ? (
        <CleanupReview view={view} status={cleanup.status} isChecked={isChecked} onToggle={onToggle} onGroup={onGroup}
          onApply={onApply} onPlay={onPlay} playing={playing} onReveal={onReveal} onRetry={cleanup.load}
          readOnly={readOnly} message={reviewMessage} />
      ) : null}
      <p id={HELP_ID} className={styles.srOnly}>
        Panah memindah pilihan, Shift+panah memperluas. Delete memotong kata, Enter mengedit, Ctrl+Shift+X
        menyembunyikan dari caption, Ctrl+E menandai kata kunci, I dan O memotong awal dan akhir klip, Ctrl+Shift+H
        menjadikan cold open.
      </p>
      <div
        ref={listRef}
        className={styles.words}
        role="group"
        aria-label="Transkrip"
        aria-describedby={HELP_ID}
        tabIndex={0}
        data-transcript-words=""
        style={{ "--tr-emphasis": doc.captions?.overrides?.emphasis ?? "#FF5C8A" }}
        onMouseDown={onMouseDown}
        onMouseOver={onMouseOver}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
      >
        {model.paragraphs.length === 0 ? <p className={styles.loading}>Transkrip klip ini kosong.</p> : null}
        {hiddenBefore.length ? (
          <button type="button" className={styles.context} onClick={() => setExpanded((value) => ({ ...value, before: true }))}>
            {contextLabel(hiddenBefore, "sebelumnya")}
          </button>
        ) : null}
        {expanded.before && folded.before > 0 ? (
          <button type="button" className={styles.context} onClick={() => setExpanded((value) => ({ ...value, before: false }))}>
            Sembunyikan kalimat sebelumnya
          </button>
        ) : null}
        {model.paragraphs.slice(showFrom, showTo).map((para) => {
          const inside = selFirst < para.end && selLast >= para.start;
          return (
            <Paragraph
              key={para.key}
              para={para}
              selFirst={inside ? selFirst : -1}
              selLast={inside ? selLast : -1}
              editing={editing >= para.start && editing < para.end ? editing : -1}
              onEditDone={onEditDone}
              onRestore={onRestore}
              readOnly={readOnly}
              marks={marks}
            />
          );
        })}
        {hiddenAfter.length ? (
          <button type="button" className={styles.context} onClick={() => setExpanded((value) => ({ ...value, after: true }))}>
            {contextLabel(hiddenAfter, "sesudahnya")}
          </button>
        ) : null}
        {expanded.after && folded.after < model.paragraphs.length ? (
          <button type="button" className={styles.context} onClick={() => setExpanded((value) => ({ ...value, after: false }))}>
            Sembunyikan kalimat sesudahnya
          </button>
        ) : null}
      </div>
    </section>
  );
}

export default function TranscriptPanel({ state, dispatch, player, api = null }) {
  if (!state?.doc || !state?.words) {
    return (
      <section data-panel="transcript" className={styles.panel} aria-busy="true">
        <p className={styles.loading}>Membuka transkrip…</p>
      </section>
    );
  }
  return <Transcript state={state} dispatch={dispatch} player={player} api={api} />;
}
