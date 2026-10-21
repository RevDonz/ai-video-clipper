"use client";

// The text watermark in the Logo panel (CONTRACTS §5.43): one line typed once, a place on the 3×3
// grid, its size and its opacity. Every place keeps the line out of the TikTok/Reels buttons, so
// it never needs the zone warning the logo has; a line over the caption gets the plan's warning
// and the place that clears it (CONTRACTS §5.56). Props: { state, dispatch, locked }.
import { useEffect, useId, useRef, useState } from "react";

import { WATERMARK_OPACITY_RANGE, WATERMARK_SIZE_RANGE } from "../../../lib/editor/doc-model.mjs";
import PillGroup from "../ui/PillGroup.jsx";
import styles from "./logo.module.css";
import { logoCaptionNote, runLogoSteps } from "./logo-model.mjs";
import {
  WATERMARK_MAX, WATERMARK_PLACES, cleanWatermarkText, watermarkDraftOnBlur, watermarkOpacityCommand,
  watermarkPlaceCommand, watermarkPoints, watermarkRemoveCommand, watermarkSizeCommand, watermarkTextCommand,
  watermarkView,
} from "./watermark-model.mjs";

export default function WatermarkSection({ state, dispatch, locked }) {
  const view = watermarkView(state);
  const mark = view.watermark;
  const ids = { title: useId(), note: useId(), counter: useId(), place: useId(), size: useId(), opacity: useId() };
  const [draft, setDraft] = useState(mark?.text ?? "");
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [message, setMessage] = useState(null);

  // Undo, redo, a merge or "Hapus teks" changes the text from outside: show it unless it is the draft.
  const stored = mark?.text ?? null;
  useEffect(() => {
    if (cleanWatermarkText(draftRef.current) !== (stored ?? "")) setDraft(stored ?? "");
  }, [stored]);

  if (!view.ready) return null;

  const send = (command) => {
    if (!command) return;
    const refused = runLogoSteps(dispatch, [command]);
    setMessage(refused?.message ?? null);
  };
  const points = watermarkPoints(cleanWatermarkText(draft));
  // The line over the caption (CONTRACTS §5.56): the plan's warning and its one-click move.
  const overCaption = mark ? logoCaptionNote(state.plan, "watermark") : null;

  return (
    <section className={styles.section} aria-labelledby={ids.title} data-watermark="">
      <div className={styles.head}>
        <h3 id={ids.title} className={styles.subtitle}>Teks watermark</h3>
        <p id={ids.note} className={styles.note}>
          Satu baris sepanjang klip, misalnya nama akun Anda. Setiap posisi ada di luar area tombol TikTok/Reels.
        </p>
      </div>
      <div className={styles.textRow}>
        <input type="text" className={styles.input} value={draft} maxLength={WATERMARK_MAX} placeholder="@akun"
          autoComplete="off" spellCheck={false} disabled={locked} aria-labelledby={ids.title}
          aria-describedby={`${ids.note} ${ids.counter}`} data-watermark-text=""
          onChange={(event) => {
            setDraft(event.target.value);
            send(watermarkTextCommand(state.doc, event.target.value));
          }}
          onBlur={() => setDraft((current) => watermarkDraftOnBlur(state.doc, current))} />
        <span id={ids.counter} className={styles.value} data-watermark-counter="">{`${points}/${WATERMARK_MAX}`}</span>
      </div>
      {message ? <p className={`${styles.message} ${styles.error}`} role="alert">{message}</p> : null}

      {mark ? (
        <>
          {view.missingGlyphs.length ? (
            <div className={styles.warning} data-watermark-glyphs="">
              <p>Font watermark tidak punya {view.missingGlyphs.join(", ")}; karakter ini tidak akan tampil di video.</p>
            </div>
          ) : null}
          {overCaption ? (
            <div className={styles.warning} data-logo-caption={overCaption.fix?.id ?? ""} role="status">
              <p>{overCaption.text}</p>
              {overCaption.fix && !locked ? (
                <button type="button" className={styles.button} onClick={() => send(overCaption.fix.command)}>
                  {overCaption.fix.label}
                </button>
              ) : null}
            </div>
          ) : null}
          <div className={styles.field}>
            <span id={ids.place}>Posisi</span>
            <span className={styles.value}>{view.place.name}</span>
          </div>
          <div className={styles.places}>
            <PillGroup legend="Posisi teks watermark" legendHidden name={`${ids.place}-grid`} columns={3} disabled={locked}
              value={mark.pos} onChange={(pos) => send(watermarkPlaceCommand(state.doc, pos))}
              options={WATERMARK_PLACES.map((place) => ({
                id: place.id,
                title: place.name,
                label: (
                  <>
                    <span className={styles.glyph} data-corner={place.id} aria-hidden="true" />
                    <span className={styles.srOnly}>{place.name}</span>
                  </>
                ),
              }))} />
          </div>
          <div className={styles.field}>
            <span id={ids.size}>Ukuran</span>
            <span className={styles.value}>{view.sizeText}</span>
            <input type="range" className={styles.range} min={WATERMARK_SIZE_RANGE[0]} max={WATERMARK_SIZE_RANGE[1]} step={50}
              value={mark.size_pm} disabled={locked} aria-labelledby={`${ids.title} ${ids.size}`} aria-valuetext={view.sizeText}
              onChange={(event) => send(watermarkSizeCommand(state.doc, Number(event.target.value)))} />
          </div>
          <div className={styles.field}>
            <span id={ids.opacity}>Opasitas</span>
            <span className={styles.value}>{view.opacityText}</span>
            <input type="range" className={styles.range} min={WATERMARK_OPACITY_RANGE[0]} max={WATERMARK_OPACITY_RANGE[1]}
              step={10} value={mark.opacity_pm} disabled={locked} aria-labelledby={`${ids.title} ${ids.opacity}`}
              aria-valuetext={view.opacityText}
              onChange={(event) => send(watermarkOpacityCommand(state.doc, Number(event.target.value)))} />
          </div>
          <button type="button" className={`${styles.button} ${styles.danger}`} disabled={locked} data-watermark-remove=""
            onClick={() => send(watermarkRemoveCommand(state.doc))}>
            Hapus teks
          </button>
        </>
      ) : null}
    </section>
  );
}
