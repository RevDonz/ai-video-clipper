"use client";

// An on/off setting (spec §8.2): React Aria's Switch, a visually hidden checkbox with
// role="switch" inside its visible label, the track drawn beside the text. `title` repeats on
// hover why a disabled switch is off.
import { Switch as AriaSwitch } from "react-aria-components";

import { renderWith } from "./dom-props.mjs";
import styles from "./ui.module.css";

export default function Switch({ label, checked, onChange, disabled = false, describedBy, title }) {
  return (
    <AriaSwitch className={styles.switch} isSelected={Boolean(checked)} isDisabled={disabled} aria-describedby={describedBy}
      onChange={(value) => onChange?.(value)} render={renderWith("label", title === undefined ? null : { title })}>
      <span>{label}</span>
      <span className={styles.switchTrack} aria-hidden="true" />
    </AriaSwitch>
  );
}
