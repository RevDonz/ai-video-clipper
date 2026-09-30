"use client";

// The audio lane (plan §11.3 T3.7, Appendix C.3): the speech waveform laid out per piece of the
// current document (speech-waveform.mjs), so a cut closes the waveform where it closes the video,
// in the colour of its video block (cold open or body). The peaks are the clip's own
// `peaks.<sha16>.bin`, fetched once. A click seeks there, like the ruler. States: loading,
// failed (with a retry), a source without audio, and peaks that do not exist for this clip.
// Props (timeline/lanes.mjs): { plan, state, dispatch, player, pxPerFrame }.
import { useEffect, useMemo, useState } from "react";

import styles from "../../shell.module.css";
import { pieces as docPieces } from "../../../../lib/editor/timemap.mjs";
import css from "./AudioLane.module.css";
import { loadPeaks, peaksUrl, waveformShapes } from "./speech-waveform.mjs";

/** The fake runtime (dev hook) has no peaks route: it answers only when its API can. */
function peaksLoader() {
  const fakeApi = globalThis.__potonginEditor?.api;
  if (!fakeApi) return (url) => loadPeaks(url);
  return typeof fakeApi.peaks === "function" ? (url) => fakeApi.peaks(url) : null;
}

export default function AudioLane({ state, player, pxPerFrame = 1 }) {
  const doc = state?.doc ?? null;
  const words = state?.words ?? null;
  const hasAudio = doc?.base?.source?.has_audio !== false;
  const url = peaksUrl(state);
  const [load, setLoad] = useState({ url: null, status: "idle", peaks: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!url || !hasAudio) return undefined;
    const loader = peaksLoader();
    if (!loader) {
      setLoad({ url, status: "unavailable", peaks: null });
      return undefined;
    }
    let alive = true;
    setLoad({ url, status: "loading", peaks: null });
    Promise.resolve(loader(url))
      .then((peaks) => { if (alive) setLoad({ url, status: "ready", peaks }); })
      .catch(() => { if (alive) setLoad({ url, status: "error", peaks: null }); });
    return () => { alive = false; };
  }, [url, hasAudio, attempt]);

  const pieces = useMemo(() => {
    try {
      return doc ? docPieces(doc) : [];
    } catch {
      return [];
    }
  }, [doc]);
  const ready = load.status === "ready" && load.url === url && load.peaks;
  const waveform = useMemo(() => (ready && doc
    ? waveformShapes({ peaks: load.peaks, peaksInfo: words?.peaks, pieces, fps: doc.output.fps, pxPerFrame })
    : null), [ready, load.peaks, words, pieces, doc, pxPerFrame]);

  let status = "loading";
  if (doc && words) {
    if (!hasAudio) status = "silent";
    else if (!url) status = "unavailable";
    else if (ready) status = "ready";
    else if (load.url === url && ["error", "unavailable"].includes(load.status)) status = load.status;
  }

  const onPointerDown = (event) => {
    if (event.button !== 0 || event.target.closest("button") || !pxPerFrame) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const total = pieces.length ? pieces.at(-1).outF0 + pieces.at(-1).frames : 0;
    const frame = Math.floor((event.clientX - rect.left) / pxPerFrame);
    if (frame >= 0 && frame < total) player?.seek(frame);
  };

  return (
    <div className={`${styles.lane} ${css.lane}`} data-lane="audio" data-waveform-state={status} onPointerDown={onPointerDown}>
      {status === "ready" && waveform && (
        <svg className={css.wave} width={Math.max(1, waveform.total * pxPerFrame)} viewBox={`0 -1 ${Math.max(1, waveform.total)} 2`}
          preserveAspectRatio="none" role="img" aria-label="Waveform suara klip">
          {waveform.shapes.map((shape) => (
            <path key={shape.key} d={shape.d} className={shape.role === "cold_open" ? css.coldOpen : css.body}
              data-piece={shape.i} data-role={shape.role} data-f0={shape.f0} data-f1={shape.f1} />
          ))}
        </svg>
      )}
      {status === "loading" && <p className={css.note}>Memuat waveform…</p>}
      {status === "silent" && <p className={css.note}>Video sumber tanpa suara, jadi tidak ada waveform.</p>}
      {status === "unavailable" && <p className={css.note}>Waveform tidak tersedia untuk klip ini.</p>}
      {status === "error" && (
        <p className={css.note}>
          Waveform tidak bisa dimuat.
          <button type="button" className={css.retry} aria-label="Muat ulang waveform" onClick={() => setAttempt((value) => value + 1)}>
            Coba lagi
          </button>
        </p>
      )}
    </div>
  );
}
