"use client";

// Proyek (05-ui-dashboard.md §6.8): every project as a table (a card list below 768 px) with the
// search, the status filter with counts and the Proyek | Klip tabs kept in the URL; rows open
// their project, ⋯ offers Buka, Edit klip and Hapus, and several rows go at once through one
// confirmation and a toast that says how many went. The list refreshes while a project runs and
// when the browser tab comes back into view.
import { Button, Checkbox, Chip, Dropdown, Skeleton, ToggleButton, ToggleButtonGroup, buttonVariants } from "@heroui/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useFormatter, useTranslations } from "use-intl";

import AppShell from "../../components/AppShell.jsx";
import ClipLibrary from "../../components/ClipLibrary.jsx";
import AlertDialog from "../../components/ui/AlertDialog.jsx";
import PageHead from "../../components/ui/PageHead.jsx";
import SearchField from "../../components/ui/SearchField.jsx";
import Table, { SelectAll, SelectRow } from "../../components/ui/Table.jsx";
import Tabs from "../../components/ui/Tabs.jsx";
import { toast } from "../../components/ui/Toast.jsx";
import { browserStorage, readHistoryView, writeHistoryView } from "../../lib/clip-library-view.mjs";
import { editorHref } from "../../lib/editor/open-clip.mjs";
import { msg } from "../../lib/i18n/descriptor.mjs";
import { notifyJobsChanged } from "../../lib/job-badge.mjs";
import { isActiveStatus, matchesProjectQuery, projectName } from "../../lib/project-view.mjs";
import {
  PROJECT_PAGE_SIZE,
  PROJECT_STATUS_FILTERS,
  deleteProjects,
  deleteToast,
  editableClipIndex,
  matchesStatusFilter,
  parseProjectsQuery,
  projectClipCount,
  projectCounts,
  projectStatusView,
  projectsHref,
} from "../../lib/projects-list-view.mjs";
import { clipPosterUrl } from "../../lib/selection-v3-view.mjs";
import styles from "./projects.module.css";

// While a project is still running, the list is read again on this interval.
const POLL_MS = 5000;
const CLOCK_MS = 60_000;
const SKELETON_ROWS = 6;
const projectHref = (job) => `/projects/${encodeURIComponent(job.id)}`;

function MoreIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor">
      <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}

function StatusPill({ job }) {
  const t = useTranslations();
  const view = projectStatusView(job);
  return (
    <Chip color={view.tone} variant="soft" size="sm" className={styles.pill} data-running={view.running || undefined}>
      <Chip.Label>{msg(t, view.label)}</Chip.Label>
    </Chip>
  );
}

function Poster({ job }) {
  const poster = (Array.isArray(job.clips) ? job.clips : []).map(clipPosterUrl).find(Boolean);
  return (
    <span className={styles.thumb} aria-hidden="true">
      {poster ? <img src={poster} alt="" loading="lazy" decoding="async" /> : null}
    </span>
  );
}

