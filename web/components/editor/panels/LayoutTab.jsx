"use client";

// Tab Tata letak of the one-layout editor (rombak 06 §8.2, §5.2, Editor F4a): the layout cards with
// their truth-frame thumbnails and the face analysis's progress; under face-track what the parts
// without a face show; under layar terbagi the share and Tukar; the fine controls in Lanjutan.
// Moving the frame happens on the stage (Lihat sumber, shell/SourceStage.jsx); while it shows the
// source, this tab holds the keyframe at the playhead. The rules and the analysis are the ones the
// old panel uses (layout-model.mjs, layout-analysis.mjs, framing-model.mjs, split-model.mjs).
// The Otomatis card (06 §8.2) comes with the reframe work of Fase 7 and the shot strip with F4b.
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { useTranslations } from "use-intl";

import { SPLIT_ZOOM_RANGE } from "../../../lib/editor/doc-model.mjs";
import { STAGE_SOURCE } from "../../../lib/editor/stage-view.mjs";
import { ratioName } from "../../../lib/output-frame.mjs";
import ApplyAll from "../apply-all/ApplyAll.jsx";
import {
  FRAMING_MOVES, clearKeyframesCommand, framingSummary, framingView, keyframeCommand, keyframeMoveCommand, removeKeyframeCommand,
} from "../framing-model.mjs";
import Advanced from "../shell/Advanced.jsx";
import { rejectionText } from "../shell-model.mjs";
import { SPLIT_RATIOS, splitCropCommand, splitRatioCommand, splitSummary, swapSplitCommand, zoomPercent as splitZoomPercent } from "../split-model.mjs";
import PillButton from "../ui/PillButton.jsx";
import PillGroup from "../ui/PillGroup.jsx";
import { analysisBusy, analysisForView, layoutAnalysisFor } from "./layout-analysis.mjs";
import {
  LAYOUT_OPTIONS, NO_FACE_OPTIONS, analysisView, cameraReadyFromState, layoutCommand, noFaceCommand, noFaceView, switchSteps, zoomCommand,
  zoomPercent, zoomResetCommand, zoomView,
} from "./layout-model.mjs";
import { useLatest, useRestingPlayhead, useServices, useThumbnails } from "./layout-services.js";
import { CardGroup, TabGroup, TabNote, TabSlider } from "./tab-ui.jsx";
import styles from "./tabs.module.css";

function Thumbnail({ name, thumb, busy, emptyText }) {
  if (thumb?.url) {
    return (
      <span className={styles.thumbBox}>
        <img key={thumb.url} className={`${styles.layoutThumb} ${thumb.status === "refreshing" ? styles.thumbStale : ""}`} src={thumb.url}
          width={90} height={160} alt="" data-layout-thumb={name} draggable={false} />
      </span>
    );
  }
  return (
    <span className={styles.thumbBox}>
      <span className={styles.thumbEmpty} data-layout-thumb-empty={name}>{busy ? null : emptyText}</span>
    </span>
  );
}

/** The playhead as it moves; only asked for while the source shows, which never plays. */
function useLivePlayhead(player, on) {
  const [frame, setFrame] = useState(() => player?.frame?.() ?? 0);
  useEffect(() => {
    if (!on || typeof player?.subscribeFrame !== "function") return undefined;
    setFrame(player.frame?.() ?? 0);
    return player.subscribeFrame((next) => setFrame(next));
  }, [player, on]);
  return frame;
}

/** Stored once, when let go: every stored zoom asks the preview lane for a new plate. */
function useSettledSlider(current, commit) {
  const [draft, setDraftState] = useState(null);
  const draftRef = useRef(null);
  const set = (next) => {
    draftRef.current = next;
    setDraftState(next);
  };
  const settle = () => {
    const pending = draftRef.current;
    set(null);
    if (pending !== null && pending !== current) commit(pending);
  };
  return { value: draft ?? current, set, settle };
}

function ZoomSlider({ t, doc, readOnly, send }) {
  const view = zoomView(doc);
  const slider = useSettledSlider(view.zoom, (value) => send(zoomCommand(value)));
  return (
    <div className={styles.stack} data-layout-zoom="" data-zoom-pm={view.zoom}>
      <TabSlider label={t("zoom")} min={view.min} max={view.max} step={view.step} value={slider.value} valueText={`${zoomPercent(slider.value)}%`}
        disabled={readOnly} note={t("zoomNote", { percent: zoomPercent(view.max) })} data-control="layout-zoom"
        onChange={slider.set} onRelease={slider.settle} />
      {view.zoomed ? (
        <PillButton variant="quiet" disabled={readOnly} onClick={() => send(zoomResetCommand())}>{t("zoomReset")}</PillButton>
      ) : null}
    </div>
  );
}

