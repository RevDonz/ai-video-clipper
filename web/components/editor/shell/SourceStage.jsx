"use client";

// "Lihat sumber" (rombak 06 §5.2, Editor F4a): over the stage, the source picture at the playhead
// with the crop's gizmo, FrameGizmo for the crop layouts and SplitGizmo for layar terbagi, and the
// result beside it. It replaces the dialogs "Atur bingkai" and "Atur layar terbagi" of the old
// shell. A drag is drawn from a draft and stored once, on release; a key on a box stores at once.
// The playhead is the editor's: the transport under the stage moves the picture too. The canvas
// and the player stay mounted under it, so going back shows the result at once. The keyframe at
// the playhead has its controls in tab Tata letak (panels/LayoutTab.jsx).
// Props: { state, dispatch, frameBus, previewClient, readOnly, onBack, boxFocusKey }.
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "use-intl";

import { framingSizes } from "../../../lib/editor/framing.mjs";
import { framingView, keyframeCommand } from "../framing-model.mjs";
import FrameGizmo from "../gizmos/FrameGizmo.jsx";
import SplitGizmo from "../gizmos/SplitGizmo.jsx";
import { frameGeometry, resultBackground } from "../gizmos/frame-geometry.mjs";
import { bandBackground, resultRows } from "../gizmos/split-geometry.mjs";
import { rejectionText } from "../shell-model.mjs";
import { splitCropCommand, splitView } from "../split-model.mjs";
import PillButton from "../ui/PillButton.jsx";
import { useStill, useStillClient } from "../use-still.js";
import styles from "./editor-shell.module.css";

const clampFrame = (frame, total) => Math.min(Math.max(Number.isSafeInteger(frame) ? frame : 0, 0), Math.max(total - 1, 0));

/** The playhead in the output, kept inside the clip. */
function useSourceFrame(frameBus, total) {
  const [frame, setFrame] = useState(() => clampFrame(frameBus?.get?.() ?? 0, total));
  useEffect(() => {
    if (!frameBus) return undefined;
    setFrame(clampFrame(frameBus.get(), total));
    return frameBus.subscribe((next) => setFrame(clampFrame(next, total)));
  }, [frameBus, total]);
  return frame;
}

function useSend(dispatch) {
  const [message, setMessage] = useState(null);
  const send = (command) => {
    try {
      dispatch(command.type, command.args, { mergeKey: command.mergeKey });
      setMessage(null);
    } catch (error) {
      setMessage(rejectionText(error));
    }
  };
  return { message, send };
}

function Picture({ source, children }) {
  return (
    <div className={styles.sourceFit}>
      <div className={styles.sourcePicture} style={{ "--source-ratio": source[0] / source[1] }}>{children}</div>
    </div>
  );
}

