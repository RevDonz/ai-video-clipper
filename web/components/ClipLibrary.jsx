"use client";

// The "Klip" tab of Proyek: every clip of every finished project as the project page's poster,
// newest project first, under "Hari ini", "Minggu ini" and "Lebih lama". Search, "Skor 8+" and
// "Minggu ini" ask the server again; "Muat lagi" appends the next page. Each card opens its clip
// in its project (?klip=N). Copy: projects.clips in the catalog.
import { Button, ToggleButton } from "@heroui/react";
import { useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "use-intl";

import {
  clipCardView,
  clipHref,
  groupClipsByDay,
  librarySummary,
  loadClipLibrary,
  mergeClipPages,
  shownSummary,
} from "../lib/clip-library-view.mjs";
import { msg } from "../lib/i18n/descriptor.mjs";
import { localeOfIntl } from "../lib/i18n/locales.mjs";
import { PosterText, PosterThumb, posterFrame } from "./ClipPoster.jsx";
import SearchField from "./ui/SearchField.jsx";
import styles from "./ClipLibrary.module.css";

const SEARCH_DELAY_MS = 250;
const QUERY_LIMIT = 200;
const EMPTY = Object.freeze({ clips: [], matched: 0, total: 0, projects: 0, nextCursor: null, partial: false });
const itemKey = (item) => `${item.jobId}#${item.index}`;

function ClipCard({ item, linkRef, locale }) {
  const t = useTranslations();
  const view = clipCardView(item, new Date(), locale);
  const base = `riwayat-${item.jobId}-${item.index}`;
  const note = [view.project, view.day].filter(Boolean).join(" · ");
  return (
    <li>
      <article className={styles.card} aria-labelledby={`${base}-title`}>
        <a ref={linkRef} className={posterFrame} href={clipHref(item)} aria-labelledby={`${base}-title`} aria-describedby={`${base}-meta`}>
          <PosterThumb poster={item.posterUrl} number={view.number} length={view.length} />
          <PosterText titleId={`${base}-title`} title={msg(t, view.title)} pill={view.pill} note={note || null}>
            <span id={`${base}-meta`} className="visuallyHidden">{view.meta.map((part) => msg(t, part)).join(", ")}</span>
          </PosterText>
        </a>
      </article>
    </li>
  );
}

export default function ClipLibrary({ onSummary }) {
  const t = useTranslations();
  const tc = useTranslations("projects.clips");
  const locale = localeOfIntl(useLocale());
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [high, setHigh] = useState(false);
  const [week, setWeek] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [page, setPage] = useState({ state: "loading", reason: null, ...EMPTY });
  const [more, setMore] = useState({ state: "idle", reason: null });
  const moreRequest = useRef(null);
  const linkRefs = useRef(new Map());
  const focusKey = useRef(null);
  const summary = useRef(onSummary);

  useEffect(() => {
    summary.current = onSummary;
  }, [onSummary]);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(input.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [input]);

  // A new search or chip starts again at the first page; what is shown stays until it arrives.
  useEffect(() => {
    const controller = new AbortController();
    moreRequest.current?.abort();
    setMore({ state: "idle", reason: null });
    setPage((previous) => ({ ...previous, state: previous.state === "ready" ? "refreshing" : "loading", reason: null }));
    loadClipLibrary({ query, high, week }, { signal: controller.signal }).then((result) => {
      if (result.type === "redirect") {
        window.location.assign(result.location);
        return;
      }
      const { type: _loaded, ...data } = result;
      // The day groups are drawn against this moment, so "Muat lagi" past midnight regroups nothing.
      setPage({ state: "ready", reason: null, loadedAt: new Date(), ...data });
      summary.current?.(librarySummary(data));
    }).catch((error) => {
      if (error?.name === "AbortError") return;
      setPage({ state: "error", reason: error?.reason ?? null, ...EMPTY });
    });
    return () => controller.abort();
  }, [query, high, week, generation]);

  useEffect(() => () => moreRequest.current?.abort(), []);

  // After "Muat lagi" the focus moves to the first new card, so the keyboard carries on from there.
  useEffect(() => {
    const key = focusKey.current;
    focusKey.current = null;
    if (key) linkRefs.current.get(key)?.focus();
  }, [page.clips]);

  const loadMore = async () => {
    if (more.state === "loading" || !page.nextCursor) return;
    const controller = new AbortController();
    moreRequest.current = controller;
    setMore({ state: "loading", reason: null });
    try {
      const result = await loadClipLibrary({ query, high, week, cursor: page.nextCursor }, { signal: controller.signal });
      if (result.type === "redirect") {
        window.location.assign(result.location);
        return;
      }
      const shown = new Set(page.clips.map(itemKey));
      const first = result.clips.find((item) => !shown.has(itemKey(item)));
      focusKey.current = first ? itemKey(first) : null;
      const { type: _loaded, ...data } = result;
      setPage((previous) => ({ ...previous, ...data, state: "ready", clips: mergeClipPages(previous.clips, data.clips) }));
      setMore({ state: "idle", reason: null });
    } catch (error) {
      if (error?.name === "AbortError") return;
      setMore({ state: "error", reason: error?.reason ?? null });
    }
  };

  const filtered = query !== "" || high || week;
  const showAll = () => {
    setInput("");
    setQuery("");
    setHigh(false);
    setWeek(false);
  };
  const ready = page.state === "ready" || page.state === "refreshing";
  // Nothing at all yet, or nothing for this search and these chips.
  const noClips = page.total === 0 && !filtered;
  const days = groupClipsByDay(page.clips, page.loadedAt);
  const status = page.state === "ready"
    ? (page.matched ? msg(t, shownSummary({ shown: page.clips.length, matched: page.matched })) : noClips ? tc("empty") : tc("notFound"))
    : "";

  return (
    <section aria-label={tc("region")}>
      <div className={styles.tools}>
        <SearchField className={styles.search} value={input} maxLength={QUERY_LIMIT} onChange={setInput} aria-label={tc("search")}>
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input placeholder={tc("searchHint")} />
            <SearchField.ClearButton />
          </SearchField.Group>
        </SearchField>
        <div className={styles.chips} role="group" aria-label={tc("filter")}>
          <ToggleButton isSelected={high} onChange={setHigh}>{tc("score8")}</ToggleButton>
          <ToggleButton isSelected={week} onChange={setWeek}>{tc("thisWeek")}</ToggleButton>
        </div>
      </div>

      <p className="visuallyHidden" role="status" aria-live="polite">{status}</p>

      {ready && page.partial && (
        <div className={styles.notice} role="status">
          <span>{tc("partial")}</span>
          <Button variant="secondary" onPress={() => setGeneration((value) => value + 1)}>{tc("reload")}</Button>
        </div>
      )}

      {page.state === "loading" && (
        <div className={styles.state} role="status" aria-live="polite"><span className="pulse" aria-hidden="true" /><span>{tc("loading")}</span></div>
      )}
      {page.state === "error" && (
        <div className={styles.alert} role="alert">
          <strong>{tc("loadFailed")}</strong>
          {page.reason && <span>{msg(t, page.reason)}</span>}
          <Button variant="secondary" onPress={() => setGeneration((value) => value + 1)}>{t("common.retry")}</Button>
        </div>
      )}
      {ready && page.matched === 0 && noClips && (
        <div className={styles.state}><strong>{tc("empty")}</strong></div>
      )}
      {ready && page.matched === 0 && !noClips && (
        <div className={styles.state}>
          <strong>{tc("notFound")}</strong>
          {filtered && <Button variant="secondary" onPress={showAll}>{tc("showAll")}</Button>}
        </div>
      )}

      {page.clips.length > 0 && (
        <>
          <ul className={styles.days} aria-label={tc("list")} aria-busy={page.state === "refreshing" || undefined}>
            {days.groups.map((group) => (
              <li key={group.key}>
                {days.headings && <h2 id={`riwayat-${group.key}`} className={styles.day}>{msg(t, group.label)}</h2>}
                <ul className={styles.grid} aria-labelledby={days.headings ? `riwayat-${group.key}` : undefined}>
                  {group.items.map((item) => (
                    <ClipCard key={itemKey(item)} item={item} locale={locale} linkRef={(node) => {
                      linkRefs.current.set(itemKey(item), node);
                      return () => linkRefs.current.delete(itemKey(item));
                    }} />
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          <div className={styles.more}>
            <span>{msg(t, shownSummary({ shown: page.clips.length, matched: page.matched }))}</span>
            {page.nextCursor && (
              <Button variant="secondary" isPending={more.state === "loading"} onPress={loadMore}>
                {more.state === "loading" ? tc("loadingMore") : tc("loadMore")}
              </Button>
            )}
            {more.state === "error" && <span className={styles.moreError} role="alert">{tc("loadFailed")}</span>}
          </div>
        </>
      )}
    </section>
  );
}
