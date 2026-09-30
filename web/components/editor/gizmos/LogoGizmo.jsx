"use client";

// The logo gizmo in the Stage's gizmo slot (plan §11.3 T3.2, §3.3, Appendix B): drag to move with
// a magnet on the corner margins, the TikTok zone's edges and the centre lines (Alt drags freely),
// four aspect-locked corner handles that keep the opposite corner, and arrow-key nudges (1 px,
// Shift 10 px). Everything goes through MoveLogo and ResizeLogo in an order that never leaves the
// frame, so item_out_of_frame cannot happen. A drag is one undo step (one mergeKey).
//
// The outline follows the document at once; the logo's pixels on the canvas come from the server
// (plan §5.5) and follow when the plan returns, while the badge says "Memperbarui logo…". No
// pixel is guessed here: the gizmo draws only its outline, handles and guides.
// Props: { plan, state, dispatch, player, output, readOnly } (gizmos/index.mjs).
import { useCallback, useEffect, useId, useRef, useState } from "react";

import styles from "./gizmos.module.css";
import {
  CORNERS, boxOf, handleResize, logoOf, nudged, positionFor, snapDrag, transformSteps, uiZone, zoneHits,
} from "./logo-geometry.mjs";

const SNAP_SCREEN_PX = 8; // the magnet's reach on screen, whatever the stage's scale
const DRAG_START_SCREEN_PX = 3; // a click that moves less than this only selects the logo
const pct = (value, total) => `${(value * 100) / total}%`;

// A move shows where the box starts, a resize its size (output pixels).
function readoutText(box, kind, unsafe) {
  const text = kind === "resize" ? `${box.w} × ${box.h} px` : `${box.x}, ${box.y} px`;
  return unsafe ? `${text} · area tombol TikTok` : text;
}

// Beside the box on the side with room (the stage clips anything outside it): aligned to the edge
// nearer the stage's middle, above the box unless the box is near the top.
function readoutStyle(box, output) {
  const style = {};
  if (box.x + box.w / 2 > output.w / 2) style.right = pct(output.w - box.x - box.w, output.w);
  else style.left = pct(box.x, output.w);
  if (box.y < output.h / 10) style.top = pct(box.y + box.h, output.h);
  else style.bottom = pct(output.h - box.y, output.h);
  return style;
}

