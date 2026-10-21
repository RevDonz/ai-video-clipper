"use client";

// The caption gizmo in the Stage's gizmo slot (CONTRACTS §5.47), after LogoGizmo: drag the caption
// block up or down with a magnet on Atas, Tengah and Bawah (Alt drags freely), inside the 20–92 %
// range; arrow keys move it 0.5 % (Shift 5 %), Home and End to the ends. A drag is drawn here and
// stored once, on release, so it is one undo step; the caption's pixels follow when the plan
// returns. The Teks slider and the Caption card read the same `y_e5`, so all three stay in step.
// Props: { plan, state, dispatch, player, output, readOnly } (gizmos/index.mjs).
import { useCallback, useId, useRef, useState } from "react";

import { CAPTION_Y_RANGE } from "../panels/caption-model.mjs";
import styles from "./caption.module.css";
import {
  captionBox, captionInZone, captionReadout, captionValueText, createCaptionDrag, nudgeCommand, nudgedCaptionY, presetGuides,
} from "./caption-geometry.mjs";
import { uiZone } from "./logo-geometry.mjs";

const pct = (value, total) => `${(value * 100) / total}%`;

export default function CaptionGizmo({ state, dispatch, output: outputProp, readOnly = false }) {
  const doc = state?.doc ?? null;
  const output = outputProp ?? doc?.output ?? null;
  const captions = doc?.captions ?? null;
  const stored = captions?.overrides?.y_e5 ?? null;
  const rootRef = useRef(null);
  const boxRef = useRef(null);
  const dragRef = useRef(null);
  const [preview, setPreview] = useState(null); // { value, preset } while a drag moves
  const [keyed, setKeyed] = useState(false); // the read-out stays after a key until focus leaves
  const helpId = useId();

  const locked = readOnly || state?.status !== "ready";

  const send = useCallback((command) => {
    if (!command) return;
    try {
      dispatch(command.type, command.args, { mergeKey: command.mergeKey });
    } catch {
      // Refused by the store (the clip went read-only): nothing moves.
    }
  }, [dispatch]);

  const onPointerDown = useCallback((event) => {
    if (locked || event.button !== 0 || stored === null || !output) return;
    event.preventDefault();
    boxRef.current?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const rect = rootRef.current.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      drag: createCaptionDrag({ startY: stored, clientY: event.clientY, scale: output.h / rect.height, output }),
    };
  }, [locked, stored, output]);

  const onPointerMove = useCallback((event) => {
    const active = dragRef.current;
    if (!active || event.pointerId !== active.pointerId) return;
    const next = active.drag.move(event.clientY, { magnet: !event.altKey });
    if (next) setPreview(next);
  }, []);

  const end = useCallback((event, commit) => {
    const active = dragRef.current;
    if (!active || (event && event.pointerId !== active.pointerId)) return;
    dragRef.current = null;
    setPreview(null);
    if (commit) send(active.drag.commit());
  }, [send]);

  const onKeyDown = useCallback((event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      const active = dragRef.current;
      if (active) {
        // Cancels the drag: nothing was stored, the box goes back.
        dragRef.current = null;
        setPreview(null);
        if (boxRef.current?.hasPointerCapture?.(active.pointerId)) boxRef.current.releasePointerCapture(active.pointerId);
      } else {
        boxRef.current?.blur();
      }
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || stored === null) return;
    const next = nudgedCaptionY(stored, event.key, event.shiftKey);
    if (next === null) return;
    // The keys belong to the caption while it has focus (not to the playhead).
    event.preventDefault();
    if (locked || dragRef.current) return;
    setKeyed(true);
    if (next !== stored) send(nudgeCommand(next));
  }, [stored, locked, send]);

  if (!captions?.enabled || stored === null || !output) return null;
  const shown = preview?.value ?? stored;
  const box = captionBox({ ...captions, overrides: { ...captions.overrides, y_e5: shown } }, output);
  const zone = uiZone(output);
  const readoutAt = box.y > output.h / 10 ? { bottom: pct(output.h - box.y, output.h) } : { top: pct(box.bottom, output.h) };
  const style = { left: pct(box.x, output.w), top: pct(box.y, output.h), width: pct(box.w, output.w), height: pct(box.h, output.h) };

  return (
    <div ref={rootRef} className={styles.root} data-gizmo="caption" data-dragging={preview ? "true" : "false"}>
      {preview && (
        <>
          <div className={styles.zoneBand} style={{ top: pct(output.h - zone.bottom, output.h) }} aria-hidden="true" />
          {presetGuides(output).map((guide) => (
            <div key={guide.id} className={styles.guide} data-guide={guide.id} data-snapped={preview.preset === guide.id ? "true" : "false"}
              style={{ top: pct(guide.line, output.h) }} aria-hidden="true">
              <span className={styles.guideLabel}>{guide.label}</span>
            </div>
          ))}
        </>
      )}
      {(preview || keyed) && (
        <div className={styles.readout} data-caption-readout="" data-zone={captionInZone(shown, output) ? "true" : "false"}
          style={{ left: pct(box.x, output.w), ...readoutAt }} aria-hidden="true">
          {captionReadout(shown, output)}
        </div>
      )}
      <div
        ref={boxRef}
        className={styles.box}
        style={style}
        data-caption-box=""
        data-y-e5={shown}
        role="slider"
        aria-orientation="vertical"
        aria-label="Caption di video"
        aria-valuemin={CAPTION_Y_RANGE[0] / 1000}
        aria-valuemax={CAPTION_Y_RANGE[1] / 1000}
        aria-valuenow={shown / 1000}
        aria-valuetext={captionValueText(shown)}
        aria-describedby={helpId}
        aria-disabled={locked ? "true" : undefined}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => end(event, true)}
        onPointerCancel={(event) => end(event, false)}
        onLostPointerCapture={(event) => end(event, true)}
        onKeyDown={onKeyDown}
        onBlur={() => setKeyed(false)}
      >
        <span id={helpId} hidden>
          {locked ? "Klip ini hanya bisa dibaca."
            : "Seret ke atas atau bawah; menempel di Atas, Tengah dan Bawah, Alt untuk tanpa magnet. Panah menggeser 0,5%, Shift+panah 5%."}
        </span>
      </div>
    </div>
  );
}
