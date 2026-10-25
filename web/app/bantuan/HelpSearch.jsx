"use client";

import { Button, Label } from "@heroui/react";
import { useState } from "react";
import { useTranslations } from "use-intl";

import SearchField from "../../components/ui/SearchField.jsx";
import { HELP_PATH, findHelpEntry } from "../../lib/help-catalog.mjs";
import styles from "./bantuan.module.css";

// Jumps to the entry (the address gets its #code, so :target marks it) and gives it the focus,
// so a screen reader reads the entry that opened.
function openEntry(id) {
  const target = document.getElementById(id);
  if (!target) return;
  if (window.location.hash === `#${id}`) {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
  } else {
    // A ?q= left by the form without JS would describe another search.
    if (window.location.search) window.history.replaceState(null, "", HELP_PATH);
    window.location.hash = id;
  }
  target.focus({ preventScroll: true });
}

// The search box. Without JS it is a plain GET form to /bantuan?q=…, which the page answers by
// sending the browser to the entry; with JS the same search runs here, over the index of every
// locale's text the page hands down, so a message pasted from either UI language is found.
export default function HelpSearch({ initialQuery = "", missed = false, index, titles, labels }) {
  const aria = useTranslations("aria");
  const [query, setQuery] = useState(initialQuery);
  const [result, setResult] = useState(missed ? { text: labels.noMatch } : null);

  function submit(event) {
    event.preventDefault();
    if (!query.trim()) {
      setResult({ text: labels.empty });
      return;
    }
    const found = findHelpEntry(query, index);
    if (!found) {
      setResult({ text: labels.noMatch });
      return;
    }
    const { id } = found.entry;
    setResult({ label: found.by === "words" ? labels.maybe : labels.best, id, title: titles?.[id] ?? id });
    openEntry(id);
  }

  return (
    <form className={`panel ${styles.search}`} method="get" action={HELP_PATH} onSubmit={submit} role="search">
      {/* The submit button sits outside the field: inside it, React Aria would make it the clear button. */}
      <div className={styles.searchRow}>
        <SearchField
          id="bantuan-q"
          name="q"
          value={query}
          onChange={setQuery}
          aria-describedby="bantuan-q-hasil"
          fullWidth
          className={styles.searchField}
        >
          <Label className={styles.searchLabel}>{labels.label}</Label>
          <SearchField.Group className={styles.searchGroup}>
            <SearchField.SearchIcon />
            <SearchField.Input placeholder={labels.placeholder} autoComplete="off" spellCheck={false} />
            <SearchField.ClearButton aria-label={aria("clearSearch")} />
          </SearchField.Group>
        </SearchField>
        <Button type="submit" variant="secondary" className={styles.searchSubmit}>{labels.submit}</Button>
      </div>
      <p id="bantuan-q-hasil" className={styles.result} aria-live="polite">
        {result?.id ? (
          <>{result.label} <a href={`#${result.id}`}>{result.title}</a></>
        ) : result?.text ?? labels.hint}
      </p>
    </form>
  );
}
