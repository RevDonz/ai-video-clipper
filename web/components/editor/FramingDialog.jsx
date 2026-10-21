"use client";

// "Atur bingkai" (CONTRACTS §5.44): the manual framing of a crop layout in one dialog. The source
// picture at the playhead with the 9:16 box (gizmos/FrameGizmo.jsx), the result beside it, a
// scrubber with the keyframes as lime diamonds, and the keyframe at the playhead: add, remove,
// "Potong" or "Geser" towards it. "Kembali ke otomatis" clears them all; "Selesai" closes.
//
// - The picture is a truth frame of `sourceFrameDoc` (framing-model.mjs), asked when the playhead
//   rests; the box and the result are drawn from the crop x the render takes (framing.mjs), so
//   they need no server round trip while dragging.
// - A drag is stored once, on release; a key on the box stores at once (merged per frame).
// - The playhead is the editor's: scrubbing here seeks the player, so closing keeps the place.
// - Ctrl+Z / Ctrl+Shift+Z undo and redo here too (the editor's keys sleep while a dialog is open).
//
// Props: { open, onClose, state, dispatch, player, frameBus, previewClient, readOnly, onUndo,
// onRedo }. Without a `previewClient` (the app) the dialog keeps its own, so its stills never
// cancel the stage's "Frame akhir".
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { framingSizes } from "../../lib/editor/framing.mjs";
import { createPreviewClient } from "../../lib/editor/preview-client.mjs";
import {
  FRAMING_MOVES, clearKeyframesCommand, framingSummary, framingView, keyframeCommand, keyframeMoveCommand,
  removeKeyframeCommand, sourceFrameDoc, stillKey,
} from "./framing-model.mjs";
import styles from "./framing.module.css";
import FrameGizmo from "./gizmos/FrameGizmo.jsx";
import { frameGeometry, resultBackground } from "./gizmos/frame-geometry.mjs";
import shell from "./shell.module.css";
import { formatClock, frameToMs, rejectionText } from "./shell-model.mjs";
import PillGroup from "./ui/PillGroup.jsx";

const STILL_REST_MS = 150; // the playhead rests this long before the picture follows it
const RATE_LIMIT_RETRIES = 2; // preview/frame allows 4 per second per session (plan §9.1)
const RATE_LIMIT_WAIT_MS = 350;

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const clampFrame = (frame, total) => Math.min(Math.max(Number.isSafeInteger(frame) ? frame : 0, 0), Math.max(total - 1, 0));
const pct = (fraction) => `${fraction * 100}%`;

function useLatest(value) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/** The dialog's own preview client (or `previewClient`), so its stills never cancel the stage's. */
export function useStillClient(state, previewClient) {
  const own = useRef(null);
  const ids = useLatest({ jobId: state.jobId, clipId: state.clipId });
  useEffect(() => () => {
    own.current?.destroy?.();
    own.current = null;
  }, []);
  return useCallback(() => {
    if (previewClient) return previewClient;
    if (!own.current) {
      try {
        own.current = createPreviewClient({ ...ids.current });
      } catch {
        return null;
      }
    }
    return own.current;
  }, [previewClient, ids]);
}

/**
 * The source picture at `frame`: `{url, state}` with state "loading", "ready" or "failed". "Atur
 * layar terbagi" (SplitDialog.jsx) draws on the same still.
 */
