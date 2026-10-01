"use client";

// The 9:16 stage (plan Appendix C.1, §6.2): one canvas at the output size, CSS-scaled, that the
// player composites into; the revision-0 `<video>` of the auto render, shown while the player
// reports mode "auto_render" (§6.1 "Revision 0 before plate cells exist"); the TikTok safe-zone
// overlay (§5.9 G5 zone); and the gizmo slot W3 mounts into (T3.2's LogoGizmo), so this file needs
// no edit in W3.
import { useEffect, useRef } from "react";

import styles from "./shell.module.css";
import { safeApiHref } from "./shell-model.mjs";

// The TikTok UI zone at 720×1280 (plan §5.9 G5): top 93 px, bottom 280 px, right 93 px; scaled
// with the output width.
const ZONE = { top: 93, bottom: 280, right: 93, width: 720 };

function SafeZone({ w, h }) {
  const scale = w / ZONE.width;
  const top = Math.round(ZONE.top * scale);
  const bottom = Math.round(ZONE.bottom * scale);
  const right = Math.round(ZONE.right * scale);
  return (
    <div className={styles.overlay} data-safe-zone="">
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height="100%" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <rect x="0" y="0" width={w} height={top} fill="var(--danger-veil)" />
        <rect x="0" y={h - bottom} width={w} height={bottom} fill="var(--danger-veil)" />
        <rect x={w - right} y={top} width={right} height={h - top - bottom} fill="var(--danger-veil)" />
        <rect x="0.5" y={top} width={w - right - 1} height={h - top - bottom} fill="none" stroke="var(--danger)" strokeDasharray="12 8" strokeWidth="2" />
      </svg>
      <span className={styles.safeZoneLabel}>Area tombol TikTok</span>
    </div>
  );
}

export default function Stage({ output, plan, playerMode, safeZone = false, onMedia, gizmos = null }) {
  const canvasRef = useRef(null);
  const videoRef = useRef(null);
  const w = output?.w ?? 720;
  const h = output?.h ?? 1280;
  const autoUrl = plan?.rev0?.exact === true ? safeApiHref(plan.rev0.autoRenderUrl) : null;
  const showAuto = playerMode === "auto_render" && Boolean(autoUrl);

  useEffect(() => {
    onMedia?.({ canvas: canvasRef.current, video: videoRef.current });
    return () => onMedia?.(null);
  }, [onMedia]);

  return (
    <div className={styles.stageArea}>
      <div className={styles.stageFrame} style={{ aspectRatio: `${w} / ${h}` }}>
        <canvas
          ref={canvasRef}
          className={styles.stageMedia}
          width={w}
          height={h}
          role="img"
          aria-label="Pratinjau klip"
          hidden={showAuto}
          data-stage="canvas"
        />
        {/* The player owns this element's `src` (it loads, seeks and steps the auto render;
            T2.4): setting it here too would restart the load and lose the seek (T2.Z). */}
        <video
          ref={videoRef}
          className={styles.stageMedia}
          hidden={!showAuto}
          playsInline
          preload="auto"
          aria-label="Klip otomatis (identik dengan hasil akhir)"
          data-stage="auto-render"
        />
        {safeZone && <SafeZone w={w} h={h} />}
        <div className={styles.gizmoLayer} data-slot="gizmos">{gizmos}</div>
      </div>
    </div>
  );
}