function BandZoom({ t, band, label, split, readOnly, send }) {
  const crop = split[band];
  const slider = useSettledSlider(crop.zoom_pm, (value) => send(splitCropCommand(band, { ...crop, zoom_pm: value })));
  return (
    <TabSlider label={label} min={SPLIT_ZOOM_RANGE[0]} max={SPLIT_ZOOM_RANGE[1]} step={10} value={slider.value}
      valueText={t("percent", { percent: splitZoomPercent(slider.value) })} disabled={readOnly} data-split-zoom={band}
      onChange={slider.set} onRelease={slider.settle} />
  );
}

/** The keyframe at the playhead, while the stage shows the source (06 §5.2). */
function KeyframeTools({ t, doc, plan, frame, readOnly, player, send }) {
  const uid = useId();
  const view = framingView({ doc, plan, frame });
  const summary = framingSummary(doc);
  const seek = (target) => { if (target !== null) player?.seek?.(target); };
  const moves = FRAMING_MOVES.map((move) => ({ id: move.id, label: move.id === "cut" ? t("keyframe.cut") : t("keyframe.slide") }));
  return (
    <div className={styles.stack} data-keyframe-tools="" data-keyframe-index={view.index}>
      <h4 className={styles.subtitle}>{t("keyframe.title")}</h4>
      <TabNote aria-live="polite">
        {view.index >= 0 ? t("keyframe.here", { index: view.index + 1, count: view.count }) : t("keyframe.notHere", { count: summary.count })}
      </TabNote>
      <div className={styles.row}>
        <PillButton disabled={view.previous === null} onClick={() => seek(view.previous)}>{t("keyframe.previous")}</PillButton>
        <PillButton disabled={view.next === null} onClick={() => seek(view.next)}>{t("keyframe.next")}</PillButton>
      </div>
      <div className={styles.row}>
        <PillButton disabled={readOnly || view.sf === null || view.index >= 0} onClick={() => send(keyframeCommand(view.sf, view.pan))}>{t("keyframe.add")}</PillButton>
        <PillButton disabled={readOnly || view.index < 0} onClick={() => send(removeKeyframeCommand(view.sf))}>{t("keyframe.remove")}</PillButton>
      </div>
      <PillGroup legend={t("keyframe.move")} name={`${uid}-move`} options={moves} value={view.move} disabled={readOnly || !view.moveEditable}
        describedBy={`${uid}-move-note`} onChange={(move) => send(keyframeMoveCommand(view.sf, move))} />
      <TabNote id={`${uid}-move-note`}>{view.moveEditable ? t("keyframe.moveNote") : t("keyframe.moveNoteFirst")}</TabNote>
    </div>
  );
}

