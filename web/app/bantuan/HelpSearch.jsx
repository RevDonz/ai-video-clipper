"use client";

import { useState } from "react";

import { HELP_PATH, findHelpEntry } from "../../lib/help-catalog.mjs";
import styles from "./bantuan.module.css";

const NO_MATCH = "Belum ada entri yang cocok. Coba potongan pesan yang lebih pendek, atau kodenya saja.";

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

export default function HelpSearch({ initialQuery = "", missed = false }) {
  const [query, setQuery] = useState(initialQuery);
  const [result, setResult] = useState(missed ? { text: NO_MATCH } : null);

  function submit(event) {
    event.preventDefault();
    if (!query.trim()) {
      setResult({ text: "Tempel pesan error atau kodenya dulu." });
      return;
    }
    const found = findHelpEntry(query);
    if (!found) {
      setResult({ text: NO_MATCH });
      return;
    }
    const { id, title } = found.entry;
    setResult({ label: found.by === "words" ? "Mungkin cocok:" : "Paling cocok:", id, title });
    openEntry(id);
  }

  return (
    <form className={`panel ${styles.search}`} method="get" action="/bantuan" onSubmit={submit} role="search">
      <label htmlFor="bantuan-q">Pesan error</label>
      <div className={styles.searchRow}>
        <input
          id="bantuan-q"
          name="q"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Tempel pesan error"
          autoComplete="off"
          spellCheck={false}
          aria-describedby="bantuan-q-hasil"
        />
        <button type="submit" className="btn">Cari</button>
      </div>
      <p id="bantuan-q-hasil" className={styles.result} aria-live="polite">
        {result?.id ? (
          <>{result.label} <a href={`#${result.id}`}>{result.title}</a></>
        ) : result?.text ?? "Pesan lengkap atau kodenya saja, misalnya download_bot_check."}
      </p>
    </form>
  );
}
