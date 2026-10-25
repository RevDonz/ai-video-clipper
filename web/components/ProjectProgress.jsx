"use client";

// The progress panel of a running project (05-ui-dashboard.md §6.4): "Diproses · <tahap>" and the
// percent over a progress bar, the stepper Unduh · Transkrip · Pilih momen · Render, where the
// job waits in the queue, how many clips are ready (announced as they come), what each finished
// stage found, and Batalkan. Shown only while the job is queued or running.
import { ProgressBar } from "@heroui/react";
import { useTranslations } from "use-intl";

import { stageText } from "../lib/i18n/stage.mjs";
import { jobCancellable } from "../lib/job-cancel.mjs";
import { etaMinutes, progressSteps, queueView, readyCount } from "../lib/project-progress.mjs";
import { projectProgress } from "../lib/project-view.mjs";
import CancelJob from "./CancelJob.jsx";
import ProcessStatus from "./ProcessStatus.jsx";
import styles from "./ProjectProgress.module.css";
import StageSummary from "./StageSummary.jsx";

function useStepNames() {
  const t = useTranslations("project");
  return { download: t("step.download"), transcript: t("step.transcript"), moments: t("step.moments"), render: t("step.render") };
}

export default function ProjectProgress({ job, onCancelSettled }) {
  const t = useTranslations("project");
  const tAll = useTranslations();
  const stepNames = useStepNames();
  const steps = progressSteps(job) ?? [];
  const progress = projectProgress(job);
  const queue = queueView(job);
  const ready = readyCount(job);
  const stage = job.status === "queued" ? null : stageText(tAll, job);
  const queueText = queue?.held === "maintenance" ? null
    : queue && queue.etaSeconds !== null ? t("progress.queuePos", { n: queue.position, minutes: etaMinutes(queue.etaSeconds) })
      : queue ? t("progress.queuePosOnly", { n: queue.position }) : null;
  const detail = queue?.held === "maintenance" ? t("progress.maintenance") : stage;

  return (
    <section className={styles.panel} aria-labelledby="progress-title" data-progress-panel="">
      <div className={styles.head}>
        <h2 id="progress-title" className={styles.title}>
          <ProcessStatus job={job} detail={detail} className={styles.status} />
        </h2>
        <b className={styles.percent} aria-hidden="true">{progress}%</b>
      </div>
      <ProgressBar value={progress} aria-labelledby="progress-title" className={styles.bar}>
        <ProgressBar.Track><ProgressBar.Fill /></ProgressBar.Track>
      </ProgressBar>
      {steps.length > 0 && (
        <ol className={styles.steps} aria-label={t("progress.steps")}>
          {steps.map((step) => (
            <li key={step.id} data-state={step.state} aria-current={step.state === "current" ? "step" : undefined}>
              <i aria-hidden="true" />
              <span>{stepNames[step.id]}</span>
              {step.state === "done" && <span className="visuallyHidden">{t("progress.done")}</span>}
            </li>
          ))}
        </ol>
      )}
      <div className={styles.foot}>
        {queueText && <span className={styles.queue}>{queueText}</span>}
        <span className={styles.ready} role="status" aria-live="polite">{ready > 0 ? t("progress.ready", { count: ready }) : ""}</span>
        {jobCancellable(job) && <CancelJob key={job.id} job={job} next={`/projects/${job.id}`} onSettled={onCancelSettled} />}
      </div>
      <StageSummary job={job} className={styles.summary} />
    </section>
  );
}
