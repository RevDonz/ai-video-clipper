import { stageSummaryRows } from "../lib/stage-summary.mjs";
import styles from "./StageSummary.module.css";

/** What each finished stage of `job` found, under its progress bar; nothing when no stage has a result yet. */
export default function StageSummary({ job, className = "" }) {
  const rows = stageSummaryRows(job);
  if (!rows.length) return null;
  return (
    <dl className={`${styles.stageSummary} ${className}`} aria-label="Hasil per tahap">
      {rows.map((row) => (
        <div key={row.key}>
          <dt>{row.label}</dt>
          <dd>{row.text}</dd>
        </div>
      ))}
    </dl>
  );
}
