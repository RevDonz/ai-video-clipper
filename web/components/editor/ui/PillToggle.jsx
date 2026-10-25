"use client";

// An on/off pill (spec §8.2): React Aria's ToggleButton (aria-pressed), as Frame akhir and Zona
// aman. A press, by pointer or keyboard, calls onClick and then onPressedChange with the new state.
import { ToggleButton } from "react-aria-components";

import { renderWith, splitDomProps } from "./dom-props.mjs";
import styles from "./ui.module.css";

export default function PillToggle({ pressed, onPressedChange, onClick, children, className, disabled = false, ...button }) {
  const { rac, extra } = splitDomProps(button);
  return (
    <ToggleButton {...rac} className={className ? `${styles.toggle} ${className}` : styles.toggle}
      isSelected={Boolean(pressed)} isDisabled={disabled} render={renderWith("button", extra)}
      onChange={() => {
        onClick?.();
        onPressedChange?.(!pressed);
      }}>
      {children}
    </ToggleButton>
  );
}
