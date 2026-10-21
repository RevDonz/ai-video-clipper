"use client";

// "Atur layar terbagi" (CONTRACTS §5.45): the two crops of the split layout in one dialog. The
// source picture at the playhead with a box per band (gizmos/SplitGizmo.jsx), the 9:16 result
// beside it with the 1 px line, a scrubber to pick a telling frame, the band being edited ("Atas" or
// "Bawah") with its zoom, the share ("30/70", "50/50") and "Tukar atas dan bawah". "Selesai"
// closes.
//
// - The picture is the latar blur truth frame of FramingDialog's `useStill`; the boxes and the
//   result are drawn from the render's own crops (web/lib/editor/split.mjs), so they need no
//   server round trip while dragging.
// - A drag or a zoom is drawn from a draft and stored once, on release; a key on a box stores at
//   once (merged per band).
// - The playhead is the editor's: scrubbing here seeks the player, so closing keeps the place.
// - Ctrl+Z / Ctrl+Shift+Z undo and redo here too (the editor's keys sleep while a dialog is open).
//
// Props: { open, onClose, state, dispatch, player, frameBus, previewClient, readOnly, onUndo,
// onRedo }, as FramingDialog's.
import { useEffect, useId, useRef, useState } from "react";

import { useStill, useStillClient } from "./FramingDialog.jsx";
import SplitGizmo from "./gizmos/SplitGizmo.jsx";
import { bandBackground, resultRows } from "./gizmos/split-geometry.mjs";
import shell from "./shell.module.css";
import { formatClock, frameToMs, rejectionText } from "./shell-model.mjs";
import styles from "./split-dialog.module.css";
import {
  BAND_OPTIONS, SPLIT_RATIOS, splitCropCommand, splitRatioCommand, splitSummary, splitView, swapSplitCommand, zoomPercent,
} from "./split-model.mjs";
import PillGroup from "./ui/PillGroup.jsx";

const clampFrame = (frame, total) => Math.min(Math.max(Number.isSafeInteger(frame) ? frame : 0, 0), Math.max(total - 1, 0));
const NAMES = Object.freeze({ top: "atas", bottom: "bawah" });

