"use client";

// One card of an accordion (spec §1.3, §8.2) on HeroUI's Disclosure (React Aria): a heading
// holding a full-width trigger with aria-expanded (label, summary, chevron), and the body as a
// region named by the header's label alone. The body mounts when the card first opens and stays
// mounted after it closes, so a closed card keeps its state; a closed body is inert at once and,
// once its height transition ends, hidden by React Aria (ui.module.css .cardBody).
import { Disclosure } from "@heroui/react";
import { useState } from "react";

import Icon from "./icons.jsx";
import { accordionIds } from "./kit-model.mjs";
import styles from "./ui.module.css";

const LEVELS = new Set([2, 3, 4, 5, 6]);

export default function AccordionCard({ id, label, summary, open, onToggle, children, headingLevel = 2 }) {
  const [mounted, setMounted] = useState(Boolean(open));
  if (open && !mounted) setMounted(true);
  const ids = accordionIds(id);
  return (
    <Disclosure className={styles.card} data-card={id} isExpanded={Boolean(open)}
      onExpandedChange={(expanded) => { if (expanded !== Boolean(open)) onToggle?.(); }}>
      <Disclosure.Heading level={LEVELS.has(headingLevel) ? headingLevel : 2} className={styles.cardHeading}>
        <Disclosure.Trigger id={ids.button} className={styles.cardHeader}>
          <span id={ids.label} className={styles.cardLabel}>{label}</span>
          <span className={styles.cardSummary}>{summary}</span>
          <Icon name="chevron" className={styles.cardChevron} />
        </Disclosure.Trigger>
      </Disclosure.Heading>
      <Disclosure.Content id={ids.region} role="region" className={styles.cardBody}
        data-open={open ? "true" : "false"} inert={!open}
        render={(props) => <div {...props} aria-labelledby={ids.label} />}>
        <div className={styles.cardInner}>
          {mounted ? <div className={styles.cardContent}>{children}</div> : null}
        </div>
      </Disclosure.Content>
    </Disclosure>
  );
}
