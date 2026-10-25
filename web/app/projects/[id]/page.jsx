"use client";

// One project (05-ui-dashboard.md §6.4): ← Proyek, its name with [Unduh semua] and ⋯ (Proses
// ulang, Hapus proyek), one line of facts, the progress panel while it runs, its notices, and
// the clips, which appear as they render. A poster opens the clip viewer, kept in the address as
// ?klip=N (N is the clip number) through history.replaceState, so a link opens that clip.
import { Alert, Button, Dropdown, Skeleton, buttonVariants } from "@heroui/react";
import { use, useEffect, useRef, useState } from "react";
import { useFormatter, useTranslations } from "use-intl";

import AppShell from "../../../components/AppShell.jsx";
import ProcessStatus from "../../../components/ProcessStatus.jsx";
import ProjectProgress from "../../../components/ProjectProgress.jsx";
import PageHead from "../../../components/ui/PageHead.jsx";
import { formatSize } from "../../../lib/clip-download.mjs";
import { entriesExporting, loadClipEntries } from "../../../lib/clip-entry-view.mjs";
import { readyClips } from "../../../lib/clip-status.mjs";
import { replaceClip } from "../../../lib/clip-text.mjs";
import { jobHelpHref } from "../../../lib/help-catalog.mjs";
import { msg } from "../../../lib/i18n/descriptor.mjs";
import { stageText, warningText } from "../../../lib/i18n/stage.mjs";
import { failureDetail, failureHint, isActiveStatus, loadProjectDetail, projectName, projectStageText } from "../../../lib/project-view.mjs";
import { checkZip, clipFromParam, withClipParam } from "../../../lib/project-workspace.mjs";
import { clipCaptionText, focusSummaryLine, formatTimestamp, selectionNotices } from "../../../lib/selection-v3-view.mjs";
import { videoLanguageNotice } from "../../../lib/source-language.mjs";
import { sanitizeStageSummary } from "../../../lib/stage-summary.mjs";
import ClipsSection from "./ClipsSection.jsx";
import DeleteProject from "./DeleteProject.jsx";
import focusStyles from "./focus.module.css";
import styles from "./project.module.css";

// A running job is re-read on this interval until it finishes.
const POLL_MS = 5000;
// While an export runs the clips listing is read again (one Python call each), for 10 minutes
// at most after the page or a switch asked for it.
const EXPORT_POLL_MS = 8000;
const EXPORT_POLLS = 75;
const COPY_RESET_MS = 2200;
const NO_SEARCH = Promise.resolve({});
const RERUN = "rerun";
const DELETE = "delete";

// A notice's title, text and action are descriptors (or the page's own strings).
function Notice({ notice, helpLabel }) {
  const tAll = useTranslations();
  const title = msg(tAll, notice.title);
  const action = msg(tAll, notice.action);
  return (
    <div className={`notice ${notice.tone}`}>
      {title && <strong>{title}</strong>}
      <span>{msg(tAll, notice.text)}</span>
      {(notice.href || notice.help) && (
        <span className={styles.noticeLinks}>
          {notice.help && <a className={styles.noticeLink} href={notice.help}>{helpLabel}</a>}
          {notice.href && <a className={styles.noticeLink} href={notice.href}>{action}</a>}
        </span>
      )}
    </div>
  );
}

// Fokus klip: "Fokus: jomok, jomokers · 5 dari 8 klip cocok". Nothing for jobs without focus.
function FocusSummary({ job }) {
  const t = useTranslations("project");
  const tAll = useTranslations();
  const view = focusSummaryLine(job);
  if (!view) return null;
  return (
    <p className={focusStyles.focusLine}>
      <span className={focusStyles.label}>{t("focus")}</span> {view.termsText}
      {view.countText && <> · <strong>{msg(tAll, view.countText)}</strong></>}
    </p>
  );
}

// Starts a same-origin download without leaving the page (the route answers as an attachment).
function saveFile(href, filename) {
  const link = document.createElement("a");
  link.href = href;
  if (filename) link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
}