function FrameSource({ state, dispatch, frame, client, locked }) {
  const t = useTranslations("editor.stage.source");
  const doc = state.doc;
  const plan = state.plan;
  const total = plan?.totalFrames ?? 0;
  const [draft, setDraft] = useState(null);
  const { message, send } = useSend(dispatch);
  const boxRef = useRef(null);
  const { source, output, zoom } = framingSizes(doc);
  const sizeKey = `${source.join("x")}:${output.join("x")}:${zoom}`;
  const geometry = useMemo(() => frameGeometry(source, output, zoom), [sizeKey]); // the sizes, not the arrays
  const view = framingView({ doc, plan, frame, draft });
  const { still, retry } = useStill({ client, doc, frame });
  const result = resultBackground(view.crop ?? 0, geometry);

  useEffect(() => {
    const raf = requestAnimationFrame(() => boxRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <>
      {message ? <p className={styles.sourceMessage} role="alert">{message}</p> : null}
      <div className={styles.sourceBody}>
        <Picture source={source}>
          <FrameGizmo geometry={geometry} crop={view.crop} pan={view.pan} auto={view.auto && draft === null} locked={locked}
            stillUrl={still.url} stillState={still.state} onDrag={setDraft} boxRef={boxRef} onRetry={retry}
            onCommit={(pan) => { if (view.sf !== null && !locked) send(keyframeCommand(view.sf, pan)); }} />
          <div className={styles.sourceMarks} aria-hidden="true">
            {view.marks.map((mark) => (
              <span key={mark.sf} className={styles.sourceMark} data-keyframe-mark={mark.f} data-here={mark.f === frame ? "true" : undefined}
                style={{ left: `${(total > 1 ? mark.f / (total - 1) : 0) * 100}%` }} />
            ))}
          </div>
        </Picture>
        <figure className={styles.sourceResult}>
          <figcaption className={styles.sourceResultLabel}>{t("result")}</figcaption>
          {view.resultKnown && still.url ? (
            <div className={styles.sourceResultFrame} role="img" aria-label={t("result")} data-framing-result=""
              style={{ aspectRatio: `${output[0]} / ${output[1]}`, backgroundImage: `url("${still.url}")`, backgroundSize: result.size, backgroundPosition: result.position }} />
          ) : (
            <div className={styles.sourceResultFrame} data-framing-result="" data-empty="" style={{ aspectRatio: `${output[0]} / ${output[1]}` }}>
              <span>{view.resultKnown ? t("loading") : t("followsFace")}</span>
            </div>
          )}
        </figure>
      </div>
    </>
  );
}

function SplitSource({ state, dispatch, frame, client, locked }) {
  const t = useTranslations("editor.stage.source");
  const doc = state.doc;
  const [draft, setDraft] = useState(null);
  const { message, send } = useSend(dispatch);
  const boxRefs = useRef({});
  // The small band first: the one a facecam usually takes.
  const [active, setActive] = useState(() => (doc.layout.split?.top_pm === 700 ? "bottom" : "top"));
  const view = splitView({ doc, draft });
  const { still, retry } = useStill({ client, doc, frame });

  useEffect(() => {
    const raf = requestAnimationFrame(() => boxRefs.current[active]?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(raf);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once, as the view opens

  if (!view) return null;
  const rows = resultRows(view.geometry, view.output);
  const layer = (band) => {
    const { size, position } = bandBackground(view.geometry, band, view.source, view.output);
    return { backgroundImage: `url("${still.url}")`, backgroundSize: size, backgroundPosition: position };
  };
  const aspectRatio = `${doc.output.w} / ${doc.output.h}`;
  return (
    <>
      {message ? <p className={styles.sourceMessage} role="alert">{message}</p> : null}
      <div className={styles.sourceBody}>
        <Picture source={view.source}>
          <SplitGizmo view={view} active={active} locked={locked} stillUrl={still.url} stillState={still.state} onSelect={setActive}
            onDraft={setDraft} boxRefs={boxRefs} onRetry={retry} onCommit={(band, crop) => { if (!locked) send(splitCropCommand(band, crop)); }} />
        </Picture>
        <figure className={styles.sourceResult}>
          <figcaption className={styles.sourceResultLabel}>{t("result")}</figcaption>
          {still.url ? (
            <div className={styles.sourceResultFrame} role="img" aria-label={t("result")} data-split-result="" style={{ aspectRatio }}>
              <div className={styles.sourceBand} data-split-band="top" style={{ height: `${rows.top}%`, ...layer("top") }} />
              <div className={styles.sourceLine} />
              <div className={styles.sourceBand} data-split-band="bottom" style={{ height: `${rows.bottom}%`, ...layer("bottom") }} />
            </div>
          ) : (
            <div className={styles.sourceResultFrame} data-split-result="" data-empty="" style={{ aspectRatio }}><span>{t("loading")}</span></div>
          )}
        </figure>
      </div>
    </>
  );
}

export default function SourceStage({ state, dispatch, frameBus, previewClient = null, readOnly = false, onBack }) {
  const t = useTranslations("editor.stage.source");
  const doc = state.doc;
  const total = state.plan?.totalFrames ?? 0;
  const frame = useSourceFrame(frameBus, total);
  const client = useStillClient(state, previewClient);
  const locked = readOnly || state.status !== "ready";
  const split = doc?.layout?.default?.mode === "split";
  return (
    <div className={styles.sourceStage} data-source-stage={split ? "split" : "frame"}>
      <div className={styles.sourceHead}>
        <p className={styles.sourceHelp}>{split ? t("helpSplit") : t("helpFrame")}</p>
        <PillButton variant="strong" onClick={onBack} data-source-back="">{t("back")}</PillButton>
      </div>
      {split
        ? <SplitSource state={state} dispatch={dispatch} frame={frame} client={client} locked={locked} />
        : <FrameSource state={state} dispatch={dispatch} frame={frame} client={client} locked={locked} />}
    </div>
  );
}
