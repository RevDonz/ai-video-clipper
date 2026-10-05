// Pure rules of the shared controls (ui/*), kept out of the JSX so node tests cover them.

const MENU_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End"]);

/** The menu item to focus after `key` (WAI-ARIA menu: ↓/↑ wrap, Home/End); null when the key is not the menu's. */
export function menuMove(index, key, count) {
  if (!MENU_KEYS.has(key) || !(count > 0)) return null;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  const step = key === "ArrowDown" ? 1 : -1;
  return (((index + step) % count) + count) % count;
}

/** An item with an on/off state (`checked` true or false) is a menuitemcheckbox. */
export function menuItemRole(item) {
  return typeof item?.checked === "boolean" ? "menuitemcheckbox" : "menuitem";
}

/** The ids that tie an accordion's header button to its region (aria-controls, aria-labelledby). */
export function accordionIds(id) {
  return { button: `${id}-button`, region: `${id}-region` };
}
