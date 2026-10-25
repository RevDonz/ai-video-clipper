"use client";

// "Terbaru" under the composer (05-ui-dashboard.md §6.3): the four newest projects as posters
// that open their project. Loading shows four poster-shaped skeletons; with no project yet the
// section is not drawn; a failed read says so with Coba lagi (P8).
import { Button, Skeleton } from "@heroui/react";
import { useTranslations } from "use-intl";

import ProcessStatus from "../../components/ProcessStatus.jsx";
import { readyClips } from "../../lib/clip-status.mjs";
import { projectName } from "../../lib/project-view.mjs";
import { clipPosterUrl } from "../../lib/selection-v3-view.mjs";
import styles from "./dashboard.module.css";

export default function RecentProjects({ recent, onRetry }) {
  const t = useTranslations("dashboard");
  if (recent.state === "ready" && !recent.jobs.length) return null;
  return (
    <section className={styles.recent} aria-labelledby="recent-title">
      <div className={styles.recentHead}>
        <h2 id="recent-title">{t("recent")}</h2>
        <a className={styles.textLink} href="/projects">{t("allProjects")}</a>
      </div>
      {recent.state === "error" && (
        <div className={styles.loadError} role="alert">
          <span>{t("recentFailed")}</span>
          <Button variant="secondary" onPress={onRetry}>{t("retry")}</Button>
        </div>
      )}
      {recent.state !== "error" && (
        <ul className={styles.recentList} aria-busy={recent.state === "loading" || undefined}>
          {recent.state === "loading"
            ? [0, 1, 2, 3].map((slot) => <li key={slot}><Skeleton className={styles.recentSkeleton} /></li>)
            : recent.jobs.map((job) => {
              const clips = readyClips(job.clips);
              const poster = clips.map(clipPosterUrl).find(Boolean);
              return (
                <li key={job.id}>
                  <a className={styles.recentCard} href={`/projects/${encodeURIComponent(job.id)}`}>
                    <span className={styles.recentPoster}>
                      {poster ? <img src={poster} alt="" loading="lazy" decoding="async" /> : <i aria-hidden="true" />}
                    </span>
                    <span className={styles.recentName}>{projectName(job)}</span>
                    <span className={styles.recentMeta}>
                      <ProcessStatus job={job} />
                      {clips.length > 0 && <span>{t("chip.count", { count: clips.length })}</span>}
                    </span>
                  </a>
                </li>
              );
            })}
        </ul>
      )}
    </section>
  );
}
