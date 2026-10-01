"use client";

// The marker lane (plan §11.3 T3.7, Appendix C.3): laughter (caption tags and "haha/wkwk" in the
// transcript), silences of at least 0.6 s and camera cuts, at their output frames (markers.mjs,
// the time map's word rule, computed from the current document). A click or Enter seeks to the
// marker; the lane is one tab stop and arrows move between markers (toolbar pattern). Hover or
// focus shows where the marker comes from. When the job lacks the analysis, a note says so
// ("tidak tersedia untuk job ini", from the words artifact's `missing`): in the lane when it has
// no markers, else in the timeline's header (`onNote`), so no marker covers it.
// Props (timeline/lanes.mjs): { plan, state, dispatch, player, pxPerFrame, onNote }.
import { useEffect, useMemo, useRef, useState } from "react";

import styles from "../../shell.module.css";
import css from "./MarkerLane.module.css";
import { buildMarkers, markerText, unavailableNote } from "./markers.mjs";

const TIP_FLIP_PX = 280;

function MarkerIcon({ kind }) {
  if (kind === "laughter") {
    // a laughing face: closed eyes and an open mouth
    return (
      <svg className={css.icon} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M4.6 6.6q1.1-1.2 2.2 0M9.2 6.6q1.1-1.2 2.2 0" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <path d="M4.8 9.2h6.4q-.4 3-3.2 3t-3.2-3z" fill="currentColor" />
      </svg>
    );
  }
  if (kind === "silence") {
    return (
      <svg className={css.icon} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <rect x="4" y="3" width="2.6" height="10" rx="1" fill="currentColor" />
        <rect x="9.4" y="3" width="2.6" height="10" rx="1" fill="currentColor" />
      </svg>
    );
  }
  return <span className={css.cutLine} aria-hidden="true" />;
}

export default function MarkerLane({ plan, state, player, pxPerFrame = 1, onNote = null }) {
  const words = state?.words ?? null;
  const doc = state?.doc ?? null;
  const fps = doc?.output?.fps ?? plan?.fps ?? [30, 1];
  const { markers, unavailable } = useMemo(() => buildMarkers(words, doc), [words, doc]);
  const texts = useMemo(() => markers.map((marker) => markerText(marker, { fps, words })), [markers, fps, words]);
  const [active, setActive] = useState(0);
  const [tip, setTip] = useState(null);
  const buttons = useRef([]);
  const note = unavailableNote(unavailable);
  const status = !words || !doc ? "loading" : markers.length ? "ready" : "empty";
  const current = Math.min(active, Math.max(0, markers.length - 1));
  const width = (plan?.totalFrames ?? 0) * pxPerFrame;
  const noteInHeader = typeof onNote === "function" && Boolean(note) && markers.length > 0;

  useEffect(() => {
    if (typeof onNote !== "function") return undefined;
    onNote(noteInHeader ? note : null);
    return () => onNote(null);
  }, [onNote, noteInHeader, note]);

  const seek = (index) => {
    setActive(index);
    setTip(index);
    player?.seek(markers[index].f0);
  };
  const focusAt = (index) => {
    const target = Math.max(0, Math.min(markers.length - 1, index));
    setActive(target);
    buttons.current[target]?.focus();
  };
  const onKeyDown = (event) => {
    const moves = { ArrowRight: current + 1, ArrowLeft: current - 1, Home: 0, End: markers.length - 1 };
    if (!(event.key in moves)) return;
    event.preventDefault(); // the shell skips handled keys, so its arrows do not step frames here
    focusAt(moves[event.key]);
  };

  let tipNode = null;
  if (tip !== null && markers[tip]) {
    const left = markers[tip].f0 * pxPerFrame;
    const flip = width > 0 && left > width - TIP_FLIP_PX;
    tipNode = (
      <span className={`${css.tip} ${flip ? css.tipFlip : ""}`} style={{ left }} data-marker-tip="" aria-hidden="true">
        <span>{texts[tip].short}</span>
        <span className={css.tipTime}>{texts[tip].time}</span>
      </span>
    );
  }

  return (
    <div className={`${styles.lane} ${css.lane}`} data-lane="markers" data-markers-state={status}>
      {status === "loading" && <p className={css.note} data-markers-loading="">Memuat penanda…</p>}
      {note && !noteInHeader && <p className={css.note} data-markers-note="">{note}</p>}
      {status === "empty" && !note && (
        <p className={css.note} data-markers-empty="">Tidak ada tawa, jeda panjang, atau potongan kamera di klip ini.</p>
      )}
      {markers.length > 0 && (
        <div className={css.track} role="toolbar" aria-label="Penanda tawa, jeda, dan potongan kamera" aria-orientation="horizontal"
          onKeyDown={onKeyDown}>
          {markers.map((marker, index) => (
            <button
              key={marker.key}
              ref={(element) => { buttons.current[index] = element; }}
              type="button"
              className={`${css.marker} ${css[marker.kind]}`}
              style={{ left: marker.f0 * pxPerFrame,
                width: marker.kind === "silence" ? Math.max(0, (marker.f1 - marker.f0) * pxPerFrame) : undefined }}
              tabIndex={index === current ? 0 : -1}
              aria-label={texts[index].label}
              data-event-marker=""
              data-kind={marker.kind}
              data-src={marker.src}
              data-seg={marker.seg}
              data-f0={marker.f0}
              data-f1={marker.f1}
              onClick={() => seek(index)}
              onFocus={() => { setActive(index); setTip(index); }}
              onBlur={() => setTip((shown) => (shown === index ? null : shown))}
              onPointerEnter={() => setTip(index)}
              onPointerLeave={() => setTip((shown) => (shown === index && document.activeElement !== buttons.current[index] ? null : shown))}
            >
              <MarkerIcon kind={marker.kind} />
            </button>
          ))}
        </div>
      )}
      {tipNode}
    </div>
  );
}
