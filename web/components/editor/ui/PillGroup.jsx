"use client";

// A choice of one (spec §8.2): React Aria's RadioGroup, native radios drawn as pills, named by
// its label. Arrows move between them; a value off the options presses no pill and leaves the
// group reachable by Tab. `legendHidden` keeps the group's name for screen readers when the card
// around it already says it on screen.
import { Label, Radio, RadioGroup } from "react-aria-components";

import { renderWith } from "./dom-props.mjs";
import styles from "./ui.module.css";

export default function PillGroup({ legend, name, options, value, onChange, disabled = false, describedBy, columns, legendHidden = false }) {
  return (
    <RadioGroup className={styles.group} name={name} orientation="horizontal"
      value={options.some((option) => option.id === value) ? value : null} isDisabled={disabled}
      aria-describedby={describedBy} onChange={(next) => onChange?.(next)}>
      <Label className={legendHidden ? styles.srOnly : styles.legend}>{legend}</Label>
      <div className={styles.pills} data-columns={columns ? String(columns) : undefined}
        style={columns ? { "--pill-columns": columns } : undefined}>
        {options.map((option) => (
          <Radio key={option.id} value={option.id} isDisabled={option.disabled} className={styles.pill}
            render={renderWith("label", option.title === undefined ? null : { title: option.title })}>
            <span>{option.label}</span>
            {option.detail ? <span className={styles.pillDetail}>{option.detail}</span> : null}
          </Radio>
        ))}
      </div>
    </RadioGroup>
  );
}
