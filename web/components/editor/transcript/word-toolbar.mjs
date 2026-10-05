// The contextual word toolbar of the transcript (docs/plans/2026-10-02-editor-mode-cepat.md
// §6.2): what it holds for a selection, its keys and where it sits. Pure, over the
// `selectionActions` of actions.mjs, so the toolbar, its menu and the keyboard run the same
// commands (`commandsFor`) and WordToolbar.jsx stays thin.
import { keyAction } from "./actions.mjs";

export const TOOLBAR_LABEL = "Aksi kata terpilih";
export const MENU_LABEL = "Lainnya";
export const TOOLBAR_TAB_HELP = "Tab membuka aksi kata terpilih.";

/** The nine actions on a selection, by their `selectionActions` name. */
export const ACTION_LABELS = Object.freeze({
  remove: "Hapus",
  restore: "Pulihkan",
  edit: "Edit kata",
  hide: "Sembunyikan dari caption",
  emphasis: "Kata kunci",
  trimStart: "Mulai di sini",
  trimEnd: "Akhiri di sini",
  extend: "Perpanjang ke sini",
  coldOpen: "Jadikan cold open",
});

const SHORTCUTS = Object.freeze({
  remove: "Delete", edit: "Enter", hide: "Ctrl+Shift+X", emphasis: "Ctrl+E", trimStart: "I", trimEnd: "O", coldOpen: "Ctrl+Shift+H",
});

// The three actions that take the primary place in turn; the other two go to the menu.
const CUT_ACTIONS = Object.freeze(["remove", "restore", "extend"]);
const MENU_FIRST = Object.freeze(["edit", "hide", "trimStart", "trimEnd"]);
// Keys that act on the selection from the toolbar as they do from the words list.
const TOOLBAR_ACTIONS = new Set(["trimStart", "trimEnd", "hide", "emphasis", "coldOpen"]);

/** The contextual primary action, in §6.2's order of checks. */
export function primaryAction(actions) {
  if (actions.extend?.enabled) return "extend";
  if (actions.restore?.enabled && !actions.remove?.enabled) return "restore";
  return "remove";
}

const entryOf = (actions, name) => {
  const entry = actions[name] ?? { enabled: false, reason: null };
  return { enabled: Boolean(entry.enabled), reason: entry.enabled ? null : entry.reason ?? null };
};

/**
 * The toolbar's buttons in order: the primary action, "Jadikan cold open", "Kata kunci" (the
 * menu button follows them). Each `{ name, label, shortcut, enabled, reason, primary, pressed }`;
 * none without a selection.
 */
export function toolbarButtons(actions) {
  if (!actions?.range) return [];
  const primary = primaryAction(actions);
  return [primary, "coldOpen", "emphasis"].map((name) => ({
    name,
    label: ACTION_LABELS[name],
    shortcut: SHORTCUTS[name] ?? null,
    ...entryOf(actions, name),
    primary: name === primary,
    // As the chip had it: pressed while every selected word is a keyword, unknown in read-only.
    pressed: name === "emphasis" && actions.emphasis.enabled ? !actions.emphasis.on : undefined,
  }));
}

/**
 * The "Lainnya" menu in its fixed order: Edit kata, Sembunyikan dari caption (a checkbox item),
 * Mulai di sini, Akhiri di sini, then the two of Hapus, Pulihkan and Perpanjang ke sini that are
 * not primary. Items in the `ui/MenuButton` shape without `onSelect`: `{ id, label, shortcut,
 * disabled, reason, checked? }`.
 */
export function menuItems(actions) {
  if (!actions?.range) return [];
  const primary = primaryAction(actions);
  const names = [...MENU_FIRST, ...CUT_ACTIONS.filter((name) => name !== primary)];
  return names.map((name) => {
    const { enabled, reason } = entryOf(actions, name);
    const item = { id: name, label: ACTION_LABELS[name], shortcut: SHORTCUTS[name], disabled: !enabled, reason };
    if (name === "hide") item.checked = !actions.hide.on;
    return item;
  });
}

const MOVES = Object.freeze({ ArrowRight: 1, ArrowLeft: -1 });

/**
 * What a key does on a toolbar button (`index` of `count`): `{kind: "focus", index}` for ←/→
 * (wrapping), Home and End; `{kind: "list"}` for Esc and Shift+Tab (back to the words, the
 * selection kept); `{kind: "action", name}` for I, O and the selection's modifier shortcuts;
 * null for the rest (Tab, Enter, Space and the editor's own keys).
 */
export function toolbarKey(event, { index, count }) {
  const mods = event.ctrlKey || event.metaKey || event.altKey;
  if (event.key === "Escape" && !mods && !event.shiftKey) return { kind: "list" };
  if (event.key === "Tab") return event.shiftKey && !mods ? { kind: "list" } : null;
  if (!mods && !event.shiftKey && count > 0) {
    if (event.key in MOVES) return { kind: "focus", index: (((index + MOVES[event.key]) % count) + count) % count };
    if (event.key === "Home") return { kind: "focus", index: 0 };
    if (event.key === "End") return { kind: "focus", index: count - 1 };
  }
  const name = keyAction(event);
  return TOOLBAR_ACTIONS.has(name) ? { kind: "action", name } : null;
}

/** A word's line box: its span's rectangle grown to one line-height, around the same centre. */
export function lineBox(rect, lineHeight) {
  const height = rect.bottom - rect.top;
  if (!(lineHeight > height)) return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
  const centre = (rect.top + rect.bottom) / 2;
  return { top: centre - lineHeight / 2, bottom: centre + lineHeight / 2, left: rect.left, right: rect.right };
}

/**
 * Where the toolbar goes, in the coordinates of `box` (the positioned box around the words):
 * `gap` px above the first selected line with its left edge on the first word, clamped inside
 * the box; below the last selected line when less than `minAbove` px (or the toolbar's own
 * height plus the gap, when it wraps) is free between the visible top and the first line. Either
 * way it never covers the selected lines. `first`, `last`, `box` and `visibleTop` are client
 * coordinates; `size` is the toolbar's.
 */
export function toolbarPosition({ first, last, box, visibleTop, size, gap = 8, minAbove = 56 }) {
  const need = Math.max(minAbove, size.height + gap);
  const above = first.top - visibleTop >= need;
  const top = above ? first.top - gap - size.height - box.top : last.bottom + gap - box.top;
  const left = Math.max(0, Math.min(first.left - box.left, box.width - size.width));
  return { top, left, placement: above ? "above" : "below" };
}

/** The menu opens toward the side of the panel with more room: "start" (rightward) or "end". */
export function menuAlign(button, box) {
  return box.right - button.left >= button.right - box.left ? "start" : "end";
}
