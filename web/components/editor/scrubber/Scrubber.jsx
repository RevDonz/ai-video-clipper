"use client";

// Mode Cepat's scrubber (docs/plans/2026-10-02-editor-mode-cepat.md §7): one row with a 44 px hit
// area over the clip's frames, with the laughs, pauses, the cold-open range and the join mark
// (scrubber-model.mjs), a legend, and the note when the job lacks some analysis.
//
// The control itself is a native range input laid over the drawing (transparent, so its role,
// value and keys are the browser's own: `role="slider"`, `aria-valuenow`, and fill() in the
// specs), and the scrubber takes its keys and its pointer: ←/→ a frame, Shift a second,
// Home/End, PageUp/PageDown to the marks, Space and K play or pause (the editor's shortcuts
// leave Space to a focused slider). A press within 6 px of a mark seeks to it; dragging seeks
// once per animation frame. The playhead follows the frame bus outside React, and while playing
// the slider's value moves at most four times a second.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import { unavailableNote } from "../timeline/lanes/markers.mjs";
import {
  SNAP_PX, drawGroups, frameAtPx, legendItems, nearestMark, pxAtFrame, scrubberKey, scrubberMarks, valueText,
} from "./scrubber-model.mjs";
import styles from "./scrubber.module.css";

const VALUE_MS = 250;
const TIP_EDGE_PX = 120;
const SWATCH = Object.freeze({ Tawa: "laughter", Jeda: "silence", "Cold open": "cold", Transisi: "join" });