/** The ZIP of all or some clips: the route is asked first, so a refusal reads as a message. */
function useZip(job) {
  const t = useTranslations("project");
  const [zip, setZip] = useState({ state: "idle", message: "" });
  const request = useRef(null);
  useEffect(() => () => request.current?.abort(), []);
  const download = async (indexes) => {
    if (zip.state === "checking") return false;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setZip({ state: "checking", message: t("zip.checking") });
    let result;
    try {
      result = await checkZip(job.id, indexes, { signal: controller.signal });
    } catch {
      return false;
    }
    if (controller.signal.aborted) return false;
    if (result.type === "redirect") {
      window.location.assign(result.location);
      return false;
    }
    if (result.type === "error") {
      setZip({ state: "error", message: result.message });
      return false;
    }
    saveFile(result.href, result.filename);
    setZip({ state: "started", message: t("zip.started", { count: result.count, size: formatSize(result.bytes) }) });
    return true;
  };
  return { zip, download };
}

function ProjectMeta({ job }) {
  const t = useTranslations("project");
  const format = useFormatter();
  const created = job.createdAt ? new Date(job.createdAt) : null;
  const when = created && !Number.isNaN(created.valueOf()) ? format.relativeTime(created) : null;
  const clips = readyClips(job.clips).length;
  const duration = formatTimestamp(sanitizeStageSummary(job.stageSummary)?.video?.duration);
  const source = job.source?.type === "youtube" ? t("source.youtube") : t("source.file");
  return (
    <p className={styles.meta}>
      <ProcessStatus job={job} />
      <span>{source}</span>
      {when && <time dateTime={job.createdAt}>{when}</time>}
      {clips > 0 && <span>{t("clipCount", { count: clips })}</span>}
      {duration && <span>{duration}</span>}
      {job.source?.type === "youtube" && job.source.url && (
        <a href={job.source.url} target="_blank" rel="noopener noreferrer">{t("source.open")}<span className="visuallyHidden"> {t("newTab")}</span></a>
      )}
    </p>
  );
}

function ProjectView({ job, entries, viewing, onView, copyState, onCopy, cancelNote, onCancelSettled, onClipSaved, onEntriesChanged }) {
  const t = useTranslations("project");
  const tAll = useTranslations();
  const [deleting, setDeleting] = useState(false);
  const { zip, download } = useZip(job);
  const active = isActiveStatus(job.status);
  const languageNotice = videoLanguageNotice(job);
  const notices = [...(languageNotice ? [languageNotice] : []), ...selectionNotices(job, { label: (code) => warningText(tAll, code) })];
  const serverError = failureDetail(job);
  // A coded failure (download, typed range) reads from its code; any other from the stage code
  // (stopped_error, storage_insufficient, …) in the UI language, else the worker's own line.
  const failureText = (job.errorCode ? null : stageText(tAll, job)) || msg(tAll, projectStageText(job));
  const hint = msg(tAll, failureHint(job)) || null;
  const help = jobHelpHref(job);
  const rerunHref = `/dashboard?ulang=${encodeURIComponent(job.id)}`;
  const clipCount = Array.isArray(job.clips) ? job.clips.length : 0;
  const downloadable = job.status === "completed" && readyClips(job.clips).length > 0;

  return (
    <div className={`shell ${styles.page}`}>
      <a className={styles.back} href="/projects"><span aria-hidden="true">←</span> {t("back")}</a>
      <PageHead title={projectName(job)} id="project-title">
        {downloadable && (
          <Button variant="primary" className={styles.downloadAll} isPending={zip.state === "checking"} onPress={() => download(null)}>
            {t("downloadAll")}
          </Button>
        )}
        <Dropdown>
          <Dropdown.Trigger className={`${buttonVariants({ variant: "secondary", isIconOnly: true })} ${styles.more}`} aria-label={t("more")}>
            <span aria-hidden="true">⋯</span>
          </Dropdown.Trigger>
          <Dropdown.Popover placement="bottom end">
            <Dropdown.Menu aria-label={t("more")} onAction={(key) => { if (key === DELETE) setDeleting(true); }}>
              <Dropdown.Item id={RERUN} href={rerunHref} textValue={t("rerun")}>{t("rerun")}</Dropdown.Item>
              <Dropdown.Item id={DELETE} variant="danger" textValue={t("delete.action")}>{t("delete.action")}</Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      </PageHead>
      <ProjectMeta job={job} />
      <DeleteProject job={job} isOpen={deleting} onOpenChange={setDeleting} />

      {active && <ProjectProgress job={job} onCancelSettled={onCancelSettled} />}

      {job.status === "cancelled" && (
        <div className={`notice ${styles.cancelled}`}>
          <strong id="cancelled-title" tabIndex={-1}>{t("cancelled")}</strong>
          <span className={styles.noticeLinks}>
            <a className={styles.noticeLink} href={rerunHref}>{t("rerun")}</a>
          </span>
        </div>
      )}
      {cancelNote && <p id="cancel-note" tabIndex={-1} className={`notice ${styles.cancelled}`} role="status">{cancelNote}</p>}

      {job.status === "failed" && (
        <Alert status="danger" className={styles.failed}>
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{t("failed")}</Alert.Title>
            <Alert.Description>{failureText}</Alert.Description>
            {hint && <Alert.Description>{hint}</Alert.Description>}
            <span className={styles.noticeLinks}>
              {help && <a className={styles.noticeLink} href={help}>{t("help")}</a>}
              <a className={styles.noticeLink} href={rerunHref}>{t("rerun")}</a>
            </span>
            {serverError && (
              <details className={styles.errorDetail}>
                <summary>{t("detail")}</summary>
                <span>{serverError}</span>
              </details>
            )}
          </Alert.Content>
        </Alert>
      )}

      {notices.length > 0 && <div className={styles.notices}>{notices.map((notice) => <Notice key={`${notice.tone}:${msg(tAll, notice.text)}`} notice={notice} helpLabel={t("help")} />)}</div>}
      <FocusSummary job={job} />

      <p className={styles.zipStatus} role="status" aria-live="polite">{zip.state === "error" ? "" : zip.message}</p>
      {zip.state === "error" && <div className={`notice error ${styles.zipError}`} role="alert">{zip.message}</div>}

      {job.status === "completed" && clipCount === 0 ? (
        <section className={styles.empty} aria-labelledby="clips-title">
          <h2 id="clips-title">{t("noClips")}</h2>
          <a className={buttonVariants({ variant: "secondary" })} href={rerunHref}>{t("rerun")}</a>
        </section>
      ) : (
        <ClipsSection job={job} entries={entries} zip={zip} onDownload={download} viewing={viewing} onView={onView}
          copyState={copyState} onCopy={onCopy} onClipSaved={onClipSaved} onEntriesChanged={onEntriesChanged} />
      )}
    </div>
  );
}

