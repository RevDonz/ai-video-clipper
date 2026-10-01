"use client";

// Controls under the stage (plan Appendix C.1): play, frame step, the time "00:12,3 / 00:48,0",
// the safe-zone toggle, the state badge and "Frame akhir". The time follows the frame bus
// outside React, so playback never re-renders the shell (plan §6.2 "Seek and scrub").
import { useEffect, useRef } from "react";

import styles from "./shell.module.css";
import StageBadge from "./StageBadge.jsx";
import { formatClock, frameToMs } from "./shell-model.mjs";

function Icon({ name }) {
  const paths = {
    play: "M5 3.5v13l11-6.5z",
    pause: "M5 3.5h3.5v13H5zM11.5 3.5H15v13h-3.5z",
    back: "M13.5 4v12L6 10zM4 4h2v12H4z",
    forward: "M6.5 4v12L14 10zM14 4h2v12h-2z",
  };
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d={paths[name]} fill="currentColor" />
    </svg>
  );
}

export default function StageControls({
  fps, totalFrames, frameBus, playing, onPlayPause, onStep, safeZone, onToggleSafeZone, truth, onTruth, badge,
  disabled = false,
}) {
  const timeRef = useRef(null);

  useEffect(() => {
    if (!frameBus) return undefined;
    const total = formatClock(frameToMs(totalFrames ?? 0, fps));
    return frameBus.subscribe((frame) => {
      if (timeRef.current) timeRef.current.textContent = `${formatClock(frameToMs(frame, fps))} / ${total}`;
    });
  }, [frameBus, fps, totalFrames]);

  return (
    <div className={styles.controls} role="group" aria-label="Kontrol pratinjau">
      <button type="button" className={styles.stageButton} aria-label={playing ? "Jeda" : "Putar"} onClick={onPlayPause} disabled={disabled}>
        <Icon name={playing ? "pause" : "play"} />
      </button>
      <button type="button" className={styles.stageButton} aria-label="Frame sebelumnya" onClick={() => onStep(-1)} disabled={disabled}>
        <Icon name="back" />
      </button>
      <button type="button" className={styles.stageButton} aria-label="Frame berikutnya" onClick={() => onStep(1)} disabled={disabled}>
        <Icon name="forward" />
      </button>
      <span ref={timeRef} className={styles.time} data-testid="stage-time">00:00,0 / 00:00,0</span>
      <span className={styles.spacer} />
      <StageBadge view={badge} />
      <button type="button" className={styles.stageButton} aria-pressed={safeZone} onClick={onToggleSafeZone}>
        Zona aman
      </button>
      <button type="button" className={styles.stageButton} aria-pressed={truth} onClick={onTruth} disabled={disabled}>
        Frame akhir
      </button>
    </div>
  );
}
