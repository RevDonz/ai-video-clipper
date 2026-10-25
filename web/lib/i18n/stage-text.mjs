// A job's stage in the UI language (rombak 07 §10.4): stage.<stageCode> when the coded worker
// (i18n M5) sent a code the catalog knows, else the worker's own stageDetail as it is (old jobs,
// and jobs from a worker without codes). `t` is a translator over the whole catalog
// (useTranslations() without a namespace) whose messages include the `stage` namespace.
import { shownStageDetail } from "../stage-detail.mjs";

const CODE = /^[a-z][a-z0-9_]{0,63}$/;

export function stageText(t, job) {
  const code = typeof job?.stageCode === "string" && CODE.test(job.stageCode) ? job.stageCode : null;
  if (code && t.has(`stage.${code}`)) {
    const params = job.stageParams && typeof job.stageParams === "object" && !Array.isArray(job.stageParams) ? job.stageParams : {};
    return t(`stage.${code}`, params);
  }
  return shownStageDetail(job);
}