function LoadingProject() {
  const t = useTranslations("project");
  return (
    <div className={`shell ${styles.page}`} role="status" aria-label={t("loading")}>
      <Skeleton className={styles.skeletonTitle} />
      <Skeleton className={styles.skeletonLine} />
      <ul className={styles.posterGrid} aria-hidden="true">
        {[0, 1, 2, 3].map((slot) => <li key={slot}><Skeleton className={styles.skeletonPoster} /></li>)}
      </ul>
    </div>
  );
}

function LoadFailed({ error, onRetry }) {
  const t = useTranslations("project");
  const missing = error.kind === "not-found";
  return (
    <section className={`shell ${styles.state}`} role="alert">
      <h1>{missing ? t("notFound") : t("loadFailed")}</h1>
      <div>
        {!missing && <Button variant="secondary" onPress={onRetry}>{t("retry")}</Button>}
        <a className={buttonVariants({ variant: "secondary" })} href="/projects">{t("back")}</a>
      </div>
    </section>
  );
}

export default function ProjectPage({ params, searchParams }) {
  const { id } = use(params);
  const initialClip = clipFromParam(use(searchParams ?? NO_SEARCH)?.klip);
  const [job, setJob] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [generation, setGeneration] = useState(0);
  const [viewing, setViewing] = useState(initialClip);
  const [copyState, setCopyState] = useState({ index: null, what: null, status: "" });
  const [entries, setEntries] = useState(() => ({ state: "idle", byIndex: new Map() }));
  const [entriesVersion, setEntriesVersion] = useState(0);
  const exportPolls = useRef(0);
  const [cancelNote, setCancelNote] = useState(null);
  const copyTimer = useRef(null);
  const pendingFocus = useRef(null);
  const editable = job?.status === "completed" && Array.isArray(job?.clips) && job.clips.length > 0;

  useEffect(() => () => {
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let pollTimer = null;
    const load = async (initial) => {
      if (initial) {
        setLoading(true);
        setJob(null);
        setError(null);
      }
      try {
        const result = await loadProjectDetail(id, { signal: controller.signal });
        if (!active) return;
        if (result.type === "redirect") {
          window.location.assign(result.location);
          return;
        }
        // A poll sent before "Batalkan" answered must not bring the finished job back to life.
        setJob((current) => (current?.id === result.job.id && !isActiveStatus(current.status) && isActiveStatus(result.job.status)
          ? current
          : result.job));
        if (isActiveStatus(result.job.status)) pollTimer = setTimeout(() => load(false), POLL_MS);
      } catch (loadError) {
        if (!active || loadError?.name === "AbortError") return;
        // A failed poll keeps the page as it is and tries again; only the first load shows the error.
        if (initial) setError({ kind: loadError?.kind || "request" });
        else pollTimer = setTimeout(() => load(false), POLL_MS);
      } finally {
        if (active && initial) setLoading(false);
      }
    };
    load(true);
    return () => {
      active = false;
      controller.abort();
      if (pollTimer !== null) clearTimeout(pollTimer);
    };
  }, [id, generation]);

  useEffect(() => {
    if (job) document.title = `${projectName(job)} · Potongin`;
  }, [job]);

  // The open clip lives in the address (?klip=N) without a navigation.
  useEffect(() => {
    const search = withClipParam(window.location.search, viewing);
    if (search !== window.location.search) window.history.replaceState(window.history.state, "", `${window.location.pathname}${search}${window.location.hash}`);
  }, [viewing]);

  // After "Batalkan" focus moves to what replaced the progress panel.
  useEffect(() => {
    if (!pendingFocus.current) return;
    const target = document.getElementById(pendingFocus.current);
    if (!target) return;
    pendingFocus.current = null;
    target.focus();
  });

  // A saved title and description: the clip as the job now serves it (posters, downloads, copy).
  const onClipSaved = (clip) => setJob((current) => replaceClip(current, clip));

  const settleCancel = (next, note) => {
    setJob(next);
    setCancelNote(note);
    pendingFocus.current = note ? "cancel-note" : "cancelled-title";
  };

  // The editor entries come from the clips listing, which answers only when the editor is on (a
  // 404 leaves the cards as they are). A reload (after "Hook di video", or while an export runs)
  // keeps the entries it has when the listing does not answer.
  useEffect(() => {
    if (!editable) return undefined;
    const controller = new AbortController();
    let active = true;
    loadClipEntries(id, { signal: controller.signal }).then((result) => {
      if (!active) return;
      if (result.state === "redirect") window.location.assign(result.location);
      else if (entriesVersion === 0 || result.state === "available") setEntries(result);
    }).catch(() => {});
    return () => {
      active = false;
      controller.abort();
    };
  }, [id, editable, generation, entriesVersion]);

  const reloadEntries = () => {
    exportPolls.current = 0;
    setEntriesVersion((value) => value + 1);
  };

  // An export still running: read the listing again until it has finished or failed.
  useEffect(() => {
    if (!entriesExporting(entries) || exportPolls.current >= EXPORT_POLLS) return undefined;
    const timer = setTimeout(() => {
      exportPolls.current += 1;
      setEntriesVersion((value) => value + 1);
    }, EXPORT_POLL_MS);
    return () => clearTimeout(timer);
  }, [entries]);

  // `what`: "title" copies the title alone, "caption" the whole post text.
  const copyText = async (clip, what) => {
    let status = "copied";
    try {
      await navigator.clipboard.writeText(what === "title" ? clip.title || "" : clipCaptionText(clip));
    } catch {
      status = "failed";
    }
    setCopyState({ index: clip.index, what, status });
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => {
      copyTimer.current = null;
      setCopyState({ index: null, what: null, status: "" });
    }, COPY_RESET_MS);
  };

  return (
    <AppShell current="/projects">
      {loading && <LoadingProject />}
      {!loading && error && <LoadFailed error={error} onRetry={() => setGeneration((value) => value + 1)} />}
      {!loading && job && (
        <ProjectView
          job={job}
          entries={entries}
          viewing={viewing}
          onView={setViewing}
          copyState={copyState}
          onCopy={copyText}
          cancelNote={cancelNote}
          onCancelSettled={settleCancel}
          onClipSaved={onClipSaved}
          onEntriesChanged={reloadEntries}
        />
      )}
    </AppShell>
  );
}
