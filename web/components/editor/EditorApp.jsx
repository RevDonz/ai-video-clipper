"use client";

// Editor V3 shell (plan §11.2 T2.6, Appendix C): the top bar, the left panel's tabs (registry
// panels/index.mjs), the stage with its controls and badge (§6.1), the timeline (registry
// timeline/lanes.mjs), "Perlu dicek", the export, framing ("Atur bingkai"), split ("Atur layar
// terbagi"), conflict and shortcut dialogs, the read-only and notice states, and the keyboard map
// (Appendix C.4).
//
// Seams (Appendix A.2): `runtime` (runtime.mjs) provides the store (createEditorStore), the API
// and preview clients, the upload client and createPlayer. The page passes `runtimeKind` and the
// server's `features` (uploads and the editor's LLM on or off); tests may inject a runtime. Every
// panel and every Mode Cepat card receives one props bundle, { state, getState, dispatch, player,
// api, previewClient, uploadAsset, uploadsEnabled, llmEnabled, notify, readOnly, openFraming,
// openSplit, applyAll }
// (cards also `frameBus` and `showLengkap`); every lane
// { plan, state, dispatch, player, pxPerFrame }. `player` is the facade of runtime.mjs, which adds
// `subscribeFrame(fn)` and `frame()` so that DOM can follow playback outside React (§6.2).
//
// Two views of this one editor (docs/plans/2026-10-02-editor-mode-cepat.md §1, §4): Mode Cepat
// (cards beside the stage, the scrubber below) and Mode Lengkap (the tools rail on the left, the
// stage in the middle, the open tool's panel on the right as its inspector, transport and
// timeline below). The shell's children keep one order, top bar, side regions, stage region,
// bottom region, and only the side and bottom children change with the view, so a switch never
// remounts the canvas, the player, the store or the export flow. In Lengkap the panel follows the
// rail in the DOM, so Tab goes from a tab to its panel, then to the stage.
//
// The one-layout editor (rombak 06 §3, Editor F1) replaces both views behind
// POTONGIN_EDITOR_SHELL=v2 (`shell` prop; the fakes' scenario may pick it for the specs): the
// same workspace, store, player, dialogs and keyboard map, placed by shell/EditorShell.jsx with
// the Klip list, the stage and its transport, the transcript, five tabs and the folded timeline.
// The old views stay the default until the phase passes and go in F10.
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslations } from "use-intl";

import { createApplyAll } from "../../lib/editor/apply-all.mjs";
import { LEAVE_TEXT, clipNavHref, clipNavigation, saveBeforeLeaving } from "../../lib/editor/clip-nav.mjs";
import { editorHref, prepareForEditor } from "../../lib/editor/open-clip.mjs";
import { SHORTCUTS, globalShortcut } from "../../lib/editor/shortcuts.mjs";
import { forgetLegacyView, panelHref, resolveUrlState, urlWithPanel } from "../../lib/editor/url-state.mjs";
import { isPortrait } from "../../lib/output-frame.mjs";
import { writeShortcutPref } from "../../lib/ui-prefs.mjs";
import {
  PANEL_IDS, browserStorage, readStoredView, resolveView, urlWithView, viewFromUrl, writeStoredView,
} from "../../lib/editor/view-mode.mjs";
import ChecksPanel from "./ChecksPanel.jsx";
import ConflictDialog from "./ConflictDialog.jsx";
import tokens from "./editor.module.css";
import ExportDialog from "./ExportDialog.jsx";
import { createExportFlow, earlierExports } from "./export-flow.mjs";
import FramingDialog from "./FramingDialog.jsx";
import SplitDialog from "./SplitDialog.jsx";
import { GIZMOS } from "./gizmos/index.mjs";
import { PANELS } from "./panels/index.mjs";
import QuickPanel from "./quick/QuickPanel.jsx";
import Rail from "./rail/Rail.jsx";
import ReadOnlyBanner from "./ReadOnlyBanner.jsx";
import { createEditorRuntime, createFrameBus, createPlayerFacade } from "./runtime.mjs";
import styles from "./shell.module.css";
import shellStyles from "./shell/editor-shell.module.css";
import {
  actionableChecks, badgeView, checksButtonView, checksView, conflictParts, exportMatchesSeed, exportRevision, liveEntries, messageFor,
  noticesView, outputRatio, playerView, rejectionText, selectionTrimWord,
} from "./shell-model.mjs";
import ClipList from "./shell/ClipList.jsx";
import EditorShell from "./shell/EditorShell.jsx";
import PanelTabs from "./shell/PanelTabs.jsx";
import TimelineDetail from "./shell/TimelineDetail.jsx";
import Scrubber from "./scrubber/Scrubber.jsx";
import Stage from "./Stage.jsx";
import StageBadge from "./StageBadge.jsx";
import StageControls, { PlayButton, StageToggles, TimeReadout } from "./StageControls.jsx";
import { LANES } from "./timeline/lanes.mjs";
import Timeline from "./timeline/Timeline.jsx";
import { wordForTrimAt } from "./timeline/timeline-model.mjs";
import TopBar from "./TopBar.jsx";
import { runCommands } from "./transcript/actions.mjs";
import { selectionStoreFor } from "./transcript/selection.mjs";
import PillButton from "./ui/PillButton.jsx";
import Switch from "./ui/Switch.jsx";

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
// A clip of a job that was never prepared has no document or words yet: the editor prepares it.
const PREPARE_CODES = new Set(["not_found", "analysis_missing"]);
const BUSY_EXPORT = new Set(["saving", "submitting", "running"]);

