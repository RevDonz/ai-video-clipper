"use client";

// The timeline ruler (plan Appendix C.3): ticks in output time; click to seek, drag to scrub
// (throttled to one seek per animation frame). It is also the keyboard-reachable playhead
// ("Posisi pemutaran", a slider): arrows step one frame, Shift+arrows one second, Home/End jump
// to the ends. Its value follows the frame bus outside React.
import { useEffect, useMemo, useRef } from "react";

import styles from "../shell.module.css";
import { formatClock, frameToMs } from "../shell-model.mjs";
import { rulerTicks } from "./timeline-model.mjs";

export default function Ruler({ totalFrames, fps, pxPerFrame, frameBus, onSeek }) {
  const rootRef = useRef(null);
  const drag = useRef({ active: false, frame: null, raf: 0 });
  const ticks = useMemo(() => rulerTicks({ totalFrames, fps, pxPerFrame }), [totalFrames, fps, pxPerFrame]);
  const last = Math.max(0, totalFrames - 1);
  const second = Math.max(1, Math.round((fps?.[0] ?? 30) / (fps?.[1] ?? 1)));

  useEffect(() => {
    if (!frameBus) return undefined;
    return frameBus.subscribe((frame) => {
      const element = rootRef.current;
      if (!element) return;
      element.setAttribute("aria-valuenow", String(frame));
      element.setAttribute("aria-valuetext", formatClock(frameToMs(frame, fps)));
    });
  }, [frameBus, fps]);

  useEffect(() => () => cancelAnimationFrame(drag.current.raf), []);

  const frameAt = (clientX) => {
    const rect = rootRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(last, Math.floor((clientX - rect.left) / pxPerFrame)));
  };

  const queueSeek = (frame) => {
    drag.current.frame = frame;
    if (drag.current.raf) return;
    drag.current.raf = requestAnimationFrame(() => {
      drag.current.raf = 0;
      if (drag.current.frame !== null) onSeek(drag.current.frame);
    });
  };

  const onKeyDown = (event) => {
    const current = frameBus?.get() ?? 0;
    let target = null;
    if (event.key === "ArrowLeft") target = current - (event.shiftKey ? second : 1);
    else if (event.key === "ArrowRight") target = current + (event.shiftKey ? second : 1);
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = last;
    if (target === null) return;
    event.preventDefault();
    onSeek(Math.max(0, Math.min(last, target)));
  };

  return (
    <div
      ref={rootRef}
      className={styles.ruler}
      role="slider"
      tabIndex={0}
      aria-label="Posisi pemutaran"
      aria-valuemin={0}
      aria-valuemax={last}
      aria-valuenow={frameBus?.get() ?? 0}
      aria-valuetext={formatClock(frameToMs(frameBus?.get() ?? 0, fps))}
      data-ruler=""
      onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        drag.current.active = true;
        onSeek(frameAt(event.clientX));
      }}
      onPointerMove={(event) => { if (drag.current.active) queueSeek(frameAt(event.clientX)); }}
      onPointerUp={(event) => {
        drag.current.active = false;
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      }}
      onPointerCancel={() => { drag.current.active = false; }}
    >
      {ticks.map((tick) => (
        <span key={tick.f} className={styles.tick} style={{ left: tick.f * pxPerFrame }} aria-hidden="true">{tick.label}</span>
      ))}
    </div>
  );
}