/** ⋯ for one project: Buka, Edit klip (when the project offers it) and Hapus. */
function RowActions({ job, editor, onDelete }) {
  const t = useTranslations("projects");
  const name = projectName(job);
  const index = editableClipIndex(job, editor);
  return (
    <Dropdown>
      <Dropdown.Trigger className={buttonVariants({ variant: "ghost", isIconOnly: true })} aria-label={t("action.more", { name })}>
        <MoreIcon />
      </Dropdown.Trigger>
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu aria-label={t("action.more", { name })} onAction={(key) => { if (key === "delete") onDelete(job); }}>
          <Dropdown.Item id="open" href={projectHref(job)} textValue={t("action.open")}>{t("action.open")}</Dropdown.Item>
          {index !== null && (
            <Dropdown.Item id="edit" href={editorHref(job.id, { index })} textValue={t("action.edit")}>{t("action.edit")}</Dropdown.Item>
          )}
          <Dropdown.Item id="delete" variant="danger" textValue={t("action.delete")}>{t("action.delete")}</Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

function ConfirmDelete({ jobs, busy, onConfirm, onClose }) {
  const t = useTranslations("projects");
  const open = jobs.length > 0;
  const running = jobs.some((job) => isActiveStatus(job.status));
  return (
    <AlertDialog isOpen={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <AlertDialog.Backdrop isDismissable={!busy} isKeyboardDismissDisabled={busy}>
        <AlertDialog.Container size="sm">
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Heading>{t("delete.confirm", { count: jobs.length })}</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p>{t("delete.body")}{running ? ` ${t("delete.running")}` : ""}</p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button variant="tertiary" isDisabled={busy} onPress={onClose}>{t("delete.cancel")}</Button>
              <Button variant="danger" isPending={busy} onPress={onConfirm}>{busy ? t("delete.busy") : t("delete.submit")}</Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  );
}

function ProjectTable({ jobs, editor, now, selected, onSelect, onDelete }) {
  const t = useTranslations("projects");
  const tAll = useTranslations();
  const format = useFormatter();
  const disabled = jobs.filter((job) => job.status === "deleting").map((job) => job.id);
  return (
    <Table className={styles.table}>
      <Table.ScrollContainer>
        <Table.Content
          aria-label={t("list")}
          selectionMode="multiple"
          selectedKeys={selected}
          disabledKeys={disabled}
          onSelectionChange={(keys) => onSelect(keys === "all" ? new Set(jobs.filter((job) => !disabled.includes(job.id)).map((job) => job.id)) : new Set(keys))}
        >
          <Table.Header>
            <Table.Column><SelectAll /></Table.Column>
            <Table.Column isRowHeader>{t("col.title")}</Table.Column>
            <Table.Column>{t("col.status")}</Table.Column>
            <Table.Column>{t("col.clips")}</Table.Column>
            <Table.Column>{t("col.created")}</Table.Column>
            <Table.Column><span className="visuallyHidden">{t("col.actions")}</span></Table.Column>
          </Table.Header>
          <Table.Body items={jobs}>
            {(job) => {
              const clips = projectClipCount(job);
              const created = job.createdAt ? new Date(job.createdAt) : null;
              return (
                <Table.Row id={job.id} href={projectHref(job)} textValue={projectName(job)}>
                  <Table.Cell><SelectRow label={projectName(job)} /></Table.Cell>
                  <Table.Cell>
                    <span className={styles.name}><Poster job={job} /><strong>{projectName(job)}</strong></span>
                  </Table.Cell>
                  <Table.Cell><StatusPill job={job} /></Table.Cell>
                  <Table.Cell className={styles.number}>{clips === null ? tAll("common.unavailable") : clips}</Table.Cell>
                  <Table.Cell className={styles.muted}>
                    {created && !Number.isNaN(created.valueOf())
                      ? <time dateTime={job.createdAt} title={format.dateTime(created, { dateStyle: "medium", timeStyle: "short" })}>{format.relativeTime(created, now)}</time>
                      : tAll("common.unavailable")}
                  </Table.Cell>
                  <Table.Cell>{job.status !== "deleting" ? <RowActions job={job} editor={editor} onDelete={onDelete} /> : null}</Table.Cell>
                </Table.Row>
              );
            }}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>
  );
}

function ProjectCards({ jobs, editor, now, selecting, selected, onSelect, onDelete }) {
  const t = useTranslations("projects");
  const tAll = useTranslations();
  const format = useFormatter();
  const toggle = (id, on) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    onSelect(next);
  };
  return (
    <ul className={styles.cards} aria-label={t("list")}>
      {jobs.map((job) => {
        const clips = projectClipCount(job);
        const created = job.createdAt ? new Date(job.createdAt) : null;
        const name = projectName(job);
        const deleting = job.status === "deleting";
        return (
          <li key={job.id} className={styles.card}>
            {selecting && !deleting && (
              <Checkbox aria-label={t("action.selectProject", { name })} isSelected={selected.has(job.id)} onChange={(on) => toggle(job.id, on)}>
                <Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control></Checkbox.Content>
              </Checkbox>
            )}
            <a className={styles.cardLink} href={projectHref(job)}>
              <Poster job={job} />
              <span className={styles.cardText}>
                <strong>{name}</strong>
                <small>
                  <StatusPill job={job} />
                  {clips !== null && <span>{tAll("projects.clips.shown", { count: clips })}</span>}
                  {created && !Number.isNaN(created.valueOf()) && <time dateTime={job.createdAt}>{format.relativeTime(created, now)}</time>}
                </small>
              </span>
            </a>
            {!deleting && !selecting && <RowActions job={job} editor={editor} onDelete={onDelete} />}
          </li>
        );
      })}
    </ul>
  );
}

function ProjectsSkeleton() {
  return (
    <div className={styles.skeleton} aria-hidden="true">
      {Array.from({ length: SKELETON_ROWS }, (_, index) => <Skeleton key={index} className={styles.skeletonRow} />)}
    </div>
  );
}

function ProjectList({ initialStatus, query, onQuery }) {
  const t = useTranslations("projects");
  const tAll = useTranslations();
  const [jobs, setJobs] = useState([]);
  const [editor, setEditor] = useState(false);
  const [state, setState] = useState("loading");
  const [status, setStatus] = useState(initialStatus);
  const [selected, setSelected] = useState(() => new Set());
  const [selecting, setSelecting] = useState(false);
  const [confirmIds, setConfirmIds] = useState([]);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(PROJECT_PAGE_SIZE);
  const [generation, setGeneration] = useState(0);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    window.history.replaceState(window.history.state, "", projectsHref({ tab: "projects", status, q: query }));
  }, [status, query]);

  useEffect(() => {
    const clock = setInterval(() => setNow(new Date()), CLOCK_MS);
    return () => clearInterval(clock);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    let pollTimer = null;
    const load = async (initial) => {
      clearTimeout(pollTimer);
      if (initial) setState((current) => (current === "ready" ? current : "loading"));
      try {
        const response = await fetch("/api/jobs", { cache: "no-store", signal: controller.signal });
        if (response.status === 401) {
          window.location.assign(`/login?next=${encodeURIComponent("/projects")}`);
          return;
        }
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error("load_failed");
        if (!alive) return;
        const list = Array.isArray(payload.jobs) ? payload.jobs : [];
        setJobs(list);
        setEditor(payload.editor === true);
        setState("ready");
        setNow(new Date());
        if (list.some((job) => isActiveStatus(job.status))) pollTimer = setTimeout(() => load(false), POLL_MS);
      } catch (error) {
        if (!alive || error?.name === "AbortError") return;
        if (initial) setState((current) => (current === "ready" ? current : "error"));
        else pollTimer = setTimeout(() => load(false), POLL_MS);
      }
    };
    load(true);
    // Coming back to the browser tab reads the list again (there is no reload button).
    const onVisible = () => { if (document.visibilityState === "visible") load(false); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      controller.abort();
      clearTimeout(pollTimer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [generation]);

  const counts = useMemo(() => projectCounts(jobs), [jobs]);
  const visible = useMemo(
    () => jobs.filter((job) => matchesStatusFilter(job, status) && matchesProjectQuery(job, query)),
    [jobs, status, query],
  );
  const page = visible.slice(0, shown);
  const chosen = jobs.filter((job) => selected.has(job.id) && job.status !== "deleting");
  const confirming = jobs.filter((job) => confirmIds.includes(job.id));

  useEffect(() => { setShown(PROJECT_PAGE_SIZE); }, [status, query]);

  const askDelete = useCallback((job) => setConfirmIds([job.id]), []);

  async function confirmDelete() {
    const ids = confirming.map((job) => job.id);
    setBusy(true);
    const result = await deleteProjects(ids, async (id) => {
      const response = await fetch(`/api/jobs/${encodeURIComponent(id)}`, { method: "DELETE", cache: "no-store", headers: { Accept: "application/json" } });
      const payload = await response.json().catch(() => ({}));
      // Already gone counts as deleted.
      if (response.status === 404) return { ok: true, removed: true };
      return { ok: response.ok, removed: payload.removed !== false };
    });
    setBusy(false);
    setConfirmIds([]);
    const gone = new Set(result.removed);
    const marked = new Set(result.marked);
    setJobs((current) => current
      .filter((job) => !gone.has(job.id))
      .map((job) => (marked.has(job.id) ? { ...job, status: "deleting", progress: 0 } : job)));
    setSelected((current) => new Set([...current].filter((id) => result.failed.includes(id))));
    if (result.removed.length || result.marked.length) notifyJobsChanged();
    const note = deleteToast(result);
    toast(msg(tAll, note.title), { variant: note.variant });
  }

  const filtered = query.trim() !== "" || status !== "all";
  const filterLabel = {
    all: (count) => t("filter.all", { count }),
    running: (count) => t("filter.running", { count }),
    done: (count) => t("filter.done", { count }),
    failed: (count) => t("filter.failed", { count }),
  };

  return (
    <>
      <div className={styles.tools}>
        <ToggleButtonGroup
          aria-label={t("filter.label")}
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[status]}
          onSelectionChange={(keys) => { const [next] = [...keys]; if (next) setStatus(next); }}
          className={styles.filters}
        >
          {PROJECT_STATUS_FILTERS.map((value) => (
            <ToggleButton key={value} id={value}>{filterLabel[value](counts[value])}</ToggleButton>
          ))}
        </ToggleButtonGroup>
        <Button variant="secondary" className={styles.selectToggle} onPress={() => { setSelecting((on) => !on); setSelected(new Set()); }}>
          {selecting ? t("action.stopSelecting") : t("action.select")}
        </Button>
      </div>

      {chosen.length > 0 && (
        <div className={styles.selection} role="region" aria-label={t("selection.count", { count: chosen.length })}>
          <span>{t("selection.count", { count: chosen.length })}</span>
          <Button variant="danger" onPress={() => setConfirmIds(chosen.map((job) => job.id))}>{t("selection.delete", { count: chosen.length })}</Button>
        </div>
      )}

      {state === "loading" && <><span className="visuallyHidden" role="status">{t("loading")}</span><ProjectsSkeleton /></>}
      {state === "error" && (
        <div className={styles.alert} role="alert">
          <strong>{t("loadFailed")}</strong>
          <Button variant="secondary" onPress={() => setGeneration((value) => value + 1)}>{tAll("common.retry")}</Button>
        </div>
      )}
      {state === "ready" && jobs.length === 0 && (
        <div className={styles.state}>
          <h2>{t("empty")}</h2>
          <a className={buttonVariants({ variant: "secondary" })} href="/dashboard">{t("create")}</a>
        </div>
      )}
      {state === "ready" && jobs.length > 0 && visible.length === 0 && (
        <div className={styles.state}>
          <h2>{t("notFound")}</h2>
          {filtered && <Button variant="secondary" onPress={() => { onQuery(""); setStatus("all"); }}>{t("showAll")}</Button>}
        </div>
      )}
      <p className="visuallyHidden" role="status" aria-live="polite">
        {state === "ready" && filtered && visible.length > 0 ? t("found", { count: visible.length }) : ""}
      </p>

      {page.length > 0 && (
        <>
          <div className={styles.wide}>
            <ProjectTable jobs={page} editor={editor} now={now} selected={selected} onSelect={setSelected} onDelete={askDelete} />
          </div>
          <div className={styles.narrow}>
            <ProjectCards jobs={page} editor={editor} now={now} selecting={selecting} selected={selected} onSelect={setSelected} onDelete={askDelete} />
          </div>
          {visible.length > page.length && (
            <div className={styles.more}>
              <Button variant="secondary" onPress={() => setShown((value) => value + PROJECT_PAGE_SIZE)}>{t("loadMore")}</Button>
            </div>
          )}
        </>
      )}

      <ConfirmDelete jobs={confirming} busy={busy} onConfirm={confirmDelete} onClose={() => setConfirmIds([])} />
    </>
  );
}

export default function ProjectsPage() {
  const t = useTranslations("projects");
  // "projects" or "clips"; null until the URL and the remembered choice are read (the browser only).
  const [tab, setTab] = useState(null);
  const [initialStatus, setInitialStatus] = useState("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    const parsed = parseProjectsQuery(window.location.search);
    setInitialStatus(parsed.status);
    setQuery(parsed.q);
    setTab(parsed.tab ?? readHistoryView(browserStorage()) ?? "projects");
  }, []);

  const chooseTab = (next) => {
    if (next !== "projects" && next !== "clips") return;
    setTab(next);
    writeHistoryView(browserStorage(), next);
    if (next === "clips") window.history.replaceState(window.history.state, "", projectsHref({ tab: "clips" }));
  };

  return (
    <AppShell current="/projects">
      <div className={`shell ${styles.page}`}>
        <PageHead title={t("title")}>
          {tab === "projects" && (
            <SearchField className={styles.search} value={query} onChange={setQuery} aria-label={t("search")}>
              <SearchField.Group>
                <SearchField.SearchIcon />
                <SearchField.Input placeholder={t("searchHint")} />
                <SearchField.ClearButton />
              </SearchField.Group>
            </SearchField>
          )}
          <a className={`${buttonVariants({ variant: "secondary" })} ${styles.create}`} href="/dashboard">{t("create")}</a>
        </PageHead>

        {tab === null ? <ProjectsSkeleton /> : (
          <Tabs selectedKey={tab} onSelectionChange={chooseTab} className={styles.tabs}>
            <Tabs.List aria-label={t("tab.label")}>
              <Tabs.Tab id="projects">{t("tab.projects")}</Tabs.Tab>
              <Tabs.Tab id="clips">{t("tab.clips")}</Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel id="projects">
              <ProjectList initialStatus={initialStatus} query={query} onQuery={setQuery} />
            </Tabs.Panel>
            <Tabs.Panel id="clips">
              <ClipLibrary />
            </Tabs.Panel>
          </Tabs>
        )}
      </div>
    </AppShell>
  );
}
