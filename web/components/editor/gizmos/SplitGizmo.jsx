"use client";

// The "Atur layar terbagi" gizmo (CONTRACTS §5.45): one box per band over the source picture, in
// the dialog (SplitDialog.jsx). Follows FrameGizmo's patterns: a drag moves a box, a corner resizes
// it around the opposite corner (the box keeps its band's shape), arrow keys move it (1 %, Shift
// 10 %) and + / − zoom it.
//
// A drag is drawn locally (`onDraft({band, crop})`, then `onDraft(null)`) and stored once, on
// release (`onCommit(band, crop)`): every stored crop asks the preview lane for a new plate, so a
// drag must not. A key stores at once; the store merges one band's steps into one undo step. The
// active box is drawn on top; the other is reached with Tab or the dialog's "Potongan" choice.
// Props: { view, active, locked, stillUrl, stillState, onSelect, onDraft, onCommit, onRetry, boxRefs }.
import { useCallback, useId, useRef, useState } from "react";

import { SPLIT_BANDS } from "../../../lib/editor/doc-model.mjs";
import frame from "./frame.module.css";
import { bandBox, cropForCorner, cropForPlace, nudgedCrop } from "./split-geometry.mjs";
import styles from "./split.module.css";

const DRAG_START_SCREEN_PX = 3; // a click that moves less than this only picks the box
const CORNERS = Object.freeze(["nw", "ne", "sw", "se"]);
const NAMES = Object.freeze({ top: "Atas", bottom: "Bawah" });
const pct = (fraction) => `${fraction * 100}%`;

export default function SplitGizmo({
  view, active, locked = false, stillUrl = null, stillState = "loading", onSelect, onDraft, onCommit, onRetry,
  boxRefs = null,
}) {
  const rootRef = useRef(null);
  const dragRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const helpId = useId();
  const { split, geometry, source } = view;

  const pointerAt = useCallback((event) => {
    const rect = rootRef.current.getBoundingClientRect();
    return { x: ((event.clientX - rect.left) / rect.width) * source[0], y: ((event.clientY - rect.top) / rect.height) * source[1] };
  }, [source]);

  const begin = (event, band, kind) => {
    if (locked || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect?.(band);
    boxRefs?.current?.[band]?.focus({ preventScroll: true });
    rootRef.current.setPointerCapture?.(event.pointerId);
    const [x, y, w, h] = geometry[band].crop;
    dragRef.current = {
      pointerId: event.pointerId, band, kind, start: pointerAt(event), origin: { x, y },
      anchor: { x: kind.includes("w") ? x + w : x, y: kind.includes("n") ? y + h : y },
      crop: split[band], size: geometry[band].size, clientX: event.clientX, clientY: event.clientY, moved: false, draft: null,
    };
  };

  const onPointerMove = (event) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.clientX, event.clientY - drag.clientY) < DRAG_START_SCREEN_PX) return;
    drag.moved = true;
    setDragging(true);
    const pointer = pointerAt(event);
    drag.draft = drag.kind === "move"
      ? cropForPlace({ crop: drag.crop, left: drag.origin.x + pointer.x - drag.start.x, top: drag.origin.y + pointer.y - drag.start.y,
        source, band: drag.size })
      : cropForCorner({ corner: drag.kind, anchor: drag.anchor, pointer, crop: drag.crop, source, band: drag.size });
    onDraft?.({ band: drag.band, crop: drag.draft });
  };

  const end = (event, commit) => {
    const drag = dragRef.current;
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    dragRef.current = null;
    setDragging(false);
    if (commit && drag.moved && drag.draft) onCommit?.(drag.band, drag.draft);
    onDraft?.(null);
  };

  const onKeyDown = (event, band) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const next = nudgedCrop(split[band], event.key, event.shiftKey);
    if (next === null) return;
    // the keys belong to the box while it has focus, not to the dialog's playhead
    event.preventDefault();
    event.stopPropagation();
    const current = split[band];
    if (!locked && (next.x_e5 !== current.x_e5 || next.y_e5 !== current.y_e5 || next.zoom_pm !== current.zoom_pm)) onCommit?.(band, next);
  };

  // the active box last, so it is drawn and picked on top
  const order = [...SPLIT_BANDS].sort((a, b) => (a === active) - (b === active));
  const [w, h] = source;
  return (
    <div ref={rootRef} className={frame.picture} data-gizmo="split" data-dragging={dragging ? "true" : "false"} data-still={stillState}
      style={{ aspectRatio: `${w} / ${h}`, backgroundImage: stillUrl ? `url("${stillUrl}")` : undefined, cursor: "default" }}
      onPointerMove={onPointerMove} onPointerUp={(event) => end(event, true)} onPointerCancel={(event) => end(event, false)}
      onLostPointerCapture={(event) => end(event, true)}>
      {stillState === "loading" && !stillUrl ? <span className={frame.pictureNote} role="status">Memuat gambar…</span> : null}
      {stillState === "failed" ? (
        <span className={frame.pictureNote} role="alert">
          Gambar belum bisa dimuat.
          <button type="button" className={frame.retry} onPointerDown={(event) => event.stopPropagation()} onClick={onRetry}>Coba lagi</button>
        </span>
      ) : null}
      {order.map((band) => {
        const rect = bandBox(geometry, band, source);
        return (
          <div
            key={band}
            ref={(node) => { if (boxRefs?.current) boxRefs.current[band] = node; }}
            className={styles.box}
            data-split-box={band}
            data-active={band === active ? "true" : "false"}
            style={{ left: pct(rect.left), top: pct(rect.top), width: pct(rect.width), height: pct(rect.height) }}
            role="group"
            aria-roledescription="kotak potongan"
            aria-label={`Potongan ${NAMES[band].toLowerCase()}`}
            aria-describedby={helpId}
            aria-disabled={locked ? "true" : undefined}
            tabIndex={0}
            onFocus={() => onSelect?.(band)}
            onKeyDown={(event) => onKeyDown(event, band)}
            onPointerDown={(event) => begin(event, band, "move")}
          >
            <span className={styles.tag} aria-hidden="true">{NAMES[band]}</span>
            {locked ? null : CORNERS.map((corner) => (
              <span key={corner} className={styles.handle} data-corner={corner} aria-hidden="true"
                onPointerDown={(event) => begin(event, band, corner)} />
            ))}
          </div>
        );
      })}
      <span id={helpId} hidden>
        {locked ? "Klip ini hanya bisa dibaca."
          : "Seret kotak untuk memindahkan, tarik sudutnya untuk mengubah ukuran. Panah menggeser 1%, Shift+panah 10%, plus dan minus memperbesar atau memperkecil."}
      </span>
    </div>
  );
}
