"use client";

// The video lane (plan Appendix C.3): the pieces of the plan, ⋯ markers at jump cuts, the cold-open
// block in its own colour and the trim handles on the body's edges. A dragged edge is magnet-
// snapped to the words artifact's `bounds` table; holding Alt frees the ghost for the view only,
// because the stored value is always a `bounds` frame (TrimStart/TrimEnd take the word next to the
// gap, Appendix B). Arrow keys on a handle move the edge to the adjacent word gap.
// Props (timeline/lanes.mjs): { plan, state, dispatch, player, pxPerFrame } plus the shell's
// `notify` and `readOnly`.
import { useRef, useState } from "react";

import styles from "../shell.module.css";
import { formatClock, rejectionText, sfToMs } from "../shell-model.mjs";
import { bodySegment, cutMarkers, edgeFrames, pieceBlocks, snapTrim, stepTrim } from "./timeline-model.mjs";

function windowFrames(doc) {
  const [num, den] = doc?.output?.fps ?? [30, 1];
  const window = doc?.base?.window_ms ?? [0, 0];
  return [Math.floor((window[0] * num) / (1000 * den)), Math.ceil((window[1] * num) / (1000 * den))];
}

export default function VideoLane({ plan, state, dispatch, pxPerFrame = 1, notify = () => {}, readOnly = false }) {
  const [drag, setDragState] = useState(null);
  // The drag lives in a ref too: pointerup must see the last pointermove even before React renders.
  const dragRef = useRef(null);
  const setDrag = (next) => { dragRef.current = next; setDragState(next); };
  const doc = state?.doc ?? null;
  const words = state?.words ?? null;
  const body = bodySegment(doc);
  const edges = edgeFrames(plan);
  const blocks = pieceBlocks(plan);
  const markers = cutMarkers(plan);
  const fps = doc?.output?.fps ?? plan?.fps;
  const disabled = readOnly || !body || !words || state?.status !== "ready";
  const windowSf = windowFrames(doc);

  const commit = (edge, snapped) => {
    if (!snapped) return;
    try {
      dispatch(edge === "start" ? "TrimStart" : "TrimEnd", { gapWord: snapped.gapWord });
    } catch (error) {
      notify(rejectionText(error));
    }
  };

  const handle = (edge) => {
    if (!edges || !body) return null;
    const sf = edge === "start" ? body.in_sf : body.out_sf;
    const f = edge === "start" ? edges.startF : edges.endF;
    const label = edge === "start" ? "Awal klip" : "Akhir klip";
    return (
      <div
        key={edge}
        className={styles.handle}
        style={{ left: f * pxPerFrame }}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-orientation="horizontal"
        aria-valuemin={windowSf[0]}
        aria-valuemax={windowSf[1]}
        aria-valuenow={sf}
        aria-valuetext={`${label} di ${formatClock(sfToMs(sf, fps))} video sumber`}
        aria-disabled={disabled}
        data-trim-edge={edge}
        onKeyDown={(event) => {
          if (disabled || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
          event.preventDefault();
          const step = stepTrim({ edge, direction: event.key === "ArrowLeft" ? -1 : 1, words, doc });
          if (step) commit(edge, step);
          else notify("Tidak ada celah kata lagi ke arah ini");
        }}
        onPointerDown={(event) => {
          if (disabled || event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture?.(event.pointerId);
          setDrag({ edge, startX: event.clientX, base: sf, baseF: f, delta: 0, candidate: sf, snapped: null, alt: event.altKey });
        }}
        onPointerMove={(event) => {
          const current = dragRef.current;
          if (!current || current.edge !== edge) return;
          const delta = Math.round((event.clientX - current.startX) / pxPerFrame);
          const candidate = current.base + delta;
          setDrag({ ...current, delta, candidate, snapped: snapTrim({ edge, sf: candidate, words, doc }), alt: event.altKey });
        }}
        onPointerUp={(event) => {
          const current = dragRef.current;
          if (!current || current.edge !== edge) return;
          event.currentTarget.releasePointerCapture?.(event.pointerId);
          setDrag(null);
          if (current.snapped && current.snapped.sf !== current.base) commit(edge, current.snapped);
        }}
        onPointerCancel={() => setDrag(null)}
      />
    );
  };

  let ghost = null;
  if (drag && drag.delta !== 0) {
    const free = drag.alt || !drag.snapped;
    const sf = free ? drag.candidate : drag.snapped.sf;
    ghost = (
      <div className={styles.ghost} data-trim-ghost="" data-snapped={free ? "false" : "true"} data-sf={sf}
        style={{ left: (drag.baseF + (sf - drag.base)) * pxPerFrame }} />
    );
  }

  return (
    <div className={styles.lane} data-lane="video">
      {blocks.map((block) => (
        <div
          key={block.key}
          className={`${styles.block} ${block.role === "cold_open" ? styles.coldOpenBlock : styles.bodyBlock}`}
          style={{ left: block.f0 * pxPerFrame, width: Math.max(1, (block.f1 - block.f0) * pxPerFrame) }}
          data-piece-role={block.role}
          title={block.role === "cold_open" ? "Cold open" : "Isi klip"}
        >
          {block.role === "cold_open" ? "Cold open" : ""}
        </div>
      ))}
      {markers.map((marker) => (
        <span
          key={`${marker.kind}-${marker.f}`}
          className={`${styles.marker} ${marker.kind === "join" ? styles.joinMarker : ""}`}
          style={{ left: marker.f * pxPerFrame }}
          role="img"
          aria-label={`${marker.kind === "join" ? "Sambungan cold open" : "Potongan"} di ${formatClock(sfToMs(marker.f, plan?.fps))}`}
          data-marker={marker.kind}
        />
      ))}
      {handle("start")}
      {handle("end")}
      {ghost}
    </div>
  );
}