export function useStill({ client, doc, frame }) {
  const [still, setStill] = useState({ url: null, state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const urlRef = useRef(null);
  const docRef = useLatest(doc);
  const key = stillKey(doc);

  useEffect(() => () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  }, []);

  useEffect(() => {
    if (!docRef.current) return undefined;
    let alive = true;
    setStill((previous) => ({ ...previous, state: "loading" }));
    const timer = setTimeout(async () => {
      const api = client();
      if (!api || typeof api.frame !== "function") {
        if (alive) setStill((previous) => ({ ...previous, state: "failed" }));
        return;
      }
      try {
        let blob = null;
        for (let tries = 0; ; tries += 1) {
          try {
            blob = await api.frame(sourceFrameDoc(docRef.current), frame);
            break;
          } catch (error) {
            if (error?.code !== "rate_limited" || tries >= RATE_LIMIT_RETRIES) throw error;
            await wait(RATE_LIMIT_WAIT_MS);
            if (!alive) return;
          }
        }
        if (!alive) return;
        const url = URL.createObjectURL(blob);
        const old = urlRef.current;
        urlRef.current = url;
        if (old) setTimeout(() => URL.revokeObjectURL(old), 1000); // once the new picture has taken over
        setStill({ url, state: "ready" });
      } catch (error) {
        if (!alive || error?.name === "AbortError") return;
        setStill((previous) => ({ ...previous, state: "failed" }));
      }
    }, STILL_REST_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [key, frame, attempt, client, docRef]);

  return { still, retry: () => setAttempt((count) => count + 1) };
}

function FramingBody({ state, dispatch, player, frameBus, client, readOnly, onClose, boxRef }) {
  const doc = state.doc;
  const plan = state.plan;
  const total = plan?.totalFrames ?? 0;
  const fps = plan?.fps ?? doc.output.fps;
  const [frame, setFrame] = useState(() => clampFrame(frameBus?.get?.() ?? 0, total));
  const [draft, setDraft] = useState(null);
  const [message, setMessage] = useState(null);
  const locked = readOnly || state.status !== "ready";
  const { source, output } = framingSizes(doc);
  const sizeKey = `${source.join("x")}:${output.join("x")}`;
  const geometry = useMemo(() => frameGeometry(source, output), [sizeKey]); // the sizes, not the arrays
  const summary = framingSummary(doc);
  const view = framingView({ doc, plan, frame, draft });
  const { still, retry } = useStill({ client, doc, frame });
  const uid = useId();

  useEffect(() => { setFrame((current) => clampFrame(current, total)); }, [total]);

  const send = (command) => {
    try {
      dispatch(command.type, command.args, { mergeKey: command.mergeKey });
      setMessage(null);
    } catch (error) {
      setMessage(rejectionText(error));
    }
  };
  const seek = (target) => {
    if (target === null) return;
    const next = clampFrame(target, total);
    setFrame(next);
    player?.seek?.(next);
  };
  const commit = (pan) => {
    if (view.sf !== null && !locked) send(keyframeCommand(view.sf, pan));
  };

  const time = (f) => formatClock(frameToMs(f, fps));
  const status = view.index >= 0 ? `${summary.text} Keyframe ${view.index + 1} dari ${view.count} ada di sini.` : summary.text;
  const result = resultBackground(view.crop ?? 0, geometry);
  const [w, h] = source;

  if (!summary.available) {
    return (
      <div className={shell.dialogBody}>
        <p className={styles.status}>{summary.text}</p>
      </div>
    );
  }

  return (
    <>
      <div className={`${shell.dialogBody} ${styles.body}`}>
        {message ? <p className={styles.message} role="alert">{message}</p> : null}
        <p className={styles.status} id={`${uid}-status`} aria-live="polite">{status}</p>
        <div className={styles.stage}>
          <div className={styles.pictureSlot} style={{ maxWidth: `calc((100vh - 420px) * ${w} / ${h})` }}>
            <FrameGizmo geometry={geometry} crop={view.crop} pan={view.pan} auto={view.auto && draft === null} locked={locked}
              stillUrl={still.url} stillState={still.state} onDrag={setDraft} onCommit={commit} onRetry={retry} boxRef={boxRef} />
          </div>
          <figure className={styles.result}>
            <figcaption className={styles.resultLabel}>Hasil</figcaption>
            {view.resultKnown && still.url ? (
              <div className={styles.resultFrame} role="img" aria-label={`Hasil 9:16 di ${time(frame)}`} data-framing-result=""
                style={{ backgroundImage: `url("${still.url}")`, backgroundSize: result.size, backgroundPosition: result.position }} />
            ) : (
              <div className={styles.resultFrame} data-framing-result="" data-empty="">
                <span>{view.resultKnown ? "Memuat gambar…" : "Mengikuti wajah"}</span>
              </div>
            )}
          </figure>
        </div>

        <div className={styles.transport}>
          <button type="button" className={shell.button} aria-label="Frame sebelumnya" onClick={() => seek(frame - 1)} disabled={frame <= 0}>‹</button>
          <span className={styles.time} data-framing-time="">{`${time(frame)} / ${time(total)}`}</span>
          <button type="button" className={shell.button} aria-label="Frame berikutnya" onClick={() => seek(frame + 1)} disabled={frame >= total - 1}>›</button>
          <div className={styles.scrub}>
            <div className={styles.marks} aria-hidden="true">
              {view.marks.map((mark) => (
                <span key={mark.sf} className={styles.mark} data-keyframe-mark={mark.f} data-here={mark.f === frame ? "true" : undefined}
                  style={{ left: pct(total > 1 ? mark.f / (total - 1) : 0) }} />
              ))}
            </div>
            <input type="range" className={styles.range} min={0} max={Math.max(total - 1, 0)} step={1} value={frame}
              aria-label="Posisi" aria-valuetext={time(frame)} onChange={(event) => seek(Number(event.target.value))} />
          </div>
        </div>

        <div className={styles.keys}>
          <div className={styles.keyNav}>
            <button type="button" className={shell.button} aria-label="Keyframe sebelumnya" onClick={() => seek(view.previous)}
              disabled={view.previous === null}>‹ Keyframe</button>
            <button type="button" className={shell.button} aria-label="Keyframe berikutnya" onClick={() => seek(view.next)}
              disabled={view.next === null}>Keyframe ›</button>
          </div>
          <div className={styles.keyEdit}>
            <button type="button" className={shell.button} onClick={() => commit(view.pan)}
              disabled={locked || view.sf === null || view.index >= 0}>Tambah keyframe</button>
            <button type="button" className={shell.button} onClick={() => send(removeKeyframeCommand(view.sf))}
              disabled={locked || view.index < 0}>Hapus keyframe</button>
          </div>
          <PillGroup legend="Ke keyframe ini" name={`${uid}-move`} options={FRAMING_MOVES} value={view.move}
            disabled={locked || !view.moveEditable} describedBy={`${uid}-move-note`}
            onChange={(move) => send(keyframeMoveCommand(view.sf, move))} />
          <p className={styles.note} id={`${uid}-move-note`}>
            {view.moveEditable ? "Potong pindah tepat di keyframe; Geser bergerak pelan dari keyframe sebelumnya."
              : "Pilih keyframe kedua atau sesudahnya untuk mengatur perpindahannya."}
          </p>
        </div>
      </div>
      <div className={`${shell.dialogFooter} ${styles.footer}`}>
        <button type="button" className={`${shell.button} ${shell.quiet}`} onClick={() => send(clearKeyframesCommand())}
          disabled={locked || view.auto}>Kembali ke otomatis</button>
        <button type="button" className={`${shell.button} ${shell.primary}`} onClick={onClose}>Selesai</button>
      </div>
    </>
  );
}

export default function FramingDialog({
  open, onClose, state, dispatch, player = null, frameBus = null, previewClient = null, readOnly = false,
  onUndo = null, onRedo = null,
}) {
  const dialogRef = useRef(null);
  const boxRef = useRef(null);
  const titleId = useId();
  const client = useStillClient(state, previewClient);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      requestAnimationFrame(() => boxRef.current?.focus({ preventScroll: true }));
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
    <dialog ref={dialogRef} className={styles.dialog} aria-labelledby={titleId} data-framing-dialog=""
      onCancel={(event) => { event.preventDefault(); onClose(); }} onKeyDown={onKeyDown}>
      {open && state?.doc ? (
        <>
          <div className={shell.dialogHeader}>
            <h2 id={titleId}>Atur bingkai</h2>
            <button type="button" className={`${shell.button} ${shell.quiet}`} onClick={onClose}>Tutup</button>
          </div>
          <FramingBody state={state} dispatch={dispatch} player={player} frameBus={frameBus} client={client}
            readOnly={readOnly} onClose={onClose} boxRef={boxRef} />
        </>
      ) : null}
    </dialog>
  );
}
