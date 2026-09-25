"use client";

// The timeline (plan Appendix C.3), in output time: the ruler, the lanes of the registry
// (timeline/lanes.mjs, never edited here), hatched bands where plate cells are still building,
// and the playhead (moved outside React through the frame bus). Ctrl+scroll zooms around the
// pointer; the header buttons do the same from the keyboard. Until the user zooms, the clip fits
// the width.
import { Suspense, lazy, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import styles from "../shell.module.css";
import { LANES } from "./lanes.mjs";
import Ruler from "./Ruler.jsx";
import { clampZoom, fitZoom, pendingBands, zoomAround } from "./timeline-model.mjs";

const TRACK_PADDING = 12;
const components = new Map();

function laneComponent(entry) {
  if (!components.has(entry.file)) components.set(entry.file, lazy(entry.load));
  return components.get(entry.file);
}

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export default function Timeline({ plan, state, dispatch, player, frameBus, notify, readOnly, lanes = LANES }) {
  const scrollerRef = useRef(null);
  const playheadRef = useRef(null);
  const [zoom, setZoom] = useState({ px: 1, fitted: true });
  const [width, setWidth] = useState(0);
  const totalFrames = plan?.totalFrames ?? 0;
  const fps = plan?.fps ?? state?.doc?.output?.fps ?? [30, 1];
  const px = zoom.fitted ? fitZoom(totalFrames, Math.max(0, width - 2 * TRACK_PADDING)) : zoom.px;
  const bands = useMemo(() => pendingBands(plan), [plan]);

  useIsoLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return undefined;
    const measure = () => setWidth(scroller.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return undefined;
    const onWheel = (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = scroller.getBoundingClientRect();
      const next = zoomAround({ pxPerFrame: px, factor: event.deltaY < 0 ? 1.2 : 1 / 1.2,
        anchorPx: event.clientX - rect.left - TRACK_PADDING, scrollLeft: scroller.scrollLeft });
      setZoom({ px: next.pxPerFrame, fitted: false });
      requestAnimationFrame(() => { scroller.scrollLeft = next.scrollLeft; });
    };
    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => scroller.removeEventListener("wheel", onWheel);
  }, [px]);

  useEffect(() => {
    if (!frameBus) return undefined;
    return frameBus.subscribe((frame) => {
      if (playheadRef.current) playheadRef.current.style.transform = `translateX(${frame * px}px)`;
    });
  }, [frameBus, px]);

  const zoomBy = (factor) => {
    const scroller = scrollerRef.current;
    const anchor = frameBus ? frameBus.get() * px - (scroller?.scrollLeft ?? 0) : 0;
    const next = zoomAround({ pxPerFrame: px, factor, anchorPx: anchor, scrollLeft: scroller?.scrollLeft ?? 0 });
    setZoom({ px: clampZoom(next.pxPerFrame), fitted: false });
    requestAnimationFrame(() => { if (scroller) scroller.scrollLeft = next.scrollLeft; });
  };

  const seek = (frame) => { player?.seek(frame); };

  return (
    <section className={styles.timeline} data-slot="timeline" aria-label="Timeline" data-px-per-frame={px}>
      <div className={styles.timelineHeader}>
        <button type="button" className={styles.button} aria-label="Perkecil timeline" onClick={() => zoomBy(1 / 1.5)}>−</button>
        <button type="button" className={styles.button} aria-label="Perbesar timeline" onClick={() => zoomBy(1.5)}>+</button>
        <button type="button" className={styles.button} onClick={() => setZoom({ px, fitted: true })} disabled={zoom.fitted}>Paskan</button>
        <span>Ctrl + scroll untuk zoom · klik penggaris untuk memindah playhead</span>
      </div>
      <div className={styles.timelineBody}>
        <div className={styles.laneLabels} aria-hidden="true">
          <div className={styles.rulerSpacer} />
          {lanes.map((entry) => <div key={entry.id} className={styles.laneLabel}>{entry.label}</div>)}
        </div>
        <div ref={scrollerRef} className={styles.scroller}>
          <div className={styles.content} style={{ width: totalFrames * px + 2 * TRACK_PADDING, paddingLeft: TRACK_PADDING }}>
            <div style={{ position: "relative", width: totalFrames * px }} data-track="">
              <Ruler totalFrames={totalFrames} fps={fps} pxPerFrame={px} frameBus={frameBus} onSeek={seek} />
              {lanes.map((entry) => {
                const Lane = laneComponent(entry);
                return (
                  <div key={entry.id} className={styles.laneRow} data-lane-row={entry.id}>
                    <Suspense fallback={null}>
                      <Lane plan={plan} state={state} dispatch={dispatch} player={player} pxPerFrame={px} notify={notify} readOnly={readOnly} />
                    </Suspense>
                  </div>
                );
              })}
              <div className={styles.bands} aria-hidden="true">
                {bands.map((band) => (
                  <div key={band.f0} className={styles.band} data-pending-band="" style={{ left: band.f0 * px, width: (band.f1 - band.f0) * px }} />
                ))}
              </div>
              <div ref={playheadRef} className={styles.playhead} data-playhead="" aria-hidden="true" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
