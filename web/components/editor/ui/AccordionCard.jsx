"use client";

// One card of an accordion (spec §1.3, §8.2): a heading holding a full-width button with
// aria-expanded (label, summary, chevron), and the body as a region named by the header's label.
// The body mounts when the card first opens and stays mounted after it closes, so a closed card
// keeps its state; a closed body is inert and, once its height transition ends, hidden
// (ui.module.css .cardBody).
import { useState } from "react";

import Icon from "./icons.jsx";
import { accordionIds } from "./kit-model.mjs";
import styles from "./ui.module.css";

const LEVELS = new Set([2, 3, 4, 5, 6]);

export default function AccordionCard({ id, label, summary, open, onToggle, children, headingLevel = 2 }) {
  const [mounted, setMounted] = useState(Boolean(open));
  if (open && !mounted) setMounted(true);
  const ids = accordionIds(id);
  const Heading = `h${LEVELS.has(headingLevel) ? headingLevel : 2}`;
  return (
    <div className={styles.card} data-card={id}>
      <Heading className={styles.cardHeading}>
        <button type="button" id={ids.button} className={styles.cardHeader} aria-expanded={Boolean(open)}
          aria-controls={ids.region} onClick={onToggle}>
          <span id={ids.label} className={styles.cardLabel}>{label}</span>
          <span className={styles.cardSummary}>{summary}</span>
          <Icon name="chevron" className={styles.cardChevron} />
        </button>
      </Heading>
      <div id={ids.region} role="region" aria-labelledby={ids.label} className={styles.cardBody}
        data-open={open ? "true" : "false"} inert={!open}>
        <div className={styles.cardInner}>
          {mounted ? <div className={styles.cardContent}>{children}</div> : null}
        </div>
      </div>
    </div>
  );
}
