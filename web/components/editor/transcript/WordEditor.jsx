"use client";

// The inline word editor (plan Appendix C.2): Enter saves, Esc cancels, Tab saves and edits the
// next word (Shift+Tab the previous one), leaving the field saves. `onDone(index, text, how)`
// is called exactly once, with `text` null on cancel.
import { useRef } from "react";

import styles from "./transcript.module.css";

export default function WordEditor({ state, onDone }) {
  const input = useRef(null);
  const closed = useRef(false);
  const finish = (how) => {
    if (closed.current) return;
    closed.current = true;
    onDone(state.i, how === "cancel" ? null : input.current?.value ?? "", how);
  };
  const onKeyDown = (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      finish("save");
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish("cancel");
    } else if (event.key === "Tab") {
      event.preventDefault();
      finish(event.shiftKey ? "prev" : "next");
    }
  };
  return (
    <input
      ref={input}
      data-word-editor=""
      className={styles.editor}
      aria-label="Edit kata"
      defaultValue={state.text}
      size={Math.max(4, [...state.text].length + 2)}
      maxLength={80}
      spellCheck={false}
      autoComplete="off"
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={onKeyDown}
      onMouseDown={(event) => event.stopPropagation()}
      onBlur={() => finish("save")}
    />
  );
}
