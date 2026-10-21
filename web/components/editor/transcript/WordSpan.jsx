"use client";

// One word of the transcript (plan Appendix C.2). Memoised on the word state object, which the
// transcript model keeps identical while the word does not change, and on `selected`; the active
// (playing) word is marked outside React by `active-word.mjs` (`data-active`).
import { memo } from "react";

import { keywordHint as hintText } from "./actions.mjs";
import styles from "./transcript.module.css";

const CLEANUP_TITLES = Object.freeze({ filler: "Rapikan: kata pengisi", repeat: "Rapikan: pengulangan" });

function titleOf(state, cleanup, keywordHint) {
  const parts = [];
  if (cleanup) parts.push(CLEANUP_TITLES[cleanup] ?? "Rapikan");
  if (state.edited) parts.push(`Asli: ${state.asr}`);
  if (state.removal !== null) parts.push("Dipotong dari video");
  else if (state.zone !== "body") parts.push("Di luar klip");
  if (state.cold) parts.push("Cold open");
  if (state.hidden) parts.push("Disembunyikan dari caption");
  if (state.emphasis) parts.push("Kata kunci");
  if (state.lowConf) parts.push("Mungkin salah dengar");
  if (keywordHint) parts.push(hintText({ mac: keywordHint === "mac", on: state.emphasis }));
  return parts.length ? parts.join(" · ") : undefined;
}

const flag = (on) => (on ? "" : undefined);

// `cleanup`: the Rapikan class proposing this word ("filler" | "repeat") while the review is open.
// `keywordHint` ("ctrl" | "mac") adds the Ctrl/Cmd+click line to the tooltip; null when read-only.
function WordSpan({ state, selected, cleanup = null, keywordHint = null }) {
  return (
    <span
      className={styles.word}
      data-w={state.i}
      data-word-id={state.id}
      data-zone={state.zone}
      data-removed={state.removal ?? undefined}
      data-co-removed={state.coRemoval ?? undefined}
      data-cold={flag(state.cold)}
      data-hidden={flag(state.hidden)}
      data-emphasis={flag(state.emphasis)}
      data-edited={flag(state.edited)}
      data-lowconf={flag(state.lowConf)}
      data-selected={flag(selected)}
      data-cleanup={cleanup ?? undefined}
      title={titleOf(state, cleanup, keywordHint)}
    >
      {state.text}
    </span>
  );
}

export default memo(WordSpan);
