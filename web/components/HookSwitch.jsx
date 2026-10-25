"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "use-intl";

import { HOOK_COPY as COPY, hookSwitchView, switchHook } from "../lib/clip-hook.mjs";
import styles from "./HookSwitch.module.css";

// The switch's words in the UI language (project.hook.*), found by the HOOK_COPY entry that
// lib/clip-hook.mjs answers with; one literal key each. A text it does not know shows as it is.
function useHookWords() {
  const t = useTranslations("project");
  const words = {
    label: t("hook.label"), hint: t("hook.hint"), saving: t("hook.saving"), onExporting: t("hook.onExporting"),
    offExporting: t("hook.offExporting"), onReady: t("hook.onReady"), offReady: t("hook.offReady"),
    conflict: t("hook.conflict"), failed: t("hook.failed"), exportFailed: t("hook.exportFailed"),
  };
  return (text) => {
    const key = Object.keys(COPY).find((name) => COPY[name] === text);
    return key ? words[key] : text;
  };
}

// "Hook di video" in the caption box of the project page's detail panel (CONTRACTS §5.57). The
// switch shows the clip's hook state from the clips listing; a change saves the clip's document
// and exports it, then asks the page to reload the listing (the new revision and its export).
// Keyed by the clip, like ClipText: showing another clip starts from its own state.
export default function HookSwitch({ jobId, entry, editable, onChanged }) {
  const word = useHookWords();
  const view = hookSwitchView(entry, { editable });
  const [pending, setPending] = useState(null);
  // The answer of the last switch, used while the listing still shows the revision it saved from.
  const [saved, setSaved] = useState(null);
  const [status, setStatus] = useState({ text: "", warning: false });
  const mounted = useRef(true);
  const ids = useId();

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  if (!view) return null;
  const stale = saved !== null && saved.from === view.etag;
  const on = pending ? pending.on : stale ? saved.on : view.on;
  const busy = pending !== null;

  const change = async (next) => {
    if (busy || next === on) return;
    setPending({ on: next });
    setStatus({ text: COPY.saving, warning: false });
    const listed = view.etag;
    const result = await switchHook({ jobId, clipId: view.clipId, etag: stale ? saved.etag : listed, on: next });
    if (!mounted.current) return;
    setPending(null);
    if (result.type === "redirect") {
      window.location.assign(result.location);
      return;
    }
    if (result.type === "error") {
      setStatus({ text: result.message, warning: true });
      // A conflict means the listing is behind: reload it so the next try saves from the new revision.
      if (result.code === "revision_conflict") onChanged?.();
      return;
    }
    setSaved({ from: listed, etag: result.etag, on: result.hook.on });
    setStatus({ text: result.message, warning: Boolean(result.warning) });
    onChanged?.();
  };

  return (
    <div className={styles.row}>
      <label className={styles.switch}>
        <input
          type="checkbox"
          role="switch"
          className={styles.input}
          checked={on}
          aria-busy={busy || undefined}
          aria-describedby={`${ids}-hint ${ids}-status`}
          onChange={(event) => change(event.target.checked)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            change(!on);
          }}
        />
        <span className={styles.track} aria-hidden="true" />
        <span className={styles.label}>{word(COPY.label)}</span>
      </label>
      <p id={`${ids}-hint`} className={styles.hint}>{word(COPY.hint)}</p>
      <p id={`${ids}-status`} className={styles.status} data-warning={status.warning || undefined} role="status" aria-live="polite">
        {busy && <span className={`pulse ${styles.pending}`} aria-hidden="true" />}
        {word(status.text)}
      </p>
    </div>
  );
}
