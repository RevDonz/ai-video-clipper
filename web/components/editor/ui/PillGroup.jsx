"use client";

// A choice of one (spec §8.2): a fieldset of native radios drawn as pills. Arrows move between
// them as native radios do; a value off the options presses no pill. `legendHidden` keeps the
// group's name for screen readers when the card around it already says it on screen.
import styles from "./ui.module.css";

export default function PillGroup({ legend, name, options, value, onChange, disabled = false, describedBy, columns, legendHidden = false }) {
  return (
    <fieldset className={styles.group} disabled={disabled} aria-describedby={describedBy}>
      <legend className={legendHidden ? styles.srOnly : styles.legend}>{legend}</legend>
      <div className={styles.pills} data-columns={columns ? String(columns) : undefined}
        style={columns ? { "--pill-columns": columns } : undefined}>
        {options.map((option) => (
          <label key={option.id} className={styles.pill} title={option.title}>
            <input type="radio" className={styles.cover} name={name} value={option.id} checked={value === option.id}
              disabled={option.disabled} onChange={() => onChange?.(option.id)} />
            <span>{option.label}</span>
            {option.detail ? <span className={styles.pillDetail}>{option.detail}</span> : null}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
