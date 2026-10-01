"use client";

// The hook lane (plan Appendix C.3): the hook block from the start of the clip and its duration
// handle. Dragging snaps to whole frames inside the §3.3 range (15 to ⌊30·F⌋) and dispatches one
// SetHookDuration on release; arrow keys change it by one frame (Shift: one second), merged into
// one undo step (mergeKey "hook:dur_f", Appendix B).
// Props (timeline/lanes.mjs): { plan, state, dispatch, player, pxPerFrame } plus `notify`, `readOnly`.
import { useRef, useState } from "react";

import styles from "../shell.module.css";
import { formatSeconds, frameToMs, rejectionText } from "../shell-model.mjs";
import { clampHookDuration, hookDurationBounds } from "./timeline-model.mjs";

function hookItem(doc) {
  return doc?.tracks?.find((track) => track.kind === "hook")?.items?.[0] ?? null;
}

export default function HookLane({ plan, state, dispatch, pxPerFrame = 1, notify = () => {}, readOnly = false }) {
  const [drag, setDragState] = useState(null);
  const dragRef = useRef(null);
  const setDrag = (next) => { dragRef.current = next; setDragState(next); };
  const item = hookItem(state?.doc);
  const fps = state?.doc?.output?.fps ?? plan?.fps ?? [30, 1];
  if (!item) {
    return <div className={styles.lane} data-lane="hook"><span className={styles.emptyLane}>Tidak ada hook</span></div>;
  }
  const { min, max } = hookDurationBounds(fps);
  const durF = drag ? drag.dur : item.dur_f;
  const f0 = plan?.hook?.f0 ?? 0;
  const disabled = readOnly || state?.status !== "ready";
  const second = Math.max(1, Math.round(fps[0] / fps[1]));
  const text = plan?.hook?.lines?.join(" ") ?? item.payload?.text ?? "";

  const commit = (dur, mergeKey = null) => {
    if (dur === item.dur_f) return;
    try {
      if (mergeKey) dispatch("SetHookDuration", { dur_f: dur }, { mergeKey });
      else dispatch("SetHookDuration", { dur_f: dur });
    } catch (error) {
      notify(rejectionText(error));
    }
  };

  return (
    <div className={styles.lane} data-lane="hook">
      <div
        className={`${styles.block} ${styles.hookBlock}`}
        style={{ left: f0 * pxPerFrame, width: Math.max(2, durF * pxPerFrame) }}
        title={text}
        data-hook-block=""
      >
        {text}
      </div>
      <div
        className={`${styles.handle} ${styles.hookHandle}`}
        style={{ left: (f0 + durF) * pxPerFrame }}
        role="slider"
        tabIndex={0}
        aria-label="Durasi hook"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={durF}
        aria-valuetext={formatSeconds(frameToMs(durF, fps))}
        aria-disabled={disabled}
        onKeyDown={(event) => {
          if (disabled) return;
          const steps = { ArrowLeft: -1, ArrowRight: 1 };
          let next = null;
          if (event.key in steps) next = item.dur_f + steps[event.key] * (event.shiftKey ? second : 1);
          else if (event.key === "Home") next = min;
          else if (event.key === "End") next = max;
          if (next === null) return;
          event.preventDefault();
          commit(clampHookDuration(next, fps), "hook:dur_f");
        }}
        onPointerDown={(event) => {
          if (disabled || event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture?.(event.pointerId);
          setDrag({ startX: event.clientX, start: item.dur_f, dur: item.dur_f });
        }}
        onPointerMove={(event) => {
          const current = dragRef.current;
          if (!current) return;
          setDrag({ ...current, dur: clampHookDuration(current.start + (event.clientX - current.startX) / pxPerFrame, fps) });
        }}
        onPointerUp={(event) => {
          const current = dragRef.current;
          if (!current) return;
          event.currentTarget.releasePointerCapture?.(event.pointerId);
          setDrag(null);
          commit(current.dur);
        }}
        onPointerCancel={() => setDrag(null)}
      />
    </div>
  );
}
