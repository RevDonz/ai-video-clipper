"use client";

// The playback controls and the stage toggles (plan Appendix C.1; Mode Cepat spec §5.2, §6.3).
// - The default export is Mode Lengkap's transport row above the timeline: play, frame step and
//   the time "00:12,3 / 00:48,0".
// - PlayButton and TimeReadout also make Mode Cepat's bottom bar.
// - StageToggles are "Frame akhir" and "Zona aman", at the top right beside the stage in both views.
// The time follows the frame bus outside React, so playback never re-renders the shell (plan §6.2).
import { useEffect, useRef } from "react";

import styles from "./shell.module.css";
import { formatClock, frameToMs } from "./shell-model.mjs";
import Icon from "./ui/icons.jsx";
import PillToggle from "./ui/PillToggle.jsx";

const STEP_PATHS = {
  back: "M13.5 4v12L6 10zM4 4h2v12H4z",
  forward: "M6.5 4v12L14 10zM14 4h2v12h-2z",
};

function StepIcon({ name }) {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d={STEP_PATHS[name]} fill="currentColor" />
    </svg>
  );
}

/** Play / pause: the strong neutral round button of both views' bottom regions. */
export function PlayButton({ playing, onPlayPause, disabled = false }) {
  return (
    <button type="button" className={styles.playButton} aria-label={playing ? "Jeda" : "Putar"} onClick={onPlayPause} disabled={disabled}>
      <Icon name={playing ? "pause" : "play"} />
    </button>
  );
}

/** "00:02,2 / 01:00,6": the playhead (from the frame bus) and the clip's length. */
export function TimeReadout({ frameBus, fps, totalFrames }) {
  const nowRef = useRef(null);
  const total = formatClock(frameToMs(totalFrames ?? 0, fps));

  useEffect(() => {
    if (!frameBus) return undefined;
    return frameBus.subscribe((frame) => {
      if (nowRef.current) nowRef.current.textContent = formatClock(frameToMs(frame, fps));
    });
  }, [frameBus, fps]);

  return (
    <span className={styles.time} data-testid="stage-time">
      <span ref={nowRef}>00:00,0</span>
      <span className={styles.timeTotal}>{` / ${total}`}</span>
    </span>
  );
}

/** "Frame akhir" (Ctrl+Shift+R) and "Zona aman" ('), each a pressed-state pill. */
export function StageToggles({ truth, onTruth, safeZone, onToggleSafeZone, disabled = false }) {
  return (
    <div className={styles.stageToggles} role="group" aria-label="Opsi pratinjau">
      <PillToggle pressed={truth} onClick={onTruth} disabled={disabled} aria-keyshortcuts="Control+Shift+R"
        title="Frame akhir (Ctrl+Shift+R)">
        Frame akhir
      </PillToggle>
      <PillToggle pressed={safeZone} onClick={onToggleSafeZone} aria-keyshortcuts="'" title="Zona aman (')">
        <Icon name="safezone" />
        Zona aman
      </PillToggle>
    </div>
  );
}

export default function StageControls({ fps, totalFrames, frameBus, playing, onPlayPause, onStep, disabled = false }) {
  return (
    <div className={styles.controls} role="group" aria-label="Kontrol pratinjau" data-slot="transport">
      <PlayButton playing={playing} onPlayPause={onPlayPause} disabled={disabled} />
      <button type="button" className={styles.stepButton} aria-label="Frame sebelumnya" title="Frame sebelumnya (←)"
        onClick={() => onStep(-1)} disabled={disabled}>
        <StepIcon name="back" />
      </button>
      <button type="button" className={styles.stepButton} aria-label="Frame berikutnya" title="Frame berikutnya (→)"
        onClick={() => onStep(1)} disabled={disabled}>
        <StepIcon name="forward" />
      </button>
      <TimeReadout frameBus={frameBus} fps={fps} totalFrames={totalFrames} />
    </div>
  );
}
