"use client";

// One valued chip of Buat klip (05-ui-dashboard.md §2 P3, §6.3): a neutral button that reads the
// choice ("3 klip", "9:16 · 720p") and opens a popover with its control. The page keeps which
// chip is open, so only one popover is open at a time and a field error can open its chip.
// The accessible name is "{label}: {value}", which contains the visible text (WCAG 2.5.3);
// React Aria sets aria-expanded on the button.
import { Button, Popover } from "@heroui/react";

import styles from "./ChoiceChip.module.css";

export default function ChoiceChip({ id, label, value, text = value, isOpen, onOpenChange, invalid = false, children }) {
  return (
    <Popover isOpen={isOpen} onOpenChange={onOpenChange}>
      <Button
        variant="secondary"
        id={`chip-${id}`}
        className={styles.chip}
        data-chip={id}
        data-invalid={invalid || undefined}
        aria-label={`${label}: ${value}`}
      >
        <span className={styles.text}>{text}</span>
        <svg className={styles.chevron} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </Button>
      <Popover.Content placement="bottom start" offset={6} className={styles.popover}>
        <Popover.Dialog aria-label={label} className={styles.dialog} data-chip-popover={id}>
          {children}
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}
