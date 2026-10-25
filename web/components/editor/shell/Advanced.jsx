"use client";

// The "Lanjutan" fold of a panel group (rombak 06 §2.1 T2, §2.2): fine controls behind a HeroUI
// Disclosure, closed until the viewer opens it, its title summing up what differs from the AI
// version ("Lanjutan · Pop · 2 kata", or "Lanjutan · Bawaan"). The summary is data from
// lib/editor/disclosure.mjs advancedSummary(group, doc, seed); the panel names each item
// (`labelFor(item)`, from its editor.<tab>.summary.* keys). The open state is remembered per group
// in this browser when it allows it.
import { Disclosure } from "@heroui/react";
import { useState } from "react";
import { useTranslations } from "use-intl";

import { advancedSummary, readDisclosure, writeDisclosure } from "../../../lib/editor/disclosure.mjs";
import { LIST_SEPARATOR } from "../../../lib/i18n/format.mjs";
import styles from "./editor-shell.module.css";

function localStore() {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The summary text of the title: the items' labels joined, or the default word. */
export function summaryText(labels, t) {
  const named = labels.filter((label) => typeof label === "string" && label);
  return named.length ? t("summary", { items: named.join(LIST_SEPARATOR) }) : t("default");
}

export default function Advanced({ group, doc, seed, labelFor, headingLevel = 4, children }) {
  const t = useTranslations("editor.advanced");
  const [open, setOpen] = useState(() => readDisclosure(localStore(), group));
  const { items } = advancedSummary(group, doc, seed);
  const text = summaryText(items.map((item) => labelFor?.(item) ?? null), t);
  return (
    <Disclosure className={styles.advanced} data-advanced={group} isExpanded={open}
      onExpandedChange={(next) => {
        setOpen(next);
        writeDisclosure(localStore(), group, next);
      }}>
      <Disclosure.Heading level={headingLevel} className={styles.advancedHeading}>
        <Disclosure.Trigger className={styles.advancedTrigger}>
          <span>{t("label")}</span>
          <span className={styles.advancedSummary} data-advanced-summary="">{`${LIST_SEPARATOR}${text}`}</span>
          <Disclosure.Indicator className={styles.indicator} />
        </Disclosure.Trigger>
      </Disclosure.Heading>
      <Disclosure.Content>
        <Disclosure.Body className={styles.advancedBody}>{children}</Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>
  );
}