export default function Scrubber({ plan, state, player, frameBus, disabled = false }) {
  const total = plan?.totalFrames ?? 0;
  const fps = plan?.fps ?? state?.doc?.output?.fps ?? [30, 1];
  const last = Math.max(0, total - 1);
  const doc = state?.doc ?? null;
  const words = state?.words ?? null;
  const model = useMemo(() => scrubberMarks({ doc, words }), [doc, words]);
  const trackRef = useRef(null);
  const inputRef = useRef(null);
  const playheadRef = useRef(null);
  const pressRef = useRef(null);
  const playingRef = useRef(false);
  const scaleRef = useRef({ width: 0, total });
  const [width, setWidth] = useState(0);
  const [tip, setTip] = useState(null);
  const ids = useId();
  const off = disabled || !plan || total <= 0;

  const scale = useMemo(() => ({ width, total }), [width, total]);
  scaleRef.current = scale;
  const pxPerFrame = total > 0 ? width / total : 0;
  const groups = useMemo(() => drawGroups(model.marks, pxPerFrame), [model.marks, pxPerFrame]);
  const joinX = model.join ? pxAtFrame(model.join.f, scale) : null;
  const snapTargets = useMemo(() => (model.join ? [...model.marks, model.join] : model.marks), [model]);
  // The labelled things under the pointer or a key: the drawn groups (with every frame they
  // stand for) and the join mark.
  const labelled = useMemo(() => {
    const list = groups.map((group) => ({ frames: group.marks.map((mark) => mark.f), x: group.x, label: group.label }));
    if (model.join) list.push({ frames: [model.join.f], x: joinX, label: `${model.join.text} · ${model.join.time}` });
    return list;
  }, [groups, model.join, joinX]);
  const note = unavailableNote(model.unavailable);

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return undefined;
    setWidth(track.getBoundingClientRect().width);
    if (typeof ResizeObserver !== "function") return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(track);
    return () => observer.disconnect();
  }, []);

  // The player reports `playing` (lib/editor/player); a player that does not is followed by the
  // scrubber's own Space and K.
  const isPlaying = () => {
    const reported = player?.state?.()?.playing;
    return typeof reported === "boolean" ? reported : playingRef.current;
  };
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;

  useEffect(() => {
    if (!frameBus) return undefined;
    let latest = 0;
    let lastValueAt = -Infinity;
    let timer = null;
    const applyValue = () => {
      timer = null;
      lastValueAt = performance.now();
      const input = inputRef.current;
      if (!input) return;
      input.value = String(latest);
      input.setAttribute("aria-valuetext", valueText(latest, total, fps));
    };
    const unsubscribe = frameBus.subscribe((frame) => {
      latest = Math.min(last, Math.max(0, frame));
      const head = playheadRef.current;
      if (head) head.style.transform = `translateX(${pxAtFrame(latest, scaleRef.current)}px)`;
      const now = performance.now();
      if (!isPlayingRef.current() || now - lastValueAt >= VALUE_MS) {
        clearTimeout(timer);
        applyValue();
      } else if (timer === null) {
        timer = setTimeout(applyValue, VALUE_MS - (now - lastValueAt));
      }
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [frameBus, total, fps, last]);

  // A new width moves the playhead with the track.
  useEffect(() => {
    const head = playheadRef.current;
    if (head && frameBus) head.style.transform = `translateX(${pxAtFrame(frameBus.get(), scale)}px)`;
  }, [scale, frameBus]);

  const seek = (frame) => {
    player?.seek?.(Math.max(0, Math.min(last, frame)));
  };

  const toggle = () => {
    if (isPlaying()) {
      player?.pause?.();
      playingRef.current = false;
    } else {
      player?.play?.();
      playingRef.current = true;
    }
  };

  const showTip = (entry) => {
    if (!entry) {
      setTip(null);
      return;
    }
    const align = entry.x < TIP_EDGE_PX ? "start" : entry.x > width - TIP_EDGE_PX ? "end" : "centre";
    setTip((current) => (current?.label === entry.label && current?.x === entry.x ? current : { x: entry.x, label: entry.label, align }));
  };

  const labelAtFrame = (frame) => labelled.find((entry) => entry.frames.includes(frame)) ?? null;
  const labelAtPx = (px) => {
    let best = null;
    for (const entry of labelled) {
      const distance = Math.abs(entry.x - px);
      if (distance <= SNAP_PX && (!best || distance < Math.abs(best.x - px))) best = entry;
    }
    return best;
  };

  const currentFrame = () => (frameBus ? frameBus.get() : Number(inputRef.current?.value ?? 0));

  const onKeyDown = (event) => {
    if (off) return;
    const action = scrubberKey(event, { frame: currentFrame(), total, fps, stops: model.stops });
    if (!action) return;
    event.preventDefault();
    if (action.kind === "toggle") {
      toggle();
      return;
    }
    seek(action.frame);
    showTip(labelAtFrame(action.frame));
  };

  const pointerX = (event) => event.clientX - (trackRef.current?.getBoundingClientRect().left ?? 0);

  const onPointerDown = (event) => {
    if (off || event.button !== 0) return;
    event.preventDefault(); // the scrubber places the press itself (snapping), not the native range
    const input = inputRef.current;
    input?.focus({ preventScroll: true });
    try {
      input?.setPointerCapture(event.pointerId);
    } catch {
      // a pointer that is already gone cannot be captured; the press still seeks
    }
    pressRef.current = { id: event.pointerId, raf: 0, frame: null };
    const frame = frameAtPx(pointerX(event), scaleRef.current);
    const snapped = nearestMark(snapTargets, frame, pxPerFrame);
    seek(snapped ? snapped.f : frame);
    showTip(snapped ? labelAtFrame(snapped.f) : null);
  };

  const onPointerMove = (event) => {
    const press = pressRef.current;
    if (press && press.id === event.pointerId) {
      press.frame = frameAtPx(pointerX(event), scaleRef.current);
      if (!press.raf) {
        press.raf = requestAnimationFrame(() => {
          press.raf = 0;
          if (press.frame !== null) seek(press.frame);
        });
      }
      return;
    }
    showTip(labelAtPx(pointerX(event)));
  };

  const endPress = (event) => {
    const press = pressRef.current;
    if (!press || press.id !== event.pointerId) return;
    cancelAnimationFrame(press.raf);
    if (press.frame !== null) seek(press.frame);
    pressRef.current = null;
    try {
      inputRef.current?.releasePointerCapture(event.pointerId);
    } catch {
      // released already
    }
    // The native range may have moved under the press; the slider shows the playhead.
    if (inputRef.current && frameBus) inputRef.current.value = String(Math.min(last, Math.max(0, frameBus.get())));
  };

  return (
    <div className={styles.scrubber} data-scrubber="" data-scrubber-state={off ? "off" : "on"}>
      <div ref={trackRef} className={styles.track}>
        <span className={styles.line} aria-hidden="true" />
        {model.coldOpen && width > 0 ? (
          <span className={styles.cold} style={{ width: pxAtFrame(model.coldOpen.f1, scale) }} aria-hidden="true"
            data-scrubber-cold="" data-f1={model.coldOpen.f1} />
        ) : null}
        {width > 0 ? groups.map((group) => (
          <span key={group.key} className={`${styles.mark} ${group.kind === "laughter" ? styles.laugh : styles.pause}`}
            style={{ left: group.x }} aria-hidden="true" data-scrubber-mark="" data-kind={group.kind} data-f={group.f}
            data-count={group.marks.length} data-label={group.label} />
        )) : null}
        {model.join && width > 0 ? (
          <span className={`${styles.mark} ${styles.join}`} style={{ left: joinX }} aria-hidden="true" data-scrubber-mark=""
            data-kind="join" data-style={model.join.style} data-sfx={model.join.sfx ? "" : undefined} data-f={model.join.f}
            data-label={`${model.join.text} · ${model.join.time}`} />
        ) : null}
        <span ref={playheadRef} className={styles.playhead} aria-hidden="true" data-scrubber-playhead="" />
        <input
          ref={inputRef}
          type="range"
          className={styles.input}
          min={0}
          max={last}
          step={1}
          defaultValue={0}
          aria-label="Posisi putar"
          aria-describedby={`${ids}-keys`}
          disabled={off}
          onChange={(event) => { if (!pressRef.current) seek(Number(event.currentTarget.value)); }}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPress}
          onPointerCancel={endPress}
          onPointerLeave={() => { if (!pressRef.current) setTip(null); }}
          onBlur={() => setTip(null)}
        />
        {tip ? (
          <span className={styles.tip} style={{ left: tip.x }} data-align={tip.align} aria-hidden="true" data-scrubber-tip="">
            {tip.label}
          </span>
        ) : null}
      </div>
      <p id={`${ids}-keys`} className={styles.srOnly}>PageUp dan PageDown pindah ke penanda; Spasi atau K memutar.</p>
      <p className={styles.legend} data-scrubber-legend="">
        {legendItems(model).map((name) => (
          <span key={name} className={styles.legendItem}>
            <span className={`${styles.swatch} ${styles[`swatch_${SWATCH[name]}`]}`} data-style={name === "Transisi" ? model.join?.style : undefined}
              aria-hidden="true" />
            {name}
          </span>
        ))}
      </p>
      {note ? <p className={styles.note} data-scrubber-note="">{note}</p> : null}
    </div>
  );
}
