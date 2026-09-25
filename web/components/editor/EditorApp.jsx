"use client";

// Editor V3 shell (plan §11.2 T2.6, Appendix C): the top bar, the left panel's tabs (registry
// panels/index.mjs), the stage with its controls and badge (§6.1), the timeline (registry
// timeline/lanes.mjs), "Perlu dicek", the export, conflict and shortcut dialogs, the read-only and
// notice states, and the keyboard map (Appendix C.4).
//
// Seams (Appendix A.2): `runtime` (runtime.mjs) provides the store (createEditorStore), the API
// and preview clients and createPlayer. The page passes `runtimeKind`; tests may inject a runtime.
// Every panel receives { state, dispatch, player } and every lane { plan, state, dispatch, player,
// pxPerFrame } (plus `notify` and `readOnly`); `player` is the facade of runtime.mjs, which adds
// `subscribeFrame(fn)` and `frame()` so that DOM can follow playback outside React (§6.2).
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { SHORTCUTS, globalShortcut } from "../../lib/editor/shortcuts.mjs";
import ChecksPanel from "./ChecksPanel.jsx";
import ConflictDialog from "./ConflictDialog.jsx";
import tokens from "./editor.module.css";
import ExportDialog from "./ExportDialog.jsx";
import { createExportFlow } from "./export-flow.mjs";
import { PANELS } from "./panels/index.mjs";
import ReadOnlyBanner from "./ReadOnlyBanner.jsx";
import { createEditorRuntime, createFrameBus, createPlayerFacade } from "./runtime.mjs";
import styles from "./shell.module.css";
import { badgeView, checksView, conflictParts, exportMatchesSeed, messageFor, noticesView, rejectionText } from "./shell-model.mjs";
import Stage from "./Stage.jsx";
import StageControls from "./StageControls.jsx";
import Timeline from "./timeline/Timeline.jsx";
import { wordForTrimAt } from "./timeline/timeline-model.mjs";
import TopBar from "./TopBar.jsx";

const components = new Map();

function lazyComponent(entry) {
  if (!components.has(entry.file)) components.set(entry.file, lazy(entry.load));
  return components.get(entry.file);
}

const PLAYER_ERRORS = Object.freeze({
  load: "Pratinjau gagal dimuat; perubahan tetap tersimpan",
  play: "Pratinjau tidak bisa diputar di browser ini",
  seek: "Frame ini belum bisa ditampilkan",
  step: "Frame ini belum bisa ditampilkan",
  showTruthFrame: "Frame akhir gagal dimuat; coba lagi",
});
const EMPTY_STATE = Object.freeze({ status: "loading", doc: null, plan: null, pending: [], warnings: [], save: "saved" });
const TERMINAL_EXPORT = new Set(["completed", "failed", "cancelled", "error"]);
const BUSY_EXPORT = new Set(["saving", "submitting", "running"]);

function useNarrow() {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1023px)");
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return narrow;
}

function StatePage({ title, children, jobId, busy = false }) {
  return (
    <main className={`${tokens.tokens} ${styles.state}`} aria-busy={busy}>
      {busy && <div className={styles.skeleton} aria-hidden="true" />}
      <h1>{title}</h1>
      {children}
      {jobId && <p><a href={`/projects/${encodeURIComponent(jobId)}`}>Kembali ke proyek</a></p>}
    </main>
  );
}

function selectionWordIds(selection) {
  if (Array.isArray(selection)) return selection.filter((id) => typeof id === "string");
  if (Array.isArray(selection?.wordIds)) return selection.wordIds.filter((id) => typeof id === "string");
  return [];
}

