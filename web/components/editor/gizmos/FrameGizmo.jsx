"use client";

// The "Atur bingkai" gizmo (CONTRACTS §5.44): the 9:16 box over the source picture, with a grid of
// thirds, in the framing dialog (FramingDialog.jsx). Follows LogoGizmo's patterns: drag to
// move with a magnet on the centre (Alt drags freely), arrow keys to nudge (1 %, Shift 10 %,
// Home/End to the edges), a press outside the box brings its middle there.
//
// A drag is drawn locally (`onDrag(pan)`, then `onDrag(null)`) and stored once, on release
// (`onCommit(pan)`): every stored keyframe asks the preview lane for a new plate, so a drag must
// not. A key stores at once; the store merges the keys at one frame into one undo step.
// Props: { geometry, crop, pan, auto, locked, stillUrl, stillState, onDrag, onCommit, onRetry,
// boxRef }.
import { useCallback, useId, useRef, useState } from "react";

import { SNAP_SCREEN_PX, boxRect, grabOffset, nudgedPan, panAtPointer } from "./frame-geometry.mjs";
import styles from "./frame.module.css";

const DRAG_START_SCREEN_PX = 3; // a click that moves less than this places the box without a drag
const pct = (fraction) => `${fraction * 100}%`;

export default function FrameGizmo({
  geometry, crop, pan, auto = false, locked = false, stillUrl = null, stillState = "loading",
  onDrag, onCommit, onRetry, boxRef = null,
}) {
  const rootRef = useRef(null);
  const dragRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [snapped, setSnapped] = useState(false);
  const helpId = useId();

  const pointerAt = useCallback((event) => {
    const rect = rootRef.current.getBoundingClientRect();
    return { pointer: (event.clientX - rect.left) / rect.width, width: rect.width };
  }, []);

  const panFor = useCallback((event, active) => {
    const { pointer, width } = pointerAt(event);
    return panAtPointer({ pointer, grab: active.grab, geometry, reach: event.altKey ? 0 : SNAP_SCREEN_PX / width });
  }, [geometry, pointerAt]);

  const onPointerDown = useCallback((event) => {
    if (locked || event.button !== 0 || crop === null) return;
    event.preventDefault();
    boxRef?.current?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const { pointer } = pointerAt(event);
    const left = crop / geometry.scaledW;
    const inside = pointer >= left && pointer <= left + geometry.boxWidth;
    const active = { pointerId: event.pointerId, grab: grabOffset(pointer, crop, geometry), clientX: event.clientX,
      moved: false, pan: null };
    dragRef.current = active;
    // a press outside the box brings its middle there at once
    if (!inside) {
      active.moved = true;
      active.pan = panFor(event, active).pan;
      onDrag?.(active.pan);
      setDragging(true);
    }
  }, [locked, crop, geometry, pointerAt, panFor, onDrag, boxRef]);

  const onPointerMove = useCallback((event) => {
    const active = dragRef.current;
    if (!active || event.pointerId !== active.pointerId) return;
    if (!active.moved && Math.abs(event.clientX - active.clientX) < DRAG_START_SCREEN_PX) return;
    active.moved = true;
    const next = panFor(event, active);
    active.pan = next.pan;
    setDragging(true);
    setSnapped(next.snapped);
    onDrag?.(next.pan);
  }, [panFor, onDrag]);

  const end = useCallback((event, commit) => {
    const active = dragRef.current;
    if (!active || (event && event.pointerId !== active.pointerId)) return;
    dragRef.current = null;
    setDragging(false);
    setSnapped(false);
    if (commit && active.moved && active.pan !== null) onCommit?.(active.pan);
    onDrag?.(null);
  }, [onCommit, onDrag]);

  const onKeyDown = useCallback((event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const next = nudgedPan(pan, event.key, event.shiftKey);
    if (next === null) return;
    // the arrows belong to the box while it has focus, not to the dialog's playhead
    event.preventDefault();
    event.stopPropagation();
    if (!locked && next !== pan) onCommit?.(next);
  }, [pan, locked, onCommit]);

  const rect = crop === null ? null : boxRect(crop, geometry);
  const percent = Math.round(pan / 1000);
  const [w, h] = geometry.source;
  return (
    <div ref={rootRef} className={styles.picture} data-gizmo="frame" data-dragging={dragging ? "true" : "false"}
      data-still={stillState} style={{ aspectRatio: `${w} / ${h}`, backgroundImage: stillUrl ? `url("${stillUrl}")` : undefined }}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={(event) => end(event, true)}
      onPointerCancel={(event) => end(event, false)} onLostPointerCapture={(event) => end(event, true)}>
      {stillState === "loading" && !stillUrl ? <span className={styles.pictureNote} role="status">Memuat gambar…</span> : null}
      {stillState === "failed" ? (
        <span className={styles.pictureNote} role="alert">
          Gambar belum bisa dimuat.
          <button type="button" className={styles.retry} onPointerDown={(event) => event.stopPropagation()} onClick={onRetry}>Coba lagi</button>
        </span>
      ) : null}
      {snapped ? <span className={styles.centreGuide} data-guide="centre" aria-hidden="true" /> : null}
      {rect ? (
        <div
          ref={boxRef}
          className={styles.box}
          data-frame-box=""
          data-auto={auto ? "true" : "false"}
          style={{ left: pct(rect.left), width: pct(rect.width), top: pct(rect.top), height: pct(rect.height) }}
          role="slider"
          tabIndex={0}
          aria-label="Bingkai 9:16"
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={`${percent}% dari kiri${auto ? ", otomatis" : ""}`}
          aria-describedby={helpId}
          aria-disabled={locked ? "true" : undefined}
          onKeyDown={onKeyDown}
        >
          <span className={styles.grid} aria-hidden="true" />
          {auto ? <span className={styles.tag} aria-hidden="true">Otomatis</span> : null}
          <span id={helpId} hidden>
            {locked ? "Klip ini hanya bisa dibaca."
              : "Seret untuk memindahkan, Alt untuk tanpa magnet. Panah menggeser 1%, Shift+panah 10%."}
          </span>
        </div>
      ) : null}
    </div>
  );
}
