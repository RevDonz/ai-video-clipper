"use client";

// The music lane (plan Appendix C.3, §4.3 `audio.musicGainPoints`): the track's waveform laid out
// through its start offset and loop, and the duck and fade curve drawn vertex for vertex from the
// plan's breakpoints (music-lane-model.mjs). A click moves the playhead there.
// Props (timeline/lanes.mjs): { plan, state, dispatch, player, pxPerFrame }.
import { useEffect, useMemo, useState } from "react";

import { musicItem } from "../../../../lib/editor/doc-model.mjs";
import shell from "../../shell.module.css";
import {
  decodePeaks,
  envelopePoints,
  envelopeRef,
  waveformColumns,
  waveformPath,
} from "./music-lane-model.mjs";
import styles from "./MusicLane.module.css";

const HEIGHT = 100; // viewBox units; the SVG stretches to the lane's height
const peaksByUrl = new Map();

// The asset's peaks (§5.7 format) from the asset route (T3.1, `?part=peaks`); null when missing.
function loadPeaks(url) {
  if (!peaksByUrl.has(url)) {
    peaksByUrl.set(url, fetch(url, { credentials: "same-origin" })
      .then((response) => (response.ok ? response.arrayBuffer() : null))
      .then((buffer) => (buffer ? decodePeaks(buffer) : null))
      .catch(() => null));
  }
  return peaksByUrl.get(url);
}

export default function MusicLane({ plan, state, player, pxPerFrame = 1 }) {
  const doc = state?.doc ?? null;
  const item = doc ? musicItem(doc) : null;
  const assetId = item?.payload?.asset ?? null;
  const jobId = doc?.base?.job_id ?? state?.jobId ?? null;
  const url = assetId && jobId ? `/api/jobs/${encodeURIComponent(jobId)}/assets/${assetId.slice("sha256:".length)}?part=peaks` : null;
  const [peaks, setPeaks] = useState(null);

  useEffect(() => {
    let alive = true;
    setPeaks(null);
    if (url) loadPeaks(url).then((loaded) => { if (alive) setPeaks(loaded); });
    return () => { alive = false; };
  }, [url]);

  const points = useMemo(() => (Array.isArray(plan?.audio?.musicGainPoints) ? plan.audio.musicGainPoints : []), [plan]);
  const fps = plan?.fps ?? doc?.output?.fps ?? [30, 1];
  const totalFrames = plan?.totalFrames ?? 0;
  const width = totalFrames * pxPerFrame;
  const refE6 = item ? envelopeRef(points, item.payload.gain_cdb) : 0;
  const durationMs = assetId ? doc?.assets?.[assetId]?.duration_ms ?? 0 : 0;
  const payload = item?.payload ?? null;

  const envelope = useMemo(() => envelopePoints(points, { fps, pxPerFrame, refE6, height: HEIGHT })
    .map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).join(" "), [points, fps, pxPerFrame, refE6]);
  const wave = useMemo(() => (payload && peaks && points.length
    ? waveformPath(waveformColumns({ peaks, payload, durationMs, points, fps, pxPerFrame, totalFrames, refE6 }), HEIGHT)
    : ""), [payload, peaks, points, durationMs, fps, pxPerFrame, totalFrames, refE6]);

  if (!item) {
    return <div className={shell.lane} data-lane="music"><span className={shell.emptyLane}>Tidak ada musik</span></div>;
  }

  const seek = (event) => {
    if (!(pxPerFrame > 0) || !totalFrames) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const frame = Math.floor((event.clientX - rect.left) / pxPerFrame);
    player?.seek(Math.max(0, Math.min(totalFrames - 1, frame)));
  };

  return (
    // Mouse shortcut only: the ruler and the stage controls move the playhead by keyboard.
    <div className={`${shell.lane} ${styles.lane}`} data-lane="music" onClick={seek}>
      {width > 0 ? (
        <svg className={styles.svg} width={width} viewBox={`0 0 ${width} ${HEIGHT}`} preserveAspectRatio="none"
          role="img" aria-label={payload.duck?.on ? "Volume musik sepanjang klip: turun saat ada suara" : "Volume musik sepanjang klip"}>
          {wave ? <path className={styles.wave} d={wave} data-music-wave="" /> : null}
          {envelope ? (
            <polyline className={styles.envelope} points={envelope} vectorEffect="non-scaling-stroke"
              data-music-envelope="" data-height={HEIGHT} data-ref-e6={refE6} />
          ) : null}
        </svg>
      ) : null}
    </div>
  );
}
