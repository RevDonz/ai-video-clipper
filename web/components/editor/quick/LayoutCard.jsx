"use client";

// Mode Cepat's Tata letak card (docs/plans/2026-10-02-editor-mode-cepat.md §1.4 Tata letak, §4.1):
// three pills for the whole clip, Latar blur, Potong tengah and Ikuti wajah. Face-track without
// the clip's camera plan runs the face analysis first, through the clip's own analysis store
// (layout-analysis.mjs), and switches after; the run keeps going when the card closes or the view
// switches, and LayoutPanel shows the same progress. Another choice during the analysis wins.
// The thumbnails and the runs without a face stay in Mode Lengkap. Props: the card bundle.
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";

import { analysisApi, analysisBusy, analysisForView, layoutAnalysisFor } from "../panels/layout-analysis.mjs";
import { analysisView, cameraReadyFromState, layoutCommand, switchSteps } from "../panels/layout-model.mjs";
import { rejectionText } from "../shell-model.mjs";
import PillButton from "../ui/PillButton.jsx";
import PillGroup from "../ui/PillGroup.jsx";
import { CARD_LAYOUTS } from "./quick-model.mjs";
import styles from "./quick.module.css";

const OPTIONS = CARD_LAYOUTS.map((option) => ({ id: option.id, label: option.name, title: option.note }));

function LayoutBody({ state, getState, dispatch, api, analysis }) {
  const doc = state.doc;
  const locked = state.status !== "ready";
  const layout = doc.layout.default.mode;
  const run = useSyncExternalStore(analysis.subscribe, analysis.get, analysis.get);
  // The analysis outlives this card: it reads the store as it is when the run ends.
  const stateRef = useRef(state);
  stateRef.current = state;
  const liveState = typeof getState === "function" ? getState : () => stateRef.current;
  const [message, setMessage] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const uid = useId();
  const cameraReady = run.cameraReady || cameraReadyFromState(state);
  const choice = analysisBusy(run) && run.target === "camera" ? "camera" : null;

  useEffect(() => {
    if (run.phase !== "running") return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [run.phase]);

  const start = (switchAfter, auto = false) => analysis.start({
    api: analysisApi(api), dispatch, getState: liveState, switchAfter, auto,
  });
  const startRef = useRef(start);
  startRef.current = start;

  // A face-track document whose camera plan is missing (the plan request says so): analyse it,
  // as LayoutPanel does; the store runs this automatic analysis once per clip.
  const missing = state.previewError?.code === "analysis_missing" && layout === "camera";
  useEffect(() => {
    if (missing) startRef.current(false, true);
  }, [missing]);

  const choose = (mode) => {
    if (locked) return;
    const steps = switchSteps({ target: mode, current: layout, cameraReady });
    if (steps === "analyze") {
      setMessage(null);
      start(true);
      return;
    }
    analysis.cancelSwitch();
    if (steps !== "dispatch") return;
    const { type, args, mergeKey } = layoutCommand(mode);
    try {
      dispatch(type, args, { mergeKey });
      setMessage(null);
    } catch (error) {
      setMessage(rejectionText(error));
    }
  };

  const view = analysisView(analysisForView(run), now);
  const refused = message ?? (run.phase !== "failed" ? run.message : null);

  return (
    <div className={styles.body} data-quick-body="layout">
      {refused ? <p className={styles.message} role="alert">{refused}</p> : null}
      <PillGroup legend="Pilih tata letak" legendHidden name={`${uid}-layout`} options={OPTIONS} value={choice ?? layout}
        disabled={locked} describedBy={`${uid}-about`} onChange={choose} />
      <p id={`${uid}-about`} className={styles.note}>Berlaku untuk seluruh klip.</p>
      {view && run.phase === "running" ? (
        <div className={styles.analysis} data-layout-analysis="" role="status">
          <progress className={styles.progress} aria-label="Analisis wajah"
            max={view.determinate ? view.max : undefined} value={view.determinate ? view.value : undefined} />
          <span data-layout-analysis-text="">{view.text}</span>
          {run.target === "camera" ? (
            <span className={styles.note}>Tata letak berganti setelah analisis selesai. Pilih yang lain untuk membatalkan.</span>
          ) : null}
        </div>
      ) : null}
      {view && run.phase === "failed" ? (
        <div className={styles.failure} role="alert" data-layout-analysis-error="">
          <span>{view.text}</span>
          <PillButton disabled={locked && layout !== "camera"} onClick={() => start(layout !== "camera")}>Coba lagi</PillButton>
        </div>
      ) : null}
    </div>
  );
}

export default function LayoutCard({ state, getState = null, dispatch, api = null }) {
  const analysis = layoutAnalysisFor(state?.clipId ?? state?.doc?.clip_id ?? null);
  if (!state?.doc || !analysis) return <p className={styles.note} role="status">Membuka tata letak…</p>;
  return <LayoutBody state={state} getState={getState} dispatch={dispatch} api={api} analysis={analysis} />;
}