// The view, Lengkap panel and Cepat card the editor opens with (Mode Cepat spec §4.2–§4.4): the
// URL (`?mode`, else implied by `?panel` or `?card`), then the stored preference, then Cepat. An
// `initialPanel` prop (the logo harness) counts as `?panel`. Read once, before the shell's first
// render; the shell renders only on the client, after the runtime is ready, so there is no flash
// of the wrong view and the server render never reads storage. A deep link never writes the
// preference.
function openingView(initialPanel) {
  let url = { view: null, panel: null, card: null };
  try {
    url = viewFromUrl(window.location.search);
  } catch {
    // no window: open with the stored preference or Cepat
  }
  if (!url.panel && PANEL_IDS.includes(initialPanel)) url = { ...url, panel: initialPanel };
  return { view: resolveView({ url, stored: readStoredView(browserStorage()) }), panel: url.panel, card: url.card };
}

// The tab the one-layout editor opens with (rombak 06 §3.6): the address (old links land on their
// tab), else the logo harness's `initialPanel`, else Teks. The address is rewritten to keep only
// `?panel`, and the two-view editor's stored view is dropped.
function openingTab(initialPanel) {
  try {
    const state = resolveUrlState(window.location.search, { fallback: initialPanel });
    if (state.changed) {
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${state.search}${window.location.hash}`);
    }
    try {
      forgetLegacyView(window.localStorage);
    } catch {
      // storage blocked: nothing was stored either
    }
    return state;
  } catch {
    return resolveUrlState("", { fallback: initialPanel });
  }
}

function replaceUrlPanel(panel) {
  try {
    window.history.replaceState(window.history.state, "", urlWithPanel(window.location.href, panel));
  } catch {
    // a sandboxed frame may refuse; the tab still opens
  }
}

// The address after a switch (Mode Cepat spec §4.4): `?mode=<view>`, so a reload stays in the view.
function replaceUrlView(view) {
  try {
    window.history.replaceState(window.history.state, "", urlWithView(window.location.href, view));
  } catch {
    // a sandboxed frame may refuse; the view still switches for this page
  }
}

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

const SCOPE_NOTE = Object.freeze({ transcript: " (di transkrip)", scrubber: " (di bilah posisi)", trim: " (di gagang timeline)" });

// A character key the "Pintasan satu tombol" switch turns off (K, I, O, ', ?), not an arrow glyph.
const isCharacterKey = (name) => Array.from(name).length === 1 && name !== "←" && name !== "→";

function ShortcutHelp({ open, onClose, singleKey = true, onSingleKeyChange }) {
  const t = useTranslations("editor.shortcuts");
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
                {SHORTCUTS.map((shortcut) => {
                  const off = !singleKey && shortcut.singleKey === true;
                  return (
                    <tr key={shortcut.id} data-shortcut-off={off ? "" : undefined}>
                      <td>
                        {shortcut.keys.map((key) => (
                          <kbd key={key} className={`${styles.kbd} ${off && isCharacterKey(key) ? styles.kbdOff : ""}`}>{key}</kbd>
                        ))}
                        {off ? <span className={styles.shortcutOff}>{t("off")}</span> : null}
                      </td>
                      <td>{shortcut.description}{SCOPE_NOTE[shortcut.scope] ?? ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {onSingleKeyChange ? (
              <div className={styles.shortcutSwitch}>
                <Switch label={t("singleKey")} checked={singleKey} onChange={onSingleKeyChange} describedBy="editor-single-key-help" />
                <p id="editor-single-key-help" className={styles.muted}>{t("singleKeyHelp")}</p>
              </div>
            ) : null}
            <p className={styles.muted}>Setiap aksi juga punya tombol di layar. Pintasan tidak aktif saat Anda mengetik di kolom teks.</p>
          </div>
        </>
      )}
    </dialog>
  );
}

function EditorWorkspace({
  runtime, jobId, clipId, initialPanel, features = {}, onNeedsPrepare = null, singleKeyShortcuts = true, shell = "legacy",
}) {
  const { store, api } = runtime;
  const oneLayout = shell === "v2";
  const tEditor = useTranslations("editor");
  // Panels and lanes of a wave that has not landed stay hidden in the app (W2 verifier).
  const panels = useMemo(() => liveEntries(PANELS, runtime.kind), [runtime.kind]);
  const lanes = useMemo(() => liveEntries(LANES, runtime.kind), [runtime.kind]);
  const gizmos = useMemo(() => liveEntries(GIZMOS, runtime.kind), [runtime.kind]);
  // Uploads follow POTONGIN_EDITOR_UPLOADS (the page passes it); the fakes always allow them.
  const uploadsEnabled = runtime.kind === "fake" || features.uploads === true;
  // Cek ejaan follows POTONGIN_EDITOR_LLM the same way; the fakes answer it themselves.
  const llmEnabled = runtime.kind === "fake" || features.llm === true;
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
  const [opening] = useState(() => (oneLayout ? { view: null, panel: null, card: null } : openingView(initialPanel)));
  const [panelId, setPanelId] = useState(opening.panel ?? panels[0].id);
  // The one-layout editor's tab (rombak 06 §3.6), and its Klip drawer below 1280 px.
  const [openingState] = useState(() => (oneLayout ? openingTab(initialPanel) : null));
  const [tabId, setTabId] = useState(openingState?.panel ?? "text");
  const [clipsDrawerOpen, setClipsDrawerOpen] = useState(false);
  // "Pintasan satu tombol" (lib/ui-prefs.mjs): the page reads it on the server; the dialog's switch
  // writes the shared cookie and acts at once.
  const [singleKeyOn, setSingleKeyOn] = useState(singleKeyShortcuts !== false);
  const [view, setView] = useState(opening.view);
  // A `?card=` deep link opens its card the first time Cepat shows; after a switch Caption opens.
  const openingCardRef = useRef(opening.card);
  const [safeZone, setSafeZone] = useState(false);
  const [checksOpen, setChecksOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [framingOpen, setFramingOpen] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const [clipInfo, setClipInfo] = useState(null);
  const [clipList, setClipList] = useState(null);
  const [exportState, setExportState] = useState(null);
  const flowRef = useRef(null);
  // "Pakai di semua klip" (CONTRACTS §5.53): one controller per clip, shared by both views.
  const applyAll = useMemo(() => createApplyAll({ api, flush: () => store.flush(), newKey: runtime.newKey }), [api, store, runtime]);
  const exportButtonRef = useRef(null);
  const checksButtonRef = useRef(null);
  const helpReturnRef = useRef(null);
  const framingReturnRef = useRef(null);
  const splitReturnRef = useRef(null);

  const status = state.status;
  const readOnly = status === "readOnly";
  const ready = status === "ready" || readOnly;
  const plan = state.plan ?? null;
  const fps = plan?.fps ?? state.doc?.output?.fps ?? [30, 1];
  // A 1:1 clip has no TikTok zone (CONTRACTS §5.54): no Zona aman.
  const frame = state.doc?.output ?? plan?.output;
  const hasZone = !frame || isPortrait(frame);
  // The store's per-part conflict (T2.5 `groups`; the T2.6 specs' `parts`), shown as a dialog.
  const conflict = state.save === "conflict" && conflictParts(state.conflict).length ? state.conflict : null;
  // "Klip ini terbuka di tab lain" comes from the store's own BroadcastChannel (T2.5).
  const otherTab = state.otherTab === true;
  const modalOpen = exportOpen || helpOpen || framingOpen || splitOpen || clipsDrawerOpen || Boolean(conflict);

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
    if (runtime.kind !== "fake") {
      // Read-only inspection for the e2e flow and support (T2.Z): state, never a command.
      window.__potonginEditorInspect = Object.freeze({
        state: () => store.getState(),
        player: () => player.state(),
        stats: () => player.stats(),
      });
      return () => { delete window.__potonginEditorInspect; };
    }
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
        setPlayerState((previous) => playerView(previous, next));
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

  // Title and packaging (read-only in Essentials) from the clips listing, and from the same listing
  // the clip's place among the project's clips for "Klip 3/8 ‹ ›".
  useEffect(() => {
    let alive = true;
    api.clips().then((result) => {
      if (!alive) return;
      const clips = Array.isArray(result?.clips) ? result.clips : [];
      setClipInfo(clips.find((clip) => clip.clipId === clipId) ?? (clips.length === 1 ? clips[0] : null));
      setClipList(clips);
      applyAll.setClips(clips, clipId);
    }).catch(() => {});
    return () => { alive = false; };
  }, [api, clipId, applyAll]);
  const clipNav = useMemo(() => clipNavigation({ jobId, clipId, clips: clipList }), [jobId, clipId, clipList]);

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

  // "Atur bingkai" (CONTRACTS §5.44): opened from the Tata letak panel or card; focus goes back there.
  const openFraming = useCallback(() => {
    framingReturnRef.current = document.activeElement;
    setChecksOpen(false);
    setFramingOpen(true);
  }, []);

  const closeFraming = useCallback(() => {
    setFramingOpen(false);
    const target = framingReturnRef.current;
    requestAnimationFrame(() => target?.focus?.());
  }, []);

  // "Atur layar terbagi" (CONTRACTS §5.45): opened from the Tata letak panel or card, as Atur bingkai.
  const openSplit = useCallback(() => {
    splitReturnRef.current = document.activeElement;
    setChecksOpen(false);
    setSplitOpen(true);
  }, []);

  const closeSplit = useCallback(() => {
    setSplitOpen(false);
    const target = splitReturnRef.current;
    requestAnimationFrame(() => target?.focus?.());
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

  // I and O (Mode Cepat spec §4.1): the transcript's selection, shared per clip, while the
  // transcript is on screen (Lengkap's Transkrip panel), as "Mulai di sini" and "Akhiri di sini";
  // otherwise, or without a selection, the word under the playhead.
  const clipKey = state.doc?.clip_id ?? clipId;
  const transcriptShown = oneLayout || (view === "lengkap" && panelId === "transcript");
  const trimAtPlayhead = useCallback((edge) => {
    if (status !== "ready") return;
    const selected = transcriptShown
      ? selectionTrimWord({ selection: selectionStoreFor(clipKey).get(), words: state.words, edge })
      : null;
    const gapWord = selected ?? wordForTrimAt({ edge, frame: frameBus.get(), plan, words: state.words });
    if (!gapWord) {
      notify("Tidak ada kata di posisi ini");
      return;
    }
    safeDispatch(edge === "start" ? "TrimStart" : "TrimEnd", { gapWord });
  }, [status, transcriptShown, clipKey, state.words, plan, frameBus, notify, safeDispatch]);

  // ‹ › and Ctrl+Shift+←/→ open the neighbour in the same view only after the save; a failed save or
  // a conflict keeps the editor on this clip with the store's own error or dialog.
  const leavingRef = useRef(false);
  const [leaving, setLeaving] = useState(false);
  const cardRef = useRef(null);
  const onCardChange = useCallback((id) => { cardRef.current = id; }, []);
  // The one-layout editor opens the neighbour on the same tab (?panel), the old one in the same view.
  const neighbourHref = useCallback((href) => (oneLayout ? panelHref(href, tabId)
    : clipNavHref(href, { view, panel: panelId, card: cardRef.current })), [oneLayout, tabId, view, panelId]);
  const openClip = useCallback(async (href) => {
    if (!href || leavingRef.current) return;
    leavingRef.current = true;
    setLeaving(true);
    try {
      const result = await saveBeforeLeaving({
        flush: () => store.flush(), getState: () => store.getState(), exportPhase: flowRef.current?.getState().phase ?? null,
      });
      if (result.ok) {
        window.location.assign(neighbourHref(href));
        return;
      }
      notify(LEAVE_TEXT[result.reason]);
    } finally {
      leavingRef.current = false;
      setLeaving(false);
    }
  }, [store, neighbourHref, notify]);
  const goToClip = useCallback((side) => {
    const target = side === "previous" ? clipNav?.previous : clipNav?.next;
    if (target) openClip(target.href);
  }, [clipNav, openClip]);

  const second = Math.max(1, Math.round(fps[0] / fps[1]));
  const actions = {
    playPause,
    frameBack: () => player.step(-1),
    frameForward: () => player.step(1),
    secondBack: () => player.step(-second),
    secondForward: () => player.step(second),
    previousClip: () => goToClip("previous"),
    nextClip: () => goToClip("next"),
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
  // "Pintasan satu tombol" (lib/ui-prefs.mjs), read by the page on the server.
  const singleKeyRef = useRef(singleKeyOn);
  singleKeyRef.current = singleKeyOn;
  const changeSingleKey = useCallback((on) => setSingleKeyOn(writeShortcutPref(on)), []);

  useEffect(() => {
    const onKey = (event) => {
      // A focused panel (the transcript) handles its own keys and prevents their default.
      if (modalRef.current || event.defaultPrevented) return;
      const id = globalShortcut(event, { singleKey: singleKeyRef.current });
      const action = id ? actionsRef.current[id] : null;
      if (!action) return;
      event.preventDefault();
      action();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const badge = badgeView({ status, plan, storePending: Array.isArray(state.pending) ? state.pending : [], player: playerState });
  const checks = useMemo(() => checksView({ warnings: state.warnings, plan, doc: state.doc, seed: state.seed }),
    [state.warnings, plan, state.doc, state.seed]);
  const notices = noticesView({ doc: state.doc, playerMode: playerState?.mode });
  // "Perlu dicek n" / "Catatan n" (rombak 06 §4 #6): gone at 0; focus that was on it goes to Ekspor.
  const checksButton = checksButtonView(checks);
  const checksKind = oneLayout ? checksButton.kind : "legacy";
  const checksKindRef = useRef(checksKind);
  useEffect(() => {
    const before = checksKindRef.current;
    checksKindRef.current = checksKind;
    if (!oneLayout || before === null || checksKind !== null) return;
    setChecksOpen(false);
    const active = document.activeElement;
    if (!active || active === document.body) exportButtonRef.current?.focus();
  }, [oneLayout, checksKind]);
  const unchanged = exportMatchesSeed({ plan, doc: state.doc, seed: state.seed });
  const earlier = useMemo(() => earlierExports({ history: exportState?.history ?? [], current: exportState?.render ?? null,
    latest: clipInfo?.latestRender ?? null }), [exportState, clipInfo]);
  const isReady = ready && Boolean(plan) && playerState !== null;
  const panel = panels.find((entry) => entry.id === panelId) ?? panels[0];
  const Panel = lazyComponent(panel);
  const onMedia = useCallback((next) => setMedia(next), []);
  // One bundle for every Lengkap panel and every Cepat card (Mode Cepat spec §1.2). `getState` reads
  // the store as it is now, for work that outlives the panel or card that started it (§4.1).
  const panelProps = useMemo(() => ({
    state, getState: snapshot, dispatch, player, api, previewClient: runtime.previewClient, uploadAsset: runtime.uploadAsset ?? null, uploadsEnabled, llmEnabled, notify, readOnly,
    openFraming, openSplit, applyAll,
  }), [state, snapshot, dispatch, player, api, runtime, uploadsEnabled, llmEnabled, notify, readOnly, openFraming, openSplit, applyAll]);

  const errorCode = status === "error" ? (state.error?.code ?? state.errorCode ?? "internal_error") : null;
  const preparesNow = typeof onNeedsPrepare === "function" && PREPARE_CODES.has(errorCode);
  useEffect(() => {
    if (preparesNow) onNeedsPrepare();
  }, [preparesNow, onNeedsPrepare]);

  // The top-bar switch (Mode Cepat spec §4.2, §4.4): the only place that writes the preference.
  const changeView = useCallback((next) => {
    openingCardRef.current = null;
    setView(next);
    writeStoredView(browserStorage(), next);
    replaceUrlView(next);
  }, []);

  // A Cepat card or link opens the panel that does the same work in Lengkap (no preference write).
  // The control that was pressed leaves with Mode Cepat, so focus goes to the opened panel's rail
  // tab: the next Tab is the panel itself (it follows the rail in the DOM, on the right on screen).
  const [railFocus, setRailFocus] = useState(0);
  const showLengkap = useCallback((nextPanel) => {
    openingCardRef.current = null;
    if (panels.some((entry) => entry.id === nextPanel)) setPanelId(nextPanel);
    setView("lengkap");
    replaceUrlView("lengkap");
    setRailFocus((count) => count + 1);
  }, [panels]);
  useEffect(() => {
    if (!railFocus) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return; // focus survived the switch
    document.getElementById(`editor-tab-${panelId}`)?.focus();
  }, [railFocus]); // panelId is the one showLengkap set in the same render

  // A tab of the one-layout editor puts ?panel in the address, so a reload and ‹ › keep it.
  const changeTab = useCallback((next) => {
    setTabId(next);
    replaceUrlPanel(next);
  }, []);

  if (status === "error") {
    if (preparesNow) return <StatePage title="Menyiapkan klip untuk diedit" jobId={jobId} busy><p>Memeriksa analisis klip…</p></StatePage>;
    return (
      <StatePage title="Klip tidak bisa dibuka" jobId={jobId}>
        <p>{messageFor(errorCode)}</p>
      </StatePage>
    );
  }

  const topBar = (
    <TopBar
      ref={exportButtonRef}
      jobId={jobId}
      title={clipInfo?.title || "Klip"}
      save={state.save}
      savedAtMs={state.savedAtMs}
      otherTab={otherTab}
      view={view}
      onViewChange={oneLayout ? null : changeView}
      checksButton={oneLayout ? checksButton : null}
      canUndo={Boolean(state.canUndo) && !readOnly}
      canRedo={Boolean(state.canRedo) && !readOnly}
      onUndo={() => store.undo()}
      onRedo={() => store.redo()}
      onReset={() => safeDispatch("ResetToSeed", {})}
      resetDisabled={status !== "ready"}
      resetReason={readOnly ? "Tidak bisa saat klip baca-saja" : "Klip masih dibuka"}
      onRetrySave={() => { Promise.resolve().then(() => store.flush()).catch(() => {}); }}
      checksCount={actionableChecks(checks).length}
      checksOpen={checksOpen}
      checksButtonRef={checksButtonRef}
      onToggleChecks={() => (checksOpen ? closeChecks() : setChecksOpen(true))}
      onHelp={openHelp}
      onExport={openExport}
      exportDisabled={!ready || readOnly}
      exportBusy={BUSY_EXPORT.has(exportState?.phase)}
      clipNav={clipNav}
      clipNavBusy={leaving}
      onPreviousClip={() => goToClip("previous")}
      onNextClip={() => goToClip("next")}
    />
  );
  const stageNotices = (notices.length > 0 || readOnly) && (
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
  );
  const stage = (
    <Stage
      output={state.doc?.output ?? plan?.output}
      plan={plan}
      playerMode={playerState?.mode}
      safeZone={safeZone}
      onMedia={onMedia}
      overlayStart={<StageBadge view={badge} />}
      overlayEnd={(
        <StageToggles
          truth={playerState?.mode === "truth"}
          onTruth={toggleTruth}
          safeZone={safeZone}
          onToggleSafeZone={() => setSafeZone((value) => !value)}
          zone={hasZone}
          disabled={!plan}
        />
      )}
      gizmos={gizmos.map((entry) => {
        // W3 gizmos (T3.2's LogoGizmo) mount here from their registry (gizmos/index.mjs).
        const Gizmo = lazyComponent(entry);
        return (
          <Suspense key={entry.id} fallback={null}>
            <Gizmo plan={plan} state={state} dispatch={dispatch} player={player} output={state.doc?.output ?? plan?.output} readOnly={readOnly} />
          </Suspense>
        );
      })}
    />
  );
  const dialogs = (
    <>
      <ChecksPanel
        open={checksOpen}
        checks={checks}
        onClose={closeChecks}
        onJump={(check) => { player.seek(check.f); }}
        onFix={readOnly ? null : (command) => {
          const result = runCommands(dispatch, [command]);
          if (!result.ok) notify(result.message);
        }}
      />
      <ExportDialog
        open={exportOpen}
        onClose={closeExport}
        flow={exportState}
        onStart={() => flowRef.current?.start()}
        onCancel={() => flowRef.current?.cancel()}
        onRetry={() => flowRef.current?.retry()}
        checks={checks}
        revision={exportRevision(state)}
        dirty={state.save === "dirty" || state.save === "saving"}
        unchanged={unchanged}
        output={state.doc?.output ?? plan?.output}
        packaging={clipInfo ? { title: clipInfo.title, description: clipInfo.description, hashtags: clipInfo.hashtags } : null}
        earlier={earlier}
        readOnly={readOnly}
        clipIndex={Number.isInteger(clipInfo?.index) ? clipInfo.index : null}
      />
      <ConflictDialog
        conflict={conflict}
        onResolve={(choices) => {
          Promise.resolve(store.resolveConflict?.(choices)).catch(() => {}); // the dialog shows conflict.error
        }}
      />
      <FramingDialog
        open={framingOpen}
        onClose={closeFraming}
        state={state}
        dispatch={dispatch}
        player={player}
        frameBus={frameBus}
        previewClient={runtime.kind === "fake" ? runtime.previewClient : null}
        readOnly={readOnly}
        onUndo={() => { if (!readOnly) store.undo(); }}
        onRedo={() => { if (!readOnly) store.redo(); }}
      />
      <SplitDialog
        open={splitOpen}
        onClose={closeSplit}
        state={state}
        dispatch={dispatch}
        player={player}
        frameBus={frameBus}
        previewClient={runtime.kind === "fake" ? runtime.previewClient : null}
        readOnly={readOnly}
        onUndo={() => { if (!readOnly) store.undo(); }}
        onRedo={() => { if (!readOnly) store.redo(); }}
      />
      <ShortcutHelp open={helpOpen} onClose={closeHelp} singleKey={singleKeyOn} onSingleKeyChange={changeSingleKey} />
      {toast && <div key={toast.id} className={styles.toast} role="status" aria-live="polite">{toast.text}</div>}
    </>
  );

  if (oneLayout) {
    const transcriptEntry = panels.find((entry) => entry.id === "transcript");
    const Transcript = transcriptEntry ? lazyComponent(transcriptEntry) : null;
    return (
      <EditorShell
        rootProps={{ "data-editor-status": status, "data-editor-ready": isReady ? "true" : "false" }}
        topBar={topBar}
        clips={<ClipList jobId={jobId} clips={clipList} clipId={clipId} onOpen={(row) => openClip(row.href)} onDrawerChange={setClipsDrawerOpen} />}
        stage={(
          <>
            {stageNotices}
            <div className={shellStyles.stageHead}>
              <p className={shellStyles.ratio} data-stage-ratio="">{tEditor("stage.ratio", { ratio: outputRatio(frame) })}</p>
            </div>
            <div className={shellStyles.stageBody}>{stage}</div>
            <div className={shellStyles.transport}>
              <StageControls
                fps={fps}
                totalFrames={plan?.totalFrames ?? 0}
                frameBus={frameBus}
                plan={plan}
                playing={Boolean(playerState?.playing)}
                onPlayPause={playPause}
                onStep={(delta) => player.step(delta)}
                disabled={!plan}
              />
              <div className={shellStyles.scrubberRow}>
                <Scrubber plan={plan} state={state} player={player} frameBus={frameBus} disabled={!plan} />
              </div>
            </div>
          </>
        )}
        transcript={Transcript ? (
          <Suspense fallback={<p className={styles.muted}>{tEditor("shell.openingPanel")}</p>}>
            <Transcript {...panelProps} />
          </Suspense>
        ) : null}
        panel={<PanelTabs value={tabId} onChange={changeTab} panelProps={panelProps} />}
        timeline={(
          <TimelineDetail>
            <Timeline plan={plan} state={state} dispatch={dispatch} player={player} frameBus={frameBus} notify={notify} readOnly={readOnly} lanes={lanes} />
          </TimelineDetail>
        )}
      >
        {dialogs}
      </EditorShell>
    );
  }

  return (
    <div
      className={`${tokens.tokens} ${styles.shell}`}
      data-editor-root=""
      data-editor-view={view}
      data-editor-status={status}
      data-editor-ready={isReady ? "true" : "false"}
    >
      {topBar}

      {view === "cepat" ? (
        <aside key="cards" className={styles.quickSide} data-slot="cards" aria-label="Pengaturan klip">
          <QuickPanel {...panelProps} frameBus={frameBus} showLengkap={showLengkap} initialCard={openingCardRef.current}
            onCardChange={onCardChange} />
        </aside>
      ) : (
        [
          <nav key="rail" className={styles.toolRail} data-slot="rail" aria-label="Alat editor">
            <Rail panels={panels} value={panel.id} onChange={setPanelId} />
          </nav>,
          <aside key="panels" className={styles.panels} data-slot="panels" aria-label="Panel editor">
            <div className={styles.tabPanel} role="tabpanel" id="editor-panel" aria-labelledby={`editor-tab-${panel.id}`}>
              {/* The panel's name as the level-2 heading its sections (h3) sit under (QG-A11Y heading order). */}
              <h2 className={styles.visuallyHidden}>{panel.label}</h2>
              <Suspense fallback={<p className={styles.muted}>Membuka panel…</p>}>
                <Panel {...panelProps} />
              </Suspense>
            </div>
          </aside>,
        ]
      )}

      <main key="stage" className={styles.stageRegion} data-slot="stage">
        {stageNotices}
        {stage}
      </main>

      {view === "cepat" ? (
        <footer key="cepat-bottom" className={styles.quickBottom} data-slot="bottom">
          <PlayButton playing={Boolean(playerState?.playing)} onPlayPause={playPause} disabled={!plan} />
          <TimeReadout frameBus={frameBus} fps={fps} totalFrames={plan?.totalFrames ?? 0} />
          <div className={styles.scrubberSlot}>
            <Scrubber plan={plan} state={state} player={player} frameBus={frameBus} disabled={!plan} />
          </div>
          <PillButton variant="quiet" onClick={() => showLengkap("transcript")}>Potong per kata di Mode Lengkap →</PillButton>
        </footer>
      ) : (
        // A footer, as Cepat's bottom bar: the transport row sits in a landmark (QG-A11Y "region").
        <footer key="lengkap-bottom" className={styles.lengkapBottom} data-slot="bottom">
          <StageControls
            fps={fps}
            totalFrames={plan?.totalFrames ?? 0}
            frameBus={frameBus}
            plan={plan}
            playing={Boolean(playerState?.playing)}
            onPlayPause={playPause}
            onStep={(delta) => player.step(delta)}
            disabled={!plan}
          />
          <Timeline plan={plan} state={state} dispatch={dispatch} player={player} frameBus={frameBus} notify={notify} readOnly={readOnly} lanes={lanes} />
        </footer>
      )}

      {dialogs}
    </div>
  );
}

// While the job is prepared for the editor (POST /clips: words, waveform and camera plans for every
// clip, about a minute for a long face-track job): one status line, the seconds it has taken and
// an indeterminate bar. The seconds are not announced every second; the status line is.
function PreparePage({ jobId, startedAt }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return (
    <StatePage title="Menyiapkan klip untuk diedit" jobId={jobId} busy>
      <p role="status" aria-live="polite">Menyiapkan transkrip kata, waveform, dan wajah.</p>
      <p className={styles.prepareSeconds} data-prepare-seconds={seconds}>{`${seconds} dtk`}</p>
      <p>Hanya sekali per proyek. Video panjang dengan face-track bisa butuh sekitar satu menit.</p>
    </StatePage>
  );
}

export default function EditorApp({
  jobId, clipId: initialClipId = null, clipIndex = null, runtimeKind = "real", runtime: injected = null, initialPanel,
  features = {}, singleKeyShortcuts = true, shell: shellFlag = "legacy",
}) {
  const narrow = useNarrow();
  // On the fakes (dev and CI only) the e2e scenario may pick the shell, so one server runs the
  // specs of both shells; the app follows POTONGIN_EDITOR_SHELL.
  const [shell] = useState(() => {
    const picked = runtimeKind === "fake" ? globalThis.__potonginEditorScenario?.shell : null;
    return picked === "v2" || picked === "legacy" ? picked : shellFlag === "v2" ? "v2" : "legacy";
  });
  const [runtime, setRuntime] = useState(injected);
  const [failure, setFailure] = useState(null);
  const [clipId, setClipId] = useState(initialClipId);
  // A clip opened by its number ("klip-3") or one whose analysis is missing is prepared here, once
  // per page load (owner feedback: no manual "Siapkan untuk editor" step).
  const [prepare, setPrepare] = useState(() => (!injected && !initialClipId ? { startedAt: Date.now() } : null));
  const [prepared, setPrepared] = useState(false);

  useEffect(() => {
    if (injected || prepare || !clipId) return undefined;
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
  }, [injected, runtimeKind, jobId, clipId, prepare]);

  useEffect(() => {
    if (!prepare) return undefined;
    const controller = new AbortController();
    let alive = true;
    prepareForEditor({ jobId, clipId, index: clipIndex, signal: controller.signal })
      .then((result) => {
        if (!alive) return;
        if (result.state === "redirect") {
          window.location.assign(result.location);
          return;
        }
        setPrepared(true);
        setPrepare(null);
        if (result.state !== "ready") {
          setFailure({ code: result.code, message: result.message });
          return;
        }
        // The clip's own address, keeping the query (?mode, ?panel, ?card) and the hash (Mode Cepat spec §4.4).
        const href = editorHref(jobId, { clipId: result.clipId });
        if (href && window.location.pathname !== href) {
          window.history.replaceState(window.history.state, "", `${href}${window.location.search}${window.location.hash}`);
        }
        setClipId(result.clipId);
      })
      .catch((error) => {
        if (!alive || error?.name === "AbortError") return;
        setPrepared(true);
        setPrepare(null);
        setFailure({ code: "prepare_failed", message: "Klip belum bisa disiapkan. Muat ulang halaman untuk mencoba lagi." });
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [prepare, jobId, clipId, clipIndex]);

  const onNeedsPrepare = useCallback(() => setPrepare({ startedAt: Date.now() }), []);

  if (narrow) {
    return (
      <StatePage title="Editor butuh layar minimal 1024 px" jobId={jobId}>
        <p>Buka klip ini di laptop atau komputer. Pratinjau baca-saja untuk layar kecil belum tersedia.</p>
      </StatePage>
    );
  }
  if (failure) {
    const known = typeof failure.message === "string" && failure.message && failure.code !== "runtime_unavailable";
    return (
      <StatePage title={known ? "Klip tidak bisa dibuka" : "Editor belum tersedia"} jobId={jobId}>
        <p>{known ? failure.message
          : failure.code === "runtime_unavailable" ? "Editor belum tersambung ke server. Coba lagi nanti." : "Editor gagal dimuat. Muat ulang halaman."}</p>
      </StatePage>
    );
  }
  if (prepare) return <PreparePage jobId={jobId} startedAt={prepare.startedAt} />;
  if (!runtime) {
    return <StatePage title="Membuka klip…" busy><p>Menyiapkan transkrip, pratinjau, dan timeline.</p></StatePage>;
  }
  return (
    <EditorWorkspace
      key={`${jobId}/${clipId}`}
      runtime={runtime}
      jobId={jobId}
      clipId={clipId}
      initialPanel={initialPanel}
      features={features}
      onNeedsPrepare={injected || prepared ? null : onNeedsPrepare}
      singleKeyShortcuts={singleKeyShortcuts}
      shell={shell}
    />
  );
}