function SplitBody({ state, dispatch, player, frameBus, client, readOnly, active, setActive, boxRefs }) {
  const doc = state.doc;
  const plan = state.plan;
  const total = plan?.totalFrames ?? 0;
  const fps = plan?.fps ?? doc.output.fps;
  const [frame, setFrame] = useState(() => clampFrame(frameBus?.get?.() ?? 0, total));
  const [draft, setDraftState] = useState(null);
  const draftRef = useRef(null); // the latest draft, for the release that stores it
  const setDraft = (next) => {
    draftRef.current = next;
    setDraftState(next);
  };
  const [message, setMessage] = useState(null);
  const locked = readOnly || state.status !== "ready";
  const view = splitView({ doc, draft });
  const summary = splitSummary(doc);
  const { still, retry } = useStill({ client, doc, frame });
  const uid = useId();

  useEffect(() => { setFrame((current) => clampFrame(current, total)); }, [total]);

  if (!view) {
    return (
      <div className={shell.dialogBody}>
        <p className={styles.status}>Pilih Layar terbagi di Tata letak untuk mengatur potongannya.</p>
      </div>
    );
  }

  const send = (command) => {
    try {
      dispatch(command.type, command.args, { mergeKey: command.mergeKey });
      setMessage(null);
    } catch (error) {
      setMessage(rejectionText(error));
    }
  };
  const commit = (band, crop) => {
    if (!locked) send(splitCropCommand(band, crop));
  };
  const seek = (target) => {
    const next = clampFrame(target, total);
    setFrame(next);
    player?.seek?.(next);
  };
  // the zoom slider is drawn from a draft and stored when it is let go (pointer or key)
  const crop = view.split[active];
  const zoomTo = (value) => setDraft({ band: active, crop: { ...doc.layout.split[active], zoom_pm: value } });
  const settleZoom = () => {
    const pending = draftRef.current;
    if (!pending) return;
    commit(pending.band, pending.crop);
    setDraft(null);
  };
  const swap = () => {
    send(swapSplitCommand());
    setActive(active === "top" ? "bottom" : "top"); // the selection follows its picture
  };

  const time = (f) => formatClock(frameToMs(f, fps));
  const rows = resultRows(view.geometry, view.output);
  const layer = (band) => {
    const { size, position } = bandBackground(view.geometry, band, view.source, view.output);
    return { backgroundImage: `url("${still.url}")`, backgroundSize: size, backgroundPosition: position };
  };
  const [w, h] = view.source;

  return (
    <>
      <div className={`${shell.dialogBody} ${styles.body}`}>
        {message ? <p className={styles.message} role="alert">{message}</p> : null}
        <p className={styles.status} aria-live="polite">
          {`${summary.text} Mengatur potongan ${NAMES[active]}, ${zoomPercent(crop.zoom_pm)}%.`}
        </p>
        <div className={styles.stage}>
          <div className={styles.pictureSlot} style={{ maxWidth: `calc((100vh - 440px) * ${w} / ${h})` }}>
            <SplitGizmo view={view} active={active} locked={locked} stillUrl={still.url} stillState={still.state}
              onSelect={setActive} onDraft={setDraft} onCommit={commit} onRetry={retry} boxRefs={boxRefs} />
          </div>
          <figure className={styles.result}>
            <figcaption className={styles.resultLabel}>Hasil</figcaption>
            {still.url ? (
              <div className={styles.resultFrame} role="img" data-split-result=""
                aria-label={`Hasil 9:16 di ${time(frame)}: atas ${summary.top}%, bawah ${summary.bottom}%`}>
                <div className={styles.resultBand} data-split-band="top" style={{ height: `${rows.top}%`, ...layer("top") }} />
                <div className={styles.resultLine} />
                <div className={styles.resultBand} data-split-band="bottom" style={{ height: `${rows.bottom}%`, ...layer("bottom") }} />
              </div>
            ) : (
              <div className={styles.resultFrame} data-split-result="" data-empty="">
                <span>Memuat gambar…</span>
              </div>
            )}
          </figure>
        </div>

        <div className={styles.transport}>
          <button type="button" className={shell.button} aria-label="Frame sebelumnya" onClick={() => seek(frame - 1)} disabled={frame <= 0}>‹</button>
          <span className={styles.time} data-split-time="">{`${time(frame)} / ${time(total)}`}</span>
          <button type="button" className={shell.button} aria-label="Frame berikutnya" onClick={() => seek(frame + 1)} disabled={frame >= total - 1}>›</button>
          <input type="range" className={styles.range} min={0} max={Math.max(total - 1, 0)} step={1} value={frame}
            aria-label="Posisi" aria-valuetext={time(frame)} onChange={(event) => seek(Number(event.target.value))} />
        </div>

        <div className={styles.controls}>
          <PillGroup legend="Potongan" name={`${uid}-band`} options={BAND_OPTIONS} value={active}
            onChange={(band) => { settleZoom(); setActive(band); }} />
          <div className={styles.zoom}>
            <span className={styles.zoomLabel} id={`${uid}-zoom`}>{`Perbesar ${NAMES[active]}`}</span>
            <input type="range" className={styles.range} min={1000} max={5000} step={10} value={crop.zoom_pm} disabled={locked}
              aria-labelledby={`${uid}-zoom`} aria-valuetext={`${zoomPercent(crop.zoom_pm)}%`} data-split-zoom={active}
              onChange={(event) => zoomTo(Number(event.target.value))} onPointerUp={settleZoom} onKeyUp={settleZoom} onBlur={settleZoom} />
            <output className={styles.zoomValue} aria-hidden="true">{`${zoomPercent(crop.zoom_pm)}%`}</output>
          </div>
          <PillGroup legend="Pembagian" name={`${uid}-ratio`} options={SPLIT_RATIOS} value={summary.ratio} disabled={locked}
            onChange={(ratio) => send(splitRatioCommand(ratio, doc.layout.split))} />
          <button type="button" className={shell.button} onClick={swap} disabled={locked}>Tukar atas dan bawah</button>
        </div>
      </div>
    </>
  );
}

export default function SplitDialog({
  open, onClose, state, dispatch, player = null, frameBus = null, previewClient = null, readOnly = false,
  onUndo = null, onRedo = null,
}) {
  const dialogRef = useRef(null);
  const boxRefs = useRef({});
  const titleId = useId();
  const client = useStillClient(state, previewClient);
  // the small band first: the one a facecam usually takes
  const [active, setActive] = useState("top");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      const split = state?.doc?.layout?.split;
      const first = split?.top_pm === 700 ? "bottom" : "top";
      setActive(first);
      dialog.showModal();
      requestAnimationFrame(() => boxRefs.current[first]?.focus({ preventScroll: true }));
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const onKeyDown = (event) => {
    const key = event.key.toLowerCase();
    if (!(event.ctrlKey || event.metaKey) || event.altKey || (key !== "z" && key !== "y")) return;
    event.preventDefault();
    if (key === "y" || event.shiftKey) onRedo?.();
    else onUndo?.();
  };

  return (
    <dialog ref={dialogRef} className={styles.dialog} aria-labelledby={titleId} data-split-dialog=""
      onCancel={(event) => { event.preventDefault(); onClose(); }} onKeyDown={onKeyDown}>
      {open && state?.doc ? (
        <>
          <div className={shell.dialogHeader}>
            <h2 id={titleId}>Atur layar terbagi</h2>
            <button type="button" className={`${shell.button} ${shell.quiet}`} onClick={onClose}>Tutup</button>
          </div>
          <SplitBody state={state} dispatch={dispatch} player={player} frameBus={frameBus} client={client}
            readOnly={readOnly} active={active} setActive={setActive} boxRefs={boxRefs} />
          <div className={`${shell.dialogFooter} ${styles.footer}`}>
            <button type="button" className={`${shell.button} ${shell.primary}`} onClick={onClose}>Selesai</button>
          </div>
        </>
      ) : null}
    </dialog>
  );
}