export default function LogoGizmo({ state, dispatch, output: outputProp, readOnly = false }) {
  const doc = state?.doc ?? null;
  const output = outputProp ?? doc?.output ?? null;
  const logo = doc && output ? logoOf(doc) : null;
  const rootRef = useRef(null);
  const boxRef = useRef(null);
  const docRef = useRef(doc);
  const dragRef = useRef(null);
  const [drag, setDrag] = useState(null);
  const helpId = useId();
  docRef.current = doc;

  const locked = readOnly || state?.status !== "ready";
  const box = logo ? boxOf(logo.transform, logo.meta, output) : null;

  const run = useCallback((steps, mergeKey) => {
    for (const step of steps) {
      const next = dispatch(step.type, step.args, { mergeKey });
      if (next && typeof next === "object") docRef.current = next;
    }
  }, [dispatch]);

  const current = useCallback(() => {
    const found = logoOf(docRef.current);
    return found ? { ...found, box: boxOf(found.transform, found.meta, output) } : null;
  }, [output]);

  const toOutput = useCallback((event) => {
    const rect = rootRef.current.getBoundingClientRect();
    const scale = output.w / rect.width;
    return { x: (event.clientX - rect.left) * scale, y: (event.clientY - rect.top) * scale, scale };
  }, [output]);

  const onPointerDown = useCallback((event) => {
    if (locked || event.button !== 0 || !logo) return;
    const handle = event.target?.closest?.("[data-logo-handle]")?.dataset.logoHandle ?? null;
    const found = current();
    if (!found) return;
    event.preventDefault();
    boxRef.current?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const point = toOutput(event);
    dragRef.current = {
      kind: handle ? "resize" : "move", handle, pointerId: event.pointerId, start: point, startBox: found.box,
      clientX: event.clientX, clientY: event.clientY, moved: Boolean(handle), snapX: null, snapY: null,
    };
    if (handle) setDrag({ kind: "resize", snapX: null, snapY: null });
  }, [locked, logo, current, toOutput]);

  const onPointerMove = useCallback((event) => {
    const active = dragRef.current;
    if (!active || event.pointerId !== active.pointerId) return;
    if (!active.moved) {
      if (Math.hypot(event.clientX - active.clientX, event.clientY - active.clientY) < DRAG_START_SCREEN_PX) return;
      active.moved = true;
    }
    const found = current();
    if (!found) return;
    const point = toOutput(event);
    try {
      if (active.kind === "move") {
        const target = snapDrag({ x: active.startBox.x + point.x - active.start.x, y: active.startBox.y + point.y - active.start.y },
          found.box, output, { threshold: SNAP_SCREEN_PX * point.scale, magnet: !event.altKey });
        setDrag({ kind: "move", snapX: target.snapX, snapY: target.snapY });
        if (target.x !== found.box.x || target.y !== found.box.y) {
          run([{ type: "MoveLogo", args: positionFor(target.x, target.y, found.box, output) }], "logo:move");
        }
      } else {
        setDrag({ kind: "resize", snapX: null, snapY: null });
        // The dragged corner follows the pointer's movement, not the pointer itself: the handle's
        // hit area sits outside the corner, so grabbing it must not make the logo jump.
        const { startBox, handle } = active;
        const corner = { x: handle.endsWith("right") ? startBox.x + startBox.w : startBox.x,
          y: handle.startsWith("bottom") ? startBox.y + startBox.h : startBox.y };
        const target = handleResize(startBox, found.meta, output, handle,
          { x: corner.x + point.x - active.start.x, y: corner.y + point.y - active.start.y });
        const steps = target ? transformSteps(found.transform, found.meta, output, target) : null;
        if (steps?.length) run(steps, "logo:size");
      }
    } catch {
      // A command refused by the store (never expected: every step is checked against the frame).
    }
  }, [current, toOutput, output, run]);

  const endDrag = useCallback((event) => {
    const active = dragRef.current;
    if (!active || (event && event.pointerId !== active.pointerId)) return;
    dragRef.current = null;
    setDrag(null);
  }, []);

  const onKeyDown = useCallback((event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      boxRef.current?.blur();
      return;
    }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const direction = arrows[event.key];
    if (!direction || event.ctrlKey || event.metaKey || event.altKey) return;
    // The arrows belong to the logo while it has focus (not to the playhead).
    event.preventDefault();
    if (locked) return;
    const found = current();
    if (!found) return;
    const step = event.shiftKey ? 10 : 1;
    const next = nudged(found.box, output, direction[0] * step, direction[1] * step);
    if (!next) return;
    try {
      run([{ type: "MoveLogo", args: positionFor(next.x, next.y, found.box, output) }], "logo:move");
    } catch {
      // Refused by the store: nothing moves.
    }
  }, [locked, current, output, run]);

  useEffect(() => () => { dragRef.current = null; }, []);

  if (!logo || !box) return null;
  const hits = zoneHits(box, output);
  const zone = uiZone(output);
  const shown = drag ? [
    drag.snapX && { guide: drag.snapX, vertical: true },
    drag.snapY && { guide: drag.snapY, vertical: false },
  ].filter(Boolean) : [];
  const style = { left: pct(box.x, output.w), top: pct(box.y, output.h), width: pct(box.w, output.w), height: pct(box.h, output.h) };
  const label = `Logo di video: ${box.x}, ${box.y} px, lebar ${box.w} px${hits.any ? ", di area tombol TikTok" : ""}`;

  return (
    <div ref={rootRef} className={styles.root} data-gizmo="logo" data-dragging={drag ? "true" : "false"}>
      {drag && (
        <>
          <div className={styles.zoneBand} style={{ left: 0, top: 0, width: "100%", height: pct(zone.top, output.h) }} aria-hidden="true" />
          <div className={styles.zoneBand} style={{ left: 0, bottom: 0, width: "100%", height: pct(zone.bottom, output.h) }} aria-hidden="true" />
          <div className={styles.zoneBand} style={{ right: 0, top: pct(zone.top, output.h), width: pct(zone.right, output.w),
            height: pct(output.h - zone.top - zone.bottom, output.h) }} aria-hidden="true" />
          <div className={`${styles.guide} ${styles.guideY}`} data-guide-kind="zone" style={{ top: pct(zone.top, output.h) }} aria-hidden="true" />
          <div className={`${styles.guide} ${styles.guideY}`} data-guide-kind="zone" style={{ top: pct(output.h - zone.bottom, output.h) }} aria-hidden="true" />
          <div className={`${styles.guide} ${styles.guideX}`} data-guide-kind="zone" style={{ left: pct(output.w - zone.right, output.w) }} aria-hidden="true" />
          {shown.map(({ guide, vertical }) => (
            <div
              key={`${vertical ? "x" : "y"}-${guide.id}`}
              className={`${styles.guide} ${vertical ? styles.guideX : styles.guideY}`}
              data-guide={guide.id}
              data-guide-kind={guide.kind}
              style={vertical ? { left: pct(guide.line, output.w) } : { top: pct(guide.line, output.h) }}
              aria-hidden="true"
            />
          ))}
          <div className={styles.readout} data-unsafe={hits.any ? "true" : "false"} aria-hidden="true" style={readoutStyle(box, output)}>
            {readoutText(box, drag.kind, hits.any)}
          </div>
        </>
      )}
      <div
        ref={boxRef}
        className={styles.box}
        style={style}
        data-logo-box=""
        data-unsafe={hits.any ? "true" : "false"}
        role="group"
        aria-roledescription="kotak logo"
        aria-label={label}
        aria-describedby={helpId}
        aria-disabled={locked ? "true" : undefined}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onKeyDown={onKeyDown}
      >
        <span id={helpId} hidden>
          {locked ? "Klip ini hanya bisa dibaca." : "Seret untuk memindahkan, Alt untuk tanpa magnet. Panah menggeser 1 px, Shift+panah 10 px."}
        </span>
        {!locked && CORNERS.map((corner) => (
          <div key={corner} className={styles.handle} data-logo-handle={corner} aria-hidden="true" />
        ))}
      </div>
    </div>
  );
}
