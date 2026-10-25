"use client";

// A job's process status as one pill (05-ui-dashboard.md §5): Antre · Diproses · Selesai · Gagal ·
// Dibatalkan, from lib/status-view.mjs. Diproses carries the lime progress dot.
import { useTranslations } from "use-intl";

import { processStatus } from "../lib/status-view.mjs";
import styles from "./ProcessStatus.module.css";

export function useProcessStatusText() {
  const t = useTranslations("status");
  const words = {
    queued: t("process.queued"),
    running: t("process.running"),
    completed: t("process.completed"),
    failed: t("process.failed"),
    cancelled: t("process.cancelled"),
    deleting: t("process.deleting"),
    unknown: t("process.unknown"),
  };
  return (job) => words[processStatus(job).key];
}

const PILL_TONES = Object.freeze({ success: "ok", danger: "error" });

export default function ProcessStatus({ job, detail = null, className = "" }) {
  const text = useProcessStatusText();
  const view = processStatus(job);
  return (
    <span className={`statusPill ${PILL_TONES[view.tone] ?? ""} ${className}`.trim()} data-status={view.key}>
      {view.running && <i className={styles.dot} aria-hidden="true" />}
      {text(job)}
      {detail && <> · {detail}</>}
    </span>
  );
}
