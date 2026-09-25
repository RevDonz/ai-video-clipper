"use client";

// The caption lane (plan Appendix C.3): one block per cue of the plan (`plan.cues`, output frames);
// a click seeks to the cue. Pixels always come from the ASS; this lane only shows where cues are.
// Props (timeline/lanes.mjs): { plan, state, dispatch, player, pxPerFrame }.
import styles from "../shell.module.css";

export default function CaptionLane({ plan, state, player, pxPerFrame = 1 }) {
  const cues = Array.isArray(plan?.cues) ? plan.cues : [];
  const enabled = state?.doc?.captions?.enabled !== false;
  return (
    <div className={styles.lane} data-lane="captions">
      {!enabled && <span className={styles.emptyLane}>Caption dimatikan</span>}
      {enabled && cues.map((cue) => (
        <div
          key={`${cue.f0}-${cue.f1}`}
          className={`${styles.block} ${styles.cueBlock}`}
          style={{ left: cue.f0 * pxPerFrame, width: Math.max(2, (cue.f1 - cue.f0) * pxPerFrame) }}
          title={cue.text}
          data-cue=""
          onClick={() => player?.seek(cue.f0)}
        >
          {cue.text}
        </div>
      ))}
    </div>
  );
}
