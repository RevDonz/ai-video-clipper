"use client";

// The "Klip" view of Riwayat: every clip of every finished project as the project page's poster,
// newest project first, under "Hari ini", "Minggu ini" and "Lebih lama". Search, "Skor 8+" and
// "Minggu ini" ask the server again; "Muat lagi" appends the next page. Each card opens its clip in
// its project.
import { useEffect, useRef, useState } from "react";

import {
  clipCardView,
  clipHref,
  groupClipsByDay,
  librarySummary,
  loadClipLibrary,
  mergeClipPages,
  shownSummary,
} from "../lib/clip-library-view.mjs";
import { PosterText, PosterThumb, posterFrame } from "./ClipPoster.jsx";
import styles from "./ClipLibrary.module.css";

const SEARCH_DELAY_MS = 250;
const QUERY_LIMIT = 200;
const EMPTY = Object.freeze({ clips: [], matched: 0, total: 0, projects: 0, nextCursor: null, partial: false });
const itemKey = (item) => `${item.jobId}#${item.index}`;

function ClipCard({ item, linkRef }) {
  const view = clipCardView(item);
  const base = `riwayat-${item.jobId}-${item.index}`;
  const note = [view.project, view.day].filter(Boolean).join(" · ");
  return (
    <li>
      <article className={styles.card} aria-labelledby={`${base}-title`}>
        <a ref={linkRef} className={posterFrame} href={clipHref(item)} aria-labelledby={`${base}-title`} aria-describedby={`${base}-meta`}>
          <PosterThumb poster={item.posterUrl} number={view.number} length={view.length} />
          <PosterText titleId={`${base}-title`} title={view.title} pill={view.pill} note={note || null}>
            <span id={`${base}-meta`} className="visuallyHidden">{view.meta}</span>
          </PosterText>
        </a>
      </article>
    </li>
  );
}

export default function ClipLibrary({ onSummary }) {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [high, setHigh] = useState(false);
  const [week, setWeek] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [page, setPage] = useState({ state: "loading", error: "", ...EMPTY });
  const [more, setMore] = useState({ state: "idle", error: "" });
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
    setMore({ state: "idle", error: "" });
    setPage((previous) => ({ ...previous, state: previous.state === "ready" ? "refreshing" : "loading", error: "" }));
    loadClipLibrary({ query, high, week }, { signal: controller.signal }).then((result) => {
      if (result.type === "redirect") {
        window.location.assign(result.location);
        return;
      }
      const { type: _loaded, ...data } = result;
      // The day groups are drawn against this moment, so "Muat lagi" past midnight regroups nothing.
      setPage({ state: "ready", error: "", loadedAt: new Date(), ...data });
      summary.current?.(librarySummary(data));
    }).catch((error) => {
      if (error?.name === "AbortError") return;
      setPage({ state: "error", error: error?.message || "Klip tidak bisa dimuat. Coba lagi sebentar lagi.", ...EMPTY });
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
    setMore({ state: "loading", error: "" });
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
      setMore({ state: "idle", error: "" });
    } catch (error) {
      if (error?.name === "AbortError") return;
      setMore({ state: "error", error: error?.message || "Klip tidak bisa dimuat. Coba lagi sebentar lagi." });
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
    ? (page.matched ? shownSummary({ shown: page.clips.length, matched: page.matched }) : noClips ? "Belum ada klip" : "Tidak ada klip yang cocok")
    : "";

  return (
    <section aria-label="Klip dari semua proyek">
      <div className={styles.tools}>
        <label className={styles.search}>
          <span className="visuallyHidden">Cari klip</span>
          <input type="search" value={input} maxLength={QUERY_LIMIT} onChange={(event) => setInput(event.target.value)}
            placeholder="Cari judul, proyek, atau URL sumber" />
        </label>
        <div className={styles.chips} role="group" aria-label="Saring klip">
          <button type="button" aria-pressed={high} onClick={() => setHigh((value) => !value)}>Skor 8+</button>
          <button type="button" aria-pressed={week} onClick={() => setWeek((value) => !value)}>Minggu ini</button>
        </div>
      </div>

      <p className="visuallyHidden" role="status" aria-live="polite">{status}</p>

      {ready && page.partial && (
        <div className={`notice info ${styles.notice}`}>
          <span>Klip dari sebagian proyek lama belum terbaca.</span>
          <button type="button" className={`btn ${styles.retry}`} onClick={() => setGeneration((value) => value + 1)}>Muat ulang</button>
        </div>
      )}

      {page.state === "loading" && (
        <div className={styles.state} role="status" aria-live="polite"><span className="pulse" aria-hidden="true" /><p>Memuat klip…</p></div>
      )}
      {page.state === "error" && (
        <div className={`notice error ${styles.notice}`} role="alert">
          <strong>Klip tidak bisa dimuat</strong>
          <span>{page.error}</span>
          <button type="button" className={`btn ${styles.retry}`} onClick={() => setGeneration((value) => value + 1)}>Coba lagi</button>
        </div>
      )}
      {ready && page.matched === 0 && noClips && (
        <div className={styles.state}>
          <strong>Belum ada klip</strong>
          <p>Klip dari proyek yang sudah selesai muncul di sini, terbaru di atas.</p>
        </div>
      )}
      {ready && page.matched === 0 && !noClips && (
        <div className={styles.state}>
          <strong>Tidak ada klip yang cocok</strong>
          <p>Ubah kata pencarian atau matikan saringannya.</p>
          {filtered && <button type="button" className="btn" onClick={showAll}>Tampilkan semua klip</button>}
        </div>
      )}

      {page.clips.length > 0 && (
        <>
          <ul className={styles.days} aria-label="Klip" aria-busy={page.state === "refreshing" || undefined}>
            {days.groups.map((group) => (
              <li key={group.key}>
                {days.headings && <h2 id={`riwayat-${group.key}`} className={styles.day}>{group.label}</h2>}
                <ul className={styles.grid} aria-labelledby={days.headings ? `riwayat-${group.key}` : undefined}>
                  {group.items.map((item) => (
                    <ClipCard key={itemKey(item)} item={item} linkRef={(node) => {
                      linkRefs.current.set(itemKey(item), node);
                      return () => linkRefs.current.delete(itemKey(item));
                    }} />
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          <div className={styles.more}>
            <p>{shownSummary({ shown: page.clips.length, matched: page.matched })}</p>
            {page.nextCursor && (
              <button type="button" className="btn" aria-disabled={more.state === "loading" || undefined} onClick={loadMore}>
                {more.state === "loading" ? "Memuat…" : "Muat lagi"}
              </button>
            )}
            {more.state === "error" && <p className={styles.moreError} role="alert">{more.error}</p>}
          </div>
        </>
      )}
    </section>
  );
}
