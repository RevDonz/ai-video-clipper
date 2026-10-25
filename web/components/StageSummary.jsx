"use client";

import { useTranslations } from "use-intl";

import { stageSummaryRows } from "../lib/stage-summary.mjs";
import styles from "./StageSummary.module.css";

/** What each finished stage of `job` found, under its progress bar; nothing when no stage has a result yet. */
export default function StageSummary({ job, className = "" }) {
  const t = useTranslations("project");
  const labels = { video: t("summary.video"), transcript: t("summary.transcript"), moments: t("summary.moments"), clips: t("summary.clips") };
  const rows = stageSummaryRows(job);
  if (!rows.length) return null;
  return (
    <dl className={`${styles.stageSummary} ${className}`} aria-label={t("summary.label")}>
      {rows.map((row) => (
        <div key={row.key}>
          <dt>{labels[row.key] ?? row.label}</dt>
          <dd>{row.text}</dd>
        </div>
      ))}
    </dl>
  );
}
