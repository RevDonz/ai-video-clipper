"use client";

// A colour choice (spec §8.2): native radios, each a 44 px target around a 28 px dot.
// `options` are `{ value, name }` (CAPTION_SWATCHES); the name is the radio's accessible name.
import { useId } from "react";

import styles from "./ui.module.css";

export default function Swatches({ legend, name, value, options, onChange, disabled = false, note }) {
  const noteId = useId();
  return (
    <fieldset className={styles.group} disabled={disabled} aria-describedby={note ? noteId : undefined}>
      <legend className={styles.legend}>{legend}</legend>
      <div className={styles.swatches}>
        {options.map((option) => (
          <label key={option.value} className={styles.swatch} title={option.name}>
            <input type="radio" className={styles.cover} name={name} value={option.value} aria-label={option.name}
              checked={value === option.value} onChange={() => onChange?.(option.value)} />
            <span className={styles.dot} style={{ "--swatch": option.value }} aria-hidden="true" />
          </label>
        ))}
      </div>
      {note ? <p id={noteId} className={styles.note}>{note}</p> : null}
    </fieldset>
  );
}
