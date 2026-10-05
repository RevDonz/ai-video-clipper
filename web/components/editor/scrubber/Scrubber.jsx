"use client";

// Mode Cepat's scrubber (spec §7). Z0 lands it as a plain range input over the plan's frames: it
// follows the frame bus outside React and seeks on input. Task D adds the marks, the legend and
// the keys of §7.
import { useEffect, useRef } from "react";

import { formatClock, frameToMs } from "../shell-model.mjs";
import styles from "./scrubber.module.css";

export default function Scrubber({ plan, player, frameBus, disabled = false }) {
  const inputRef = useRef(null);
  const total = plan?.totalFrames ?? 0;
  const fps = plan?.fps ?? null;
  const last = Math.max(0, total - 1);

  useEffect(() => {
    if (!frameBus || !fps) return undefined;
    const totalText = formatClock(frameToMs(total, fps));
    return frameBus.subscribe((frame) => {
      const input = inputRef.current;
      if (!input) return;
      const at = Math.min(last, Math.max(0, frame));
      input.value = String(at);
      input.setAttribute("aria-valuetext", `${formatClock(frameToMs(at, fps))} dari ${totalText}`);
    });
  }, [frameBus, fps, total, last]);

  return (
    <input ref={inputRef} type="range" className={styles.range} min={0} max={last} step={1} defaultValue={0}
      aria-label="Posisi putar" disabled={disabled || !plan}
      onChange={(event) => player?.seek(Number(event.currentTarget.value))} />
  );
}
