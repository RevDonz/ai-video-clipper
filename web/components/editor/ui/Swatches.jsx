"use client";

// A colour choice (spec §8.2): React Aria's RadioGroup, each radio a 44 px target around a 28 px
// dot. `options` are `{ value, name }` (CAPTION_SWATCHES); the name is the radio's accessible name.
import { useId } from "react";
import { Label, Radio, RadioGroup } from "react-aria-components";

import { renderWith } from "./dom-props.mjs";
import styles from "./ui.module.css";

export default function Swatches({ legend, name, value, options, onChange, disabled = false, note }) {
  const noteId = useId();
  return (
    <RadioGroup className={styles.group} name={name} orientation="horizontal"
      value={options.some((option) => option.value === value) ? value : null} isDisabled={disabled}
      aria-describedby={note ? noteId : undefined} onChange={(next) => onChange?.(next)}>
      <Label className={styles.legend}>{legend}</Label>
      <div className={styles.swatches}>
        {options.map((option) => (
          <Radio key={option.value} value={option.value} aria-label={option.name} className={styles.swatch}
            render={renderWith("label", { title: option.name })}>
            <span className={styles.dot} style={{ "--swatch": option.value }} aria-hidden="true" />
          </Radio>
        ))}
      </div>
      {note ? <p id={noteId} className={styles.note}>{note}</p> : null}
    </RadioGroup>
  );
}
