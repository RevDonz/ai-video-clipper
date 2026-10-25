"use client";

// "Linimasa detail" (rombak 06 §2.1 T3, §8.6): the lanes, the trim handles and the zoom, folded
// under one button until the viewer opens it. The lanes mount only while it is open; the state is
// remembered in this browser when it allows it.
import { Disclosure } from "@heroui/react";
import { useState } from "react";
import { useTranslations } from "use-intl";

import styles from "./editor-shell.module.css";

export const TIMELINE_KEY = "potongin-editor-timeline";

function readOpen() {
  try {
    return window.localStorage.getItem(TIMELINE_KEY) === "open";
  } catch {
    return false;
  }
}

function writeOpen(open) {
  try {
    window.localStorage.setItem(TIMELINE_KEY, open ? "open" : "closed");
  } catch {
    // blocked storage: the fold still works for this page
  }
}

export default function TimelineDetail({ children }) {
  const t = useTranslations("editor.shell");
  const [open, setOpen] = useState(readOpen);
  return (
    <Disclosure isExpanded={open} onExpandedChange={(next) => { setOpen(next); writeOpen(next); }} data-timeline-detail="">
      <Disclosure.Heading level={2} className={styles.timelineHeading}>
        <Disclosure.Trigger className={styles.timelineTrigger}>
          <span>{t("timeline")}</span>
          <Disclosure.Indicator className={styles.indicator} />
        </Disclosure.Trigger>
      </Disclosure.Heading>
      <Disclosure.Content>
        <Disclosure.Body className={styles.timelineBody}>{open ? children : null}</Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>
  );
}