function LayoutTabBody({
  state, getState = null, dispatch, player, api: apiProp, previewClient, analysisStore, applyAll = null, stageView = null, reveal = null,
}) {
  const t = useTranslations("editor.layout");
  const names = { fit_blur: t("names.fitBlur"), camera: t("names.camera"), fill_center: t("names.fillCenter"), split: t("names.split") };
  const doc = state.doc;
  const readOnly = state.status !== "ready";
  const layout = doc.layout.default.mode;
  const services = useServices(state, { api: apiProp, previewClient });
  const run = useSyncExternalStore(analysisStore.subscribe, analysisStore.get, analysisStore.get);
  const [message, setMessage] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const stateRef = useLatest(state);
  const dispatchRef = useLatest(dispatch);
  const resting = useRestingPlayhead(player);
  const sourceShown = stageView === STAGE_SOURCE;
  const live = useLivePlayhead(player, sourceShown);
  const cameraReady = run.cameraReady || cameraReadyFromState(state);
  const { thumbs } = useThumbnails({ state, services, frame: resting, cameraReady });
  const choice = analysisBusy(run) && run.target === "camera" ? "camera" : null;
  const running = run.phase === "running";
  const uid = useId();

  useEffect(() => {
    if (!running) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const send = ({ type, args, mergeKey }) => {
    try {
      dispatchRef.current(type, args, { mergeKey });
      setMessage(null);
    } catch (error) {
      setMessage(rejectionText(error));
    }
  };

  const analyse = useCallback(({ switchAfter = true, auto = false } = {}) => {
    setMessage(null);
    const liveState = typeof getState === "function" ? getState : () => stateRef.current;
    return analysisStore.start({ api: services.api(), dispatch: (...args) => dispatchRef.current(...args), getState: liveState, switchAfter, auto });
  }, [analysisStore, services, dispatchRef, stateRef, getState]);

  const choose = (mode) => {
    if (readOnly) return;
    const steps = switchSteps({ target: mode, current: layout, cameraReady });
    if (steps === "analyze") {
      analyse();
      return;
    }
    analysisStore.cancelSwitch();
    if (steps === "dispatch") send(layoutCommand(mode));
  };

  // A face-track document whose camera plan is missing: analyse it, once per clip.
  const missing = state.previewError?.code === "analysis_missing" && layout === "camera";
  useEffect(() => {
    if (missing) analyse({ switchAfter: false, auto: true });
  }, [missing, analyse]);

  const view = analysisView(analysisForView(run), now);
  const refused = message ?? (run.phase !== "failed" ? run.message : null);
  const shownLayout = choice ?? layout;
  const pending = choice !== null && choice !== layout;
  const planCurrent = !(state.pending ?? []).includes("text") && !state.previewError && Boolean(state.plan);
  const noFace = noFaceView(doc, state.plan);
  const framing = framingSummary(doc);
  const split = splitSummary(doc);
  const zoom = zoomView(doc);
  const ratio = ratioName(doc.output);
  const notes = {
    fit_blur: t("modes.fitBlurNote"),
    camera: noFace.mode === "center" && layout === "camera" ? t("modes.cameraCentredNote", { ratio }) : t("modes.cameraNote", { ratio }),
    fill_center: t("modes.fillCenterNote", { ratio }),
    split: t("modes.splitNote"),
  };
  const noFaceOptions = NO_FACE_OPTIONS.map((option) => ({ id: option.id, label: option.id === "fit_blur" ? t("noFace.blur") : t("noFace.centre") }));
  const framingText = framing.available
    ? (framing.count
      ? (layout === "camera" ? t("framing.manualCamera", { count: framing.count }) : t("framing.manual", { count: framing.count }))
      : (layout === "camera" ? t("framing.autoCamera") : t("framing.autoCentre")))
    : (framing.reason === "portrait" ? t("framing.portrait") : t("framing.pick"));
  const noFaceNoteId = `${uid}-noface`;

  const emptyText = (mode) => {
    const thumb = thumbs[mode];
    if (thumb?.status === "needs_analysis") return t("thumbs.needsAnalysis");
    return thumb?.status === "unavailable" ? t("thumbs.unavailable") : t("thumbs.loading");
  };
  const cameraLabel = ({ key, values }) => {
    if (key === "keyframes") return t("summary.keyframes", { count: values.count });
    return key === "zoom" ? t("percent", { percent: values.percent }) : null;
  };
  const splitLabel = ({ key, values }) => (key === "zoom" ? t("summary.bands", { top: values.top, bottom: values.bottom }) : null);

  return (
    <section data-panel="layout" className={styles.tab} aria-busy={running}>
      {refused ? <p className={styles.message} role="alert">{refused}</p> : null}
      <TabGroup title={t("title")} data-tab-group="mode">
        <CardGroup label={t("choose")} labelHidden name="layout-mode" value={shownLayout} columns={4} disabled={readOnly} describedBy={`${uid}-whole`}
          onChange={choose}
          options={LAYOUT_OPTIONS.map((option) => ({
            id: option.id,
            name: names[option.id],
            note: notes[option.id],
            badge: pending && option.id === layout ? t("inUse") : null,
            thumb: (
              <Thumbnail name={option.id} thumb={thumbs[option.id]} busy={option.id === "camera" && running} emptyText={emptyText(option.id)} />
            ),
          }))} />
        <TabNote id={`${uid}-whole`}>{`${t("wholeClip")} ${notes[shownLayout] ?? ""}`}</TabNote>
        {view && running ? (
          <div className={styles.stack} data-layout-analysis="" role="status">
            <progress className={styles.progress} aria-label={t("analysis.label")} max={view.determinate ? view.max : undefined}
              value={view.determinate ? view.value : undefined} />
            <span className={styles.note} data-layout-analysis-text="">
              {view.determinate ? t("analysis.percent", { percent: view.percent }) : t("analysis.seconds", { seconds: view.seconds ?? 0 })}
            </span>
            {run.target === "camera" ? <TabNote>{t("analysis.switchAfter")}</TabNote> : null}
          </div>
        ) : null}
        {view && run.phase === "failed" ? (
          <div className={styles.stack} role="alert" data-layout-analysis-error="">
            <TabNote tone="warning">{view.text}</TabNote>
            <PillButton disabled={readOnly && layout !== "camera"} onClick={() => analyse({ switchAfter: layout !== "camera" })}>{t("analysis.retry")}</PillButton>
          </div>
        ) : null}
        {zoom.bars ? <TabNote data-layout-bars="">{t("bars")}</TabNote> : null}
      </TabGroup>

      {split ? (
        <TabGroup title={t("split.title")} data-tab-group="split" data-layout-split="" data-top-pm={doc.layout.split.top_pm}>
          <TabNote>{t("split.summary", { top: split.top, bottom: split.bottom })}</TabNote>
          <PillGroup legend={t("split.share")} name={`${uid}-split`} options={SPLIT_RATIOS.map(({ id, label }) => ({ id, label }))} value={split.ratio}
            disabled={readOnly} onChange={(ratio_) => send(splitRatioCommand(ratio_, doc.layout.split))} />
          <PillButton variant="quiet" disabled={readOnly} onClick={() => send(swapSplitCommand())}>{t("split.swap")}</PillButton>
          <Advanced group="split" doc={doc} seed={state.seed} labelFor={splitLabel} reveal={reveal}>
            <div className={styles.stack}>
              <BandZoom t={t} band="top" label={t("split.zoomTop")} split={doc.layout.split} readOnly={readOnly} send={send} />
              <BandZoom t={t} band="bottom" label={t("split.zoomBottom")} split={doc.layout.split} readOnly={readOnly} send={send} />
            </div>
          </Advanced>
        </TabGroup>
      ) : (
        <TabGroup title={t("framing.title")} data-tab-group="framing" data-layout-framing="" data-keyframes={framing.count}>
          {framingText ? <TabNote data-framing-summary="">{framingText}</TabNote> : null}
          {sourceShown && framing.available ? (
            <KeyframeTools t={t} doc={doc} plan={state.plan} frame={live} readOnly={readOnly} player={player} send={send} />
          ) : null}
          {layout === "camera" && !framing.count ? (
            <div className={styles.stack} data-layout-noface="" data-no-face={noFace.mode}>
              {/* Above the list a re-plan replaces: the choice keeps its place and its focus. */}
              <PillGroup legend={t("noFace.title")} name={`${uid}-noface-choice`} options={noFaceOptions} value={noFace.mode} disabled={readOnly}
                describedBy={planCurrent && noFace.runs.length ? noFaceNoteId : undefined} onChange={(mode) => send(noFaceCommand(mode))} />
              {!planCurrent ? <TabNote>{t("noFace.checking")}</TabNote> : noFace.runs.length === 0 ? <TabNote>{t("noFace.none")}</TabNote> : (
                <>
                  <TabNote id={noFaceNoteId}>
                    {`${t("noFace.runs", { count: noFace.runs.length })} ${noFace.mode === "fit_blur" ? t("noFace.blurNote") : t("noFace.centreNote")}`}
                  </TabNote>
                  <ul className={styles.jumps}>
                    {noFace.runs.map((entry) => (
                      <li key={entry.f}>
                        <PillButton variant="quiet" onClick={() => player?.seek?.(entry.f)}>{t("noFace.jump", { time: entry.time })}</PillButton>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          ) : null}
          {zoom.available ? (
            <Advanced group="camera" doc={doc} seed={state.seed} labelFor={cameraLabel} reveal={reveal}>
              <div className={styles.stack}>
                {framing.count ? (
                  <PillButton disabled={readOnly} onClick={() => send(clearKeyframesCommand())}>{t("framing.clear")}</PillButton>
                ) : null}
                <ZoomSlider t={t} doc={doc} readOnly={readOnly} send={send} />
              </div>
            </Advanced>
          ) : null}
        </TabGroup>
      )}

      <div className={styles.group}>
        <ApplyAll applyAll={applyAll} group="layout" disabled={readOnly || analysisBusy(run)} confirm />
      </div>
    </section>
  );
}

export default function LayoutTab(props) {
  const tShell = useTranslations("editor.shell");
  const { state } = props;
  const analysisStore = layoutAnalysisFor(state?.clipId ?? state?.doc?.clip_id ?? null);
  if (!state?.doc || !analysisStore) {
    return (
      <section data-panel="layout" className={styles.tab} aria-busy={state?.status === "loading"}>
        <p className={styles.note}>{tShell("openingPanel")}</p>
      </section>
    );
  }
  return <LayoutTabBody {...props} analysisStore={analysisStore} />;
}
