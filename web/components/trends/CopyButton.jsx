"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Copies `text` to the clipboard. The clipboard API needs a secure context
 * (https or localhost); when it is missing or refuses, the button says so and
 * the text stays selectable next to it.
 */
export default function CopyButton({ text, label, announce, className = "trSecondary" }) {
  const [state, setState] = useState("");
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    let next = "copied";
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      next = "failed";
    }
    setState(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState(""), 2400);
  }

  return (
    <>
      <button type="button" className={className} onClick={copy} disabled={!text}>
        {state === "copied" ? "Tersalin ✓" : state === "failed" ? "Gagal menyalin — pilih teks manual" : label}
      </button>
      <span className="visuallyHidden" role="status" aria-live="polite">
        {state === "copied" ? `${announce || label}: tersalin ke clipboard` : state === "failed" ? "Gagal menyalin ke clipboard" : ""}
      </span>
    </>
  );
}
