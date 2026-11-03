"use client";

// The parts every tab of the one-layout editor (rombak 06 §8) is built from: a titled group, a
// note, a labelled slider with its value and a 44 px target, and picture cards as a radio group.
// The copy comes from the tabs; these only place it.
import { useId } from "react";
import { Label, Radio, RadioGroup } from "react-aria-components";

import { renderWith } from "../ui/dom-props.mjs";
import styles from "./tabs.module.css";

export function TabGroup({ title, action = null, children, ...rest }) {
  return (
    <div className={styles.group} {...rest}>
      <div className={styles.groupHead}>
        <h3 className={styles.groupTitle}>{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}

export function TabNote({ tone = "note", children, ...rest }) {
  return <p className={tone === "warning" ? styles.warning : styles.note} {...rest}>{children}</p>;
}

/**
 * A slider. `onChange` gets every step; `onRelease` (optional) fires when it is let go, by pointer
 * or key, for a value that is stored once.
 */
export function TabSlider({ label, value, min, max, step = 1, valueText, disabled = false, onChange, onRelease, note = null, extra = null, ...rest }) {
  const id = useId();
  const noteId = `${id}-note`;
  return (
    <div className={styles.slider}>
      <div className={styles.sliderHead}>
        <label htmlFor={id} className={styles.sliderLabel}>{label}</label>
        <output htmlFor={id} className={styles.sliderValue}>{valueText}</output>
        {extra}
      </div>
      <input id={id} type="range" className={styles.range} min={min} max={max} step={step} value={value} disabled={disabled}
        aria-valuetext={valueText} aria-describedby={note ? noteId : undefined} onChange={(event) => onChange(Number(event.target.value))}
        onPointerUp={onRelease} onKeyUp={onRelease} onBlur={onRelease} {...rest} />
      {note ? <p id={noteId} className={styles.note}>{note}</p> : null}
    </div>
  );
}

/**
 * Picture cards, a choice of one: `options` are `{ id, name, note, image }`, or with `thumb`, a
 * node of its own, in place of `image`. The note is the card's description and its hover text.
 */
export function CardGroup({ label, labelHidden = false, name, options, value, onChange, disabled = false, describedBy, columns = 3, ...rest }) {
  const uid = useId();
  return (
    <RadioGroup className={styles.cardGroup} name={name} orientation="horizontal" isDisabled={disabled} aria-describedby={describedBy}
      value={options.some((option) => option.id === value) ? value : null} onChange={(next) => onChange?.(next)} {...rest}>
      <Label className={labelHidden ? styles.srOnly : styles.legend}>{label}</Label>
      <div className={styles.cards} style={{ "--card-columns": columns }}>
        {options.map((option) => (
          <Radio key={option.id} value={option.id} className={styles.card} aria-describedby={`${uid}-${option.id}`}
            data-option={option.id} render={renderWith("label", { title: option.note })}>
            {option.thumb ?? <img className={styles.cardThumb} src={option.image} width={160} height={40} alt="" draggable={false} />}
            <span className={styles.cardName}>{option.name}</span>
            {option.badge ? <span className={styles.cardBadge}>{option.badge}</span> : null}
            <span className={styles.srOnly} id={`${uid}-${option.id}`}>{option.note}</span>
          </Radio>
        ))}
      </div>
    </RadioGroup>
  );
}
