"use client";

// The transcript's contextual word toolbar (docs/plans/2026-10-02-editor-mode-cepat.md §6.2). It
// replaces the row of nine chips: while words are selected it floats 8 px above the first
// selected line (below the last one when the space above is short), never over the selection,
// with the contextual primary action, "Jadikan cold open", "Kata kunci" and the "Lainnya" menu
// (word-toolbar.mjs decides what each holds). Every action goes through the panel's `onAction`,
// which runs the same `commandsFor` as the keyboard.
//
// Keys: one tab stop (roving tabIndex); ←/→ move between the controls, Home/End go to the ends;
// Esc and Shift+Tab return to the words with the selection kept; I, O and the selection's
// modifier shortcuts act on the selection from here too. The menu keeps its own keys.
// Position: absolute inside `boxRef` (the box around the words, inside the panel's scroll
// container), recomputed in one animation frame after a selection change, a scroll or a resize.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import MenuButton from "../ui/MenuButton.jsx";
import {
  MENU_LABEL, TOOLBAR_LABEL, lineBox, menuAlign, menuItems, toolbarButtons, toolbarKey, toolbarPosition,
} from "./word-toolbar.mjs";
import styles from "./WordToolbar.module.css";

function scrollParent(element) {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

export default function WordToolbar({ actions, onAction, onLeave, boxRef, headerRef, controlRef, range, model }) {
  const rootRef = useRef(null);
  const buttonRefs = useRef([]);
  const menuRef = useRef(null);
  const frame = useRef(0);
  const [active, setActive] = useState(0);
  const [align, setAlign] = useState("end");
  const id = useId();
  const buttons = toolbarButtons(actions);
  const items = menuItems(actions).map((item) => ({ ...item, onSelect: () => onAction(item.id) }));
  const count = buttons.length + 1;
  const first = range?.[0] ?? -1;
  const last = range?.[1] ?? -1;

  const menuButton = () => menuRef.current?.querySelector('button[aria-haspopup="menu"]') ?? null;
  const control = (index) => (index < buttons.length ? buttonRefs.current[index] : menuButton());

  const focusAt = (index) => {
    setActive(index);
    control(index)?.focus();
  };

  // The panel moves focus in from the words list with Tab.
  useLayoutEffect(() => {
    if (!controlRef) return undefined;
    controlRef.current = {
      // A Tab right after a click comes before the next frame: place the toolbar now. False when
      // it cannot show (no selected word on screen), so Tab moves on as usual.
      focusFirst() {
        if (frame.current) {
          cancelAnimationFrame(frame.current);
          place();
        }
        if (rootRef.current?.dataset.placement === "none") return false;
        focusAt(0);
        return rootRef.current?.contains(document.activeElement) ?? false;
      },
    };
    return () => { controlRef.current = null; };
  });

  // A new selection starts the roving stop again on the first control.
  useEffect(() => {
    setActive(0);
  }, [first, last]);

  // The menu button is ui/MenuButton's own; its tab stop follows the roving index.
  useLayoutEffect(() => {
    const button = menuButton();
    if (button) button.tabIndex = active === count - 1 ? 0 : -1;
  });

  const place = useCallback(() => {
    frame.current = 0;
    const root = rootRef.current;
    const box = boxRef.current;
    if (!root || !box) return;
    const selected = box.querySelectorAll("[data-selected]");
    if (!selected.length) {
      root.dataset.placement = "none";
      return;
    }
    const firstEl = selected[0];
    const lastEl = selected[selected.length - 1];
    const lineHeight = Number.parseFloat(getComputedStyle(firstEl).lineHeight) || 0;
    const firstRects = firstEl.getClientRects();
    const lastRects = lastEl.getClientRects();
    const firstLine = lineBox(firstRects[0] ?? firstEl.getBoundingClientRect(), lineHeight);
    const lastLine = lineBox(lastRects[lastRects.length - 1] ?? lastEl.getBoundingClientRect(), lineHeight);
    // Measured at the left edge, so its width is its own and not what is left of the panel.
    root.style.left = "0px";
    const size = { width: root.offsetWidth, height: root.offsetHeight };
    const boxRect = box.getBoundingClientRect();
    const scroller = scrollParent(box);
    const header = headerRef?.current ?? null;
    const visibleTop = Math.max(scroller ? scroller.getBoundingClientRect().top : 0, header ? header.getBoundingClientRect().bottom : 0);
    const at = toolbarPosition({ first: firstLine, last: lastLine, box: boxRect, visibleTop, size });
    root.style.top = `${at.top}px`;
    root.style.left = `${at.left}px`;
    root.dataset.placement = at.placement;
    const button = menuButton();
    if (button) {
      const next = menuAlign(button.getBoundingClientRect(), boxRect);
      setAlign((current) => (current === next ? current : next));
    }
  }, [boxRef, headerRef]);

  const schedule = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(place);
  }, [place]);

  useLayoutEffect(() => {
    schedule();
  }, [first, last, model, schedule]);

  useEffect(() => {
    const box = boxRef.current;
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    window.addEventListener("mouseup", schedule, true);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    if (box) observer?.observe(box);
    return () => {
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("mouseup", schedule, true);
      observer?.disconnect();
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, [boxRef, schedule]);

  const onKeyDown = (event) => {
    if (event.defaultPrevented || event.target.closest?.('[role="menu"]')) return;
    const index = Math.max(0, [...Array(count).keys()].findIndex((i) => control(i) === event.target));
    const result = toolbarKey(event, { index, count });
    if (!result) return;
    event.preventDefault();
    event.stopPropagation();
    if (result.kind === "focus") focusAt(result.index);
    else if (result.kind === "list") onLeave();
    else onAction(result.name);
  };

  return (
    <div ref={rootRef} role="toolbar" aria-label={TOOLBAR_LABEL} aria-orientation="horizontal" className={styles.toolbar}
      data-word-toolbar="" data-placement="none" onKeyDown={onKeyDown}>
      {buttons.map((button, index) => (
        <button
          key={button.name}
          ref={(element) => { buttonRefs.current[index] = element; }}
          type="button"
          className={styles.button}
          data-primary={button.primary ? "" : undefined}
          data-action={button.name}
          tabIndex={active === index ? 0 : -1}
          aria-disabled={button.enabled ? undefined : "true"}
          aria-pressed={button.pressed}
          aria-describedby={button.reason ? `${id}-${button.name}` : undefined}
          title={[button.shortcut, button.reason].filter(Boolean).join(" · ") || undefined}
          onFocus={() => setActive(index)}
          onClick={() => onAction(button.name)}
        >
          {button.label}
        </button>
      ))}
      {buttons.filter((button) => button.reason).map((button) => (
        <span key={button.name} id={`${id}-${button.name}`} className={styles.srOnly}>{button.reason}</span>
      ))}
      <span ref={menuRef} className={styles.menu} onFocus={() => setActive(count - 1)}>
        <MenuButton label={MENU_LABEL} items={items} align={align} />
      </span>
    </div>
  );
}