function ShortcutHelp({ open, onClose }) {
  const dialogRef = useRef(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={dialogRef} className={styles.dialog} aria-labelledby="editor-help-title" onCancel={(event) => { event.preventDefault(); onClose(); }}>
      {open && (
        <>
          <div className={styles.dialogHeader}>
            <h2 id="editor-help-title">Pintasan keyboard</h2>
            <button type="button" className={`${styles.button} ${styles.quiet}`} onClick={onClose}>Tutup</button>
          </div>
          <div className={styles.dialogBody}>
            <table className={styles.shortcutTable}>
              <thead><tr><th scope="col">Tombol</th><th scope="col">Aksi</th></tr></thead>
              <tbody>
                {SHORTCUTS.map((shortcut) => (
                  <tr key={shortcut.id}>
                    <td>{shortcut.keys.map((key) => <kbd key={key} className={styles.kbd}>{key}</kbd>)}</td>
                    <td>{shortcut.description}{shortcut.scope === "transcript" ? " (di transkrip)" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className={styles.muted}>Setiap aksi juga punya tombol di layar. Pintasan tidak aktif saat Anda mengetik di kolom teks.</p>
          </div>
        </>
      )}
    </dialog>
  );
}

function EditorShell({ runtime, jobId, clipId, initialPanel }) {
  const { store, api } = runtime;
  const subscribe = useCallback((onChange) => store.subscribe(() => onChange()), [store]);
  const snapshot = useCallback(() => store.getState(), [store]);
  const state = useSyncExternalStore(subscribe, snapshot, () => EMPTY_STATE);
  const frameBus = useMemo(() => createFrameBus(), []);
  const notifyRef = useRef(() => {});
  const player = useMemo(() => createPlayerFacade(frameBus, {
    onError: (_error, action) => notifyRef.current(PLAYER_ERRORS[action] ?? PLAYER_ERRORS.load),
  }), [frameBus]);
  const [playerState, setPlayerState] = useState(null);
  const [media, setMedia] = useState(null);
  const [panelId, setPanelId] = useState(initialPanel ?? PANELS[0].id);
  const [safeZone, setSafeZone] = useState(false);
  const [checksOpen, setChecksOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const [clipInfo, setClipInfo] = useState(null);
  const [exportState, setExportState] = useState(null);
  const flowRef = useRef(null);
  const exportButtonRef = useRef(null);
  const checksButtonRef = useRef(null);
  const helpReturnRef = useRef(null);
  const tabRefs = useRef(new Map());

  const status = state.status;
  const readOnly = status === "readOnly";
  const ready = status === "ready" || readOnly;
  const plan = state.plan ?? null;
  const fps = plan?.fps ?? state.doc?.output?.fps ?? [30, 1];
  // The store's per-part conflict (T2.5 `groups`; the T2.6 specs' `parts`), shown as a dialog.
  const conflict = state.save === "conflict" && conflictParts(state.conflict).length ? state.conflict : null;
  // "Klip ini terbuka di tab lain" comes from the store's own BroadcastChannel (T2.5).
  const otherTab = state.otherTab === true;
  const modalOpen = exportOpen || helpOpen || Boolean(conflict);

  const notify = useCallback((text) => setToast({ text, id: Date.now() }), []);
  notifyRef.current = notify;

  // A one-off store notice (merged with another tab, a draft that could not be merged) is a toast.
  const noticeCode = state.notice?.code ?? null;
  useEffect(() => {
    if (!noticeCode || !state.notice?.message) return;
    notify(state.notice.message);
    store.dismissNotice?.();
  }, [noticeCode, state.notice, notify, store]);

  // The preview lane builds the plate cells around the playhead first (T2.3).
  useEffect(() => frameBus.subscribe((frame) => runtime.setPlayhead?.(frame)), [frameBus, runtime]);
  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  // Panels and lanes get the store's dispatch (it throws CommandRejected, Appendix A.2); the
  // shell's own controls use safeDispatch, which turns a rejection into a toast.
  const dispatch = useCallback((...args) => store.dispatch(...args), [store]);
  const safeDispatch = useCallback((type, args = {}, options) => {
    try {
      return options ? store.dispatch(type, args, options) : store.dispatch(type, args);
    } catch (error) {
      notify(rejectionText(error));
      return null;
    }
  }, [store, notify]);

  // Dev and e2e hook (fake runtime only): the specs read the store and the player through it.
  useEffect(() => {
    if (runtime.kind !== "fake") return undefined;
    window.__potonginEditor = { store, player, api };
    return () => { delete window.__potonginEditor; };
  }, [runtime, store, player, api]);

  // The player needs the stage canvas; it is created once the Stage has mounted.
  const [playerVersion, setPlayerVersion] = useState(0);
  useEffect(() => {
    if (!media?.canvas) return undefined;
    const created = runtime.createPlayer({
      canvas: media.canvas,
      video: media.video,
      fetchImpl: (...args) => fetch(...args),
      onState: (next) => {
        if (!next) return;
        if (Number.isFinite(next.frame)) frameBus.set(next.frame);
        setPlayerState((previous) => {
          const merged = { mode: next.mode ?? null, current: { ...(next.current ?? {}) },
            playing: typeof next.playing === "boolean" ? next.playing : previous?.playing ?? false,
            exact: typeof next.exact === "boolean" ? next.exact : undefined };
          return previous && previous.mode === merged.mode && previous.playing === merged.playing
            && previous.exact === merged.exact
            && JSON.stringify(previous.current) === JSON.stringify(merged.current) ? previous : merged;
        });
      },
      onFrame: (frame) => frameBus.set(frame),
    });
    player.attach(created);
    setPlayerVersion((value) => value + 1);
    return () => {
      player.detach();
      created.destroy();
      setPlayerState(null);
    };
  }, [media, runtime, player, frameBus]);

  useEffect(() => {
    if (plan && player.attached) player.load(plan);
  }, [plan, player, playerVersion]);

  // The export state machine outlives the dialog: closing it never stops a render.
  useEffect(() => {
    const flow = createExportFlow({ api, store, newKey: runtime.newKey, pollMs: runtime.pollMs, onChange: setExportState });
    flowRef.current = flow;
    setExportState(flow.getState());
    return () => {
      flow.destroy();
      flowRef.current = null;
    };
  }, [api, store, runtime]);

  // Title and packaging (read-only in Essentials) from the clips listing.
  useEffect(() => {
    let alive = true;
    api.clips().then((result) => {
      if (!alive) return;
      const clips = Array.isArray(result?.clips) ? result.clips : [];
      setClipInfo(clips.find((clip) => clip.clipId === clipId) ?? (clips.length === 1 ? clips[0] : null));
    }).catch(() => {});
    return () => { alive = false; };
  }, [api, clipId]);

  const openExport = useCallback(() => {
    if (!ready || readOnly) return;
    const flow = flowRef.current;
    if (flow && TERMINAL_EXPORT.has(flow.getState().phase)) flow.reset();
    setChecksOpen(false);
    setExportOpen(true);
  }, [ready, readOnly]);

  const closeExport = useCallback(() => {
    setExportOpen(false);
    requestAnimationFrame(() => exportButtonRef.current?.focus());
  }, []);

  const closeChecks = useCallback(() => {
    setChecksOpen(false);
    requestAnimationFrame(() => checksButtonRef.current?.focus());
  }, []);

  const openHelp = useCallback(() => {
    helpReturnRef.current = document.activeElement;
    setHelpOpen(true);
  }, []);

  const closeHelp = useCallback(() => {
    setHelpOpen(false);
    const target = helpReturnRef.current;
    requestAnimationFrame(() => target?.focus?.());
  }, []);

  const toggleTruth = useCallback(() => {
    const frame = frameBus.get();
    if (playerState?.mode === "truth") player.seek(frame);
    else player.showTruthFrame(frame);
  }, [frameBus, player, playerState]);

  const playPause = useCallback(() => {
    if (playerState?.playing) player.pause();
    else player.play();
  }, [player, playerState]);

  const trimAtPlayhead = useCallback((edge) => {
    if (status !== "ready") return;
    const selected = selectionWordIds(state.selection);
    const gapWord = selected.length
      ? (edge === "start" ? selected[0] : selected.at(-1))
      : wordForTrimAt({ edge, frame: frameBus.get(), plan, words: state.words });
    if (!gapWord) {
      notify("Tidak ada kata di posisi ini");
      return;
    }
    safeDispatch(edge === "start" ? "TrimStart" : "TrimEnd", { gapWord });
  }, [status, state.selection, state.words, plan, frameBus, notify, safeDispatch]);

  const second = Math.max(1, Math.round(fps[0] / fps[1]));
  const actions = {
    playPause,
    frameBack: () => player.step(-1),
    frameForward: () => player.step(1),
    secondBack: () => player.step(-second),
    secondForward: () => player.step(second),
    undo: () => { if (!readOnly) store.undo(); },
    redo: () => { if (!readOnly) store.redo(); },
    trimStart: () => trimAtPlayhead("start"),
    trimEnd: () => trimAtPlayhead("end"),
    safeZone: () => setSafeZone((value) => !value),
    truthFrame: toggleTruth,
    export: openExport,
    help: openHelp,
  };
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const modalRef = useRef(modalOpen);
  modalRef.current = modalOpen;

  useEffect(() => {
    const onKey = (event) => {
      // A focused panel (the transcript) handles its own keys and prevents their default.
      if (modalRef.current || event.defaultPrevented) return;
      const id = globalShortcut(event);
      const action = id ? actionsRef.current[id] : null;
      if (!action) return;
      event.preventDefault();
      action();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const badge = badgeView({ status, plan, storePending: Array.isArray(state.pending) ? state.pending : [], player: playerState });
  const checks = useMemo(() => checksView({ warnings: state.warnings, plan }), [state.warnings, plan]);
  const notices = noticesView({ doc: state.doc, playerMode: playerState?.mode, otherTab });
  const unchanged = exportMatchesSeed({ plan, doc: state.doc, seed: state.seed });
  const earlier = useMemo(() => {
    const history = exportState?.history ?? [];
    const latest = clipInfo?.latestRender;
    if (latest?.renderId && !history.some((item) => item.renderId === latest.renderId)) {
      return [...history, { renderId: latest.renderId, revision: latest.revision, atMs: null, state: latest.state,
        resultUrl: latest.url ?? null, srtUrl: latest.srtUrl ?? null }];
    }
    return history;
  }, [exportState, clipInfo]);
  const isReady = ready && Boolean(plan) && playerState !== null;
  const panel = PANELS.find((entry) => entry.id === panelId) ?? PANELS[0];
  const Panel = lazyComponent(panel);
  const onMedia = useCallback((next) => setMedia(next), []);

  const onTabKey = (event, index) => {
    const moves = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: PANELS.length - 1 };
    if (!(event.key in moves)) return;
    event.preventDefault();
    const target = PANELS[(moves[event.key] + PANELS.length) % PANELS.length];
    setPanelId(target.id);
    tabRefs.current.get(target.id)?.focus();
  };

  if (status === "error") {
    return (
      <StatePage title="Klip tidak bisa dibuka" jobId={jobId}>
        <p>{messageFor(state.error?.code ?? state.errorCode ?? "internal_error")}</p>
      </StatePage>
    );
  }

  return (
    <div
      className={`${tokens.tokens} ${styles.shell}`}
      data-editor-root=""
      data-editor-status={status}
      data-editor-ready={isReady ? "true" : "false"}
    >
      <TopBar
        ref={exportButtonRef}
        jobId={jobId}
        title={clipInfo?.title || "Klip"}
        save={state.save}
        savedAtMs={state.savedAtMs}
        canUndo={Boolean(state.canUndo) && !readOnly}
        canRedo={Boolean(state.canRedo) && !readOnly}
        onUndo={() => store.undo()}
        onRedo={() => store.redo()}
        onReset={() => safeDispatch("ResetToSeed", {})}
        resetDisabled={status !== "ready"}
        onRetrySave={() => { Promise.resolve().then(() => store.flush()).catch(() => {}); }}
        checksCount={checks.length}
        checksOpen={checksOpen}
        checksButtonRef={checksButtonRef}
        onToggleChecks={() => (checksOpen ? closeChecks() : setChecksOpen(true))}
        onHelp={openHelp}
        onExport={openExport}
        exportDisabled={!ready || readOnly}
        exportBusy={BUSY_EXPORT.has(exportState?.phase)}
      />

      <aside className={styles.panels} data-slot="panels" aria-label="Panel editor">
        <div className={styles.tabs} role="tablist" aria-label="Panel editor">
          {PANELS.map((entry, index) => (
            <button
              key={entry.id}
              ref={(element) => { if (element) tabRefs.current.set(entry.id, element); else tabRefs.current.delete(entry.id); }}
              type="button"
              role="tab"
              id={`editor-tab-${entry.id}`}
              className={styles.tab}
              aria-selected={entry.id === panel.id}
              aria-controls="editor-panel"
              tabIndex={entry.id === panel.id ? 0 : -1}
              onClick={() => setPanelId(entry.id)}
              onKeyDown={(event) => onTabKey(event, index)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <div className={styles.tabPanel} role="tabpanel" id="editor-panel" aria-labelledby={`editor-tab-${panel.id}`}>
          <Suspense fallback={<p className={styles.muted}>Membuka panel…</p>}>
            <Panel state={state} dispatch={dispatch} player={player} />
          </Suspense>
        </div>
      </aside>

      <main className={styles.stageRegion} data-slot="stage">
        {(notices.length > 0 || readOnly) && (
          <div className={styles.notices}>
            {readOnly && (
              <ReadOnlyBanner
                reason={state.readOnlyReason ?? "transcript_changed"}
                onStartFromSeed={() => {
                  if (typeof store.startFromSeed === "function") store.startFromSeed();
                  else safeDispatch("ResetToSeed", {});
                }}
              />
            )}
            {notices.filter((notice) => notice.code !== "unsupported_browser").map((notice) => (
              <p key={notice.code} className={`${styles.notice} ${notice.tone === "warn" ? styles.notice_warn : ""}`}>{notice.text}</p>
            ))}
          </div>
        )}
        <Stage output={state.doc?.output ?? plan?.output} plan={plan} playerMode={playerState?.mode} safeZone={safeZone} onMedia={onMedia} />
        <StageControls
          fps={fps}
          totalFrames={plan?.totalFrames ?? 0}
          frameBus={frameBus}
          playing={Boolean(playerState?.playing)}
          onPlayPause={playPause}
          onStep={(delta) => player.step(delta)}
          safeZone={safeZone}
          onToggleSafeZone={() => setSafeZone((value) => !value)}
          truth={playerState?.mode === "truth"}
          onTruth={toggleTruth}
          badge={badge}
          disabled={!plan}
        />
      </main>

      <Timeline plan={plan} state={state} dispatch={dispatch} player={player} frameBus={frameBus} notify={notify} readOnly={readOnly} />

      <ChecksPanel
        open={checksOpen}
        checks={checks}
        onClose={closeChecks}
        onJump={(check) => { player.seek(check.f); }}
      />
      <ExportDialog
        open={exportOpen}
        onClose={closeExport}
        flow={exportState}
        onStart={() => flowRef.current?.start()}
        onCancel={() => flowRef.current?.cancel()}
        onRetry={() => flowRef.current?.retry()}
        checks={checks}
        revision={state.doc?.revision ?? 0}
        dirty={state.save === "dirty" || state.save === "saving"}
        unchanged={unchanged}
        output={state.doc?.output ?? plan?.output}
        packaging={clipInfo ? { title: clipInfo.title, description: clipInfo.description, hashtags: clipInfo.hashtags } : null}
        earlier={earlier}
        readOnly={readOnly}
      />
      <ConflictDialog
        conflict={conflict}
        onResolve={(choices) => {
          Promise.resolve(store.resolveConflict?.(choices)).catch(() => {}); // the dialog shows conflict.error
        }}
      />
      <ShortcutHelp open={helpOpen} onClose={closeHelp} />
      {toast && <div key={toast.id} className={styles.toast} role="status" aria-live="polite">{toast.text}</div>}
    </div>
  );
}

export default function EditorApp({ jobId, clipId, runtimeKind = "real", runtime: injected = null, initialPanel }) {
  const narrow = useNarrow();
  const [runtime, setRuntime] = useState(injected);
  const [failure, setFailure] = useState(null);

  useEffect(() => {
    if (injected) return undefined;
    let alive = true;
    let created = null;
    const scenario = runtimeKind === "fake" ? (globalThis.__potonginEditorScenario ?? null) : null;
    createEditorRuntime({ kind: runtimeKind, jobId, clipId, scenario })
      .then((next) => {
        if (!alive) { next.destroy(); return; }
        created = next;
        setRuntime(next);
      })
      .catch((error) => { if (alive) setFailure(error); });
    return () => {
      alive = false;
      created?.destroy();
      setRuntime(null);
    };
  }, [injected, runtimeKind, jobId, clipId]);

  if (narrow) {
    return (
      <StatePage title="Editor butuh layar minimal 1024 px" jobId={jobId}>
        <p>Buka klip ini di laptop atau komputer. Pratinjau baca-saja untuk layar kecil belum tersedia.</p>
      </StatePage>
    );
  }
  if (failure) {
    return (
      <StatePage title="Editor belum tersedia" jobId={jobId}>
        <p>{failure.code === "runtime_unavailable" ? "Editor V3 belum tersambung ke server. Coba lagi nanti." : "Editor gagal dimuat. Muat ulang halaman."}</p>
      </StatePage>
    );
  }
  if (!runtime) {
    return <StatePage title="Membuka klip…" busy><p>Menyiapkan transkrip, pratinjau, dan timeline.</p></StatePage>;
  }
  return <EditorShell key={`${jobId}/${clipId}`} runtime={runtime} jobId={jobId} clipId={clipId} initialPanel={initialPanel} />;
}
