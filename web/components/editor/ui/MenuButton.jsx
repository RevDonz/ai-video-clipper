"use client";

// A menu button (spec §8.2, WAI-ARIA menu button pattern): Enter, Space or ↓ opens the menu on its
// first item, ↑ on its last; ↑/↓ wrap, Home/End go to the ends, Enter runs, Esc closes back to the
// button, Tab closes and moves on. Unavailable items stay in place with aria-disabled and their
// reason as the description. The menu prevents the default of its keys, so the editor's global
// shortcuts leave them alone.
import { useCallback, useEffect, useId, useRef, useState } from "react";

import Icon from "./icons.jsx";
import { menuItemRole, menuMove } from "./kit-model.mjs";
import styles from "./ui.module.css";

export default function MenuButton({ label, icon = null, items, align = "end", disabled = false }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef(null);
  const buttonRef = useRef(null);
  const itemRefs = useRef([]);
  const menuId = useId();

  const close = useCallback((returnFocus = true) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }, []);

  const openAt = (index) => {
    setActive(index);
    setOpen(true);
  };

  useEffect(() => {
    if (open) itemRefs.current[active]?.focus();
  }, [open, active]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer, true);
    return () => window.removeEventListener("pointerdown", onPointer, true);
  }, [open]);

  const onButtonKey = (event) => {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openAt(0);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      openAt(items.length - 1);
    }
  };

  const run = (item) => {
    if (item.disabled) return;
    close();
    item.onSelect?.();
  };

  const onMenuKey = (event) => {
    const next = menuMove(active, event.key, items.length);
    if (next !== null) {
      event.preventDefault();
      setActive(next);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") {
      close(false);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      run(items[active]);
    }
  };

  return (
    <div ref={rootRef} className={styles.menuRoot}>
      <button ref={buttonRef} type="button" className={styles.menuButton} data-icon={icon ? "" : undefined}
        aria-label={icon ? label : undefined} title={icon ? label : undefined} aria-haspopup="menu" aria-expanded={open}
        aria-controls={open ? menuId : undefined} disabled={disabled}
        onClick={() => (open ? close(false) : openAt(0))} onKeyDown={onButtonKey}>
        {icon ? <Icon name={icon} /> : label}
      </button>
      {open && (
        <ul id={menuId} role="menu" aria-label={label} className={styles.menu} data-align={align} onKeyDown={onMenuKey}>
          {items.map((item, index) => {
            const role = menuItemRole(item);
            const reasonId = item.disabled && item.reason ? `${menuId}-${item.id}-reason` : undefined;
            return (
              <li key={item.id} role="none">
                <button ref={(element) => { itemRefs.current[index] = element; }} type="button" role={role} tabIndex={-1}
                  className={styles.menuItem} aria-checked={role === "menuitemcheckbox" ? item.checked : undefined}
                  aria-disabled={item.disabled ? "true" : undefined} aria-describedby={reasonId}
                  onClick={() => run(item)} onFocus={() => setActive(index)}>
                  <span className={styles.menuText}>
                    <span className={styles.menuLabel}>{item.label}</span>
                    {reasonId ? <span id={reasonId} className={styles.menuReason}>{item.reason}</span> : null}
                  </span>
                  {item.shortcut ? <span className={styles.menuShortcut}>{item.shortcut}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
